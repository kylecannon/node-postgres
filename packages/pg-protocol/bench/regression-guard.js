'use strict'
// Regression tripwire for CI / local use. Runs the replay (throughput) and GC
// benchmarks, then compares against a committed baseline.json. Exits non-zero if
// any fixture regresses beyond the threshold.
//
//   node bench/regression-guard.js            # check against baseline.json
//   node bench/regression-guard.js --update   # (re)generate baseline.json
//
// Thresholds (env): REGRESSION_PCT (throughput drop %, default 8),
//                   GC_REGRESSION_PCT (GC/row increase %, default 20).
// NOTE: baselines are machine-specific — regenerate with --update on the host
// where you run the guard. For PR gating, run --update on the base commit first.

const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const BASELINE = path.join(__dirname, 'baseline.json')
const THROUGHPUT_PCT = parseFloat(process.env.REGRESSION_PCT || '8')
const GC_PCT = parseFloat(process.env.GC_REGRESSION_PCT || '20')

function run(script, args) {
  return execFileSync('node', [path.join(__dirname, script), ...args], {
    cwd: path.join(__dirname, '..'),
    encoding: 'utf8',
    env: { ...process.env, BENCH_TARGET_ROWS: process.env.BENCH_TARGET_ROWS || '3000000' },
  })
}

function gather() {
  const metrics = {}
  // throughput: "name/mode  X.XXX Mrows/s ..."
  const tp = run('replay-bench.js', ['all', 'both'])
  for (const line of tp.split('\n')) {
    const m = line.match(/^(\S+)\s+([\d.]+) Mrows\/s/)
    if (m) metrics[`tp:${m[1]}`] = parseFloat(m[2])
  }
  // GC: "name/mode: ... | X.X ns GC/row | ..." run with --expose-gc
  for (const mode of ['array', 'object']) {
    const gc = execFileSync('node', ['--expose-gc', path.join(__dirname, 'gc-bench.js'), 'all', mode], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: { ...process.env, BENCH_TARGET_ROWS: '3000000' },
    })
    for (const line of gc.split('\n')) {
      const m = line.match(/^(\S+):.*?([\d.]+) ns GC\/row/)
      if (m) metrics[`gc:${m[1]}`] = parseFloat(m[2])
    }
  }
  return metrics
}

const metrics = gather()

if (process.argv.includes('--update')) {
  fs.writeFileSync(BASELINE, JSON.stringify(metrics, null, 2) + '\n')
  console.log(`wrote baseline.json with ${Object.keys(metrics).length} metrics`)
  process.exit(0)
}

if (!fs.existsSync(BASELINE)) {
  console.error('No baseline.json — run `node bench/regression-guard.js --update` first.')
  process.exit(2)
}

const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8'))
const regressions = []
const report = []
for (const [key, base] of Object.entries(baseline)) {
  const cur = metrics[key]
  if (cur == null) continue
  const isGc = key.startsWith('gc:')
  // throughput: regression = current lower; GC/row: regression = current higher
  const deltaPct = isGc ? ((cur - base) / base) * 100 : ((cur - base) / base) * 100
  const bad = isGc ? deltaPct > GC_PCT : deltaPct < -THROUGHPUT_PCT
  report.push(`${bad ? 'FAIL' : 'ok  '} ${key.padEnd(28)} ${base.toFixed(3)} -> ${cur.toFixed(3)} (${deltaPct >= 0 ? '+' : ''}${deltaPct.toFixed(1)}%)`)
  if (bad) regressions.push(key)
}
console.log(report.join('\n'))
if (regressions.length) {
  console.error(`\n${regressions.length} regression(s) beyond threshold (tp ${THROUGHPUT_PCT}% / gc ${GC_PCT}%)`)
  process.exit(1)
}
console.log(`\nAll ${report.length} metrics within thresholds.`)
