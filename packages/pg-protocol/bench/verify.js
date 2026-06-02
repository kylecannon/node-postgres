#!/usr/bin/env node
'use strict'
// Trustworthy A/B: the methodology that keeps our benchmark numbers honest.
//
// Why this exists: a phase-separated A/B (run all-optimized, then all-base) is
// distorted by laptop thermal drift — when the base phase runs hotter it inflates
// the delta. That silently overstated several BENCHMARKS.md numbers. This harness
// removes that failure mode and refuses to let a within-noise result look like a
// win:
//   1. builds the optimized (working tree) and base (merge-base with master)
//      artifacts ONCE, then
//   2. ALTERNATES samples (opt, base, opt, base, …) so thermal drift hits both
//      equally and cancels in the delta, and
//   3. reports a CONFIDENCE verdict per metric — a delta is only "reliable" when
//      every round agrees in sign and the round-to-round spread is small relative
//      to the delta. Otherwise it's flagged INCONCLUSIVE (within noise).
//
// Usage: node bench/verify.js [rounds] [suite]
//   rounds: alternating rounds (default 4)
//   suite : replay | write | pool | all  (default all)
// Add --guard to exit non-zero on a *confident* regression (for CI).
const { execFileSync, spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const BENCH = __dirname
const PROTO = path.join(BENCH, '..')
const PG = path.join(BENCH, '../../pg')
const ROOT = path.join(BENCH, '../../..')
const OPT = '/tmp/pgbench-opt'
const BASE = '/tmp/pgbench-base'

const ROUNDS = parseInt(process.argv[2] || '4', 10)
const SUITE = process.argv.find((a) => /^(replay|write|pool|all)$/.test(a)) || 'all'
const GUARD = process.argv.includes('--guard')

const env = { ...process.env }
if (!env.PGHOST)
  Object.assign(env, { PGHOST: '127.0.0.1', PGPORT: '54399', PGUSER: 'user', PGDATABASE: 'data', PGTESTNOSSL: 'true' })

const git = (...a) => execFileSync('git', a, { cwd: ROOT, encoding: 'utf8' }).trim()
const tsc = () => {
  fs.rmSync(path.join(PROTO, 'tsconfig.tsbuildinfo'), { force: true })
  fs.rmSync(path.join(PROTO, 'dist'), { recursive: true, force: true })
  if (spawnSync('npx', ['tsc'], { cwd: PROTO, env, stdio: 'ignore' }).status !== 0) throw new Error('tsc failed')
}
const snapshot = (dir) => {
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  fs.cpSync(path.join(PROTO, 'dist'), path.join(dir, 'dist'), { recursive: true })
  fs.cpSync(path.join(PG, 'lib'), path.join(dir, 'lib'), { recursive: true })
}
const apply = (dir) => {
  fs.rmSync(path.join(PROTO, 'dist'), { recursive: true, force: true })
  fs.rmSync(path.join(PG, 'lib'), { recursive: true, force: true })
  fs.cpSync(path.join(dir, 'dist'), path.join(PROTO, 'dist'), { recursive: true })
  fs.cpSync(path.join(dir, 'lib'), path.join(PG, 'lib'), { recursive: true })
}

// --- benches: each returns { metricName: number } from a subprocess run ---
const node = (args, cwd) => spawnSync(process.execPath, args, { cwd, env, encoding: 'utf8' }).stdout || ''
const benches = {
  replay: () => {
    const out = node([path.join(BENCH, 'replay-bench.js'), 'all', 'both'], PROTO)
    const m = {}
    for (const l of out.split('\n')) {
      const x = l.match(/^(\S+)\s+([\d.]+) Mrows/)
      if (x) m['tp:' + x[1]] = parseFloat(x[2])
    }
    return m
  },
  write: () => {
    const out = node([path.join(BENCH, 'write-bench.js')], PROTO)
    const m = {}
    for (const l of out.split('\n')) {
      const x = l.match(/^(bind\([^)]*\)|full insert seq)\s+([\d.]+) Mops/)
      if (x) m['wr:' + x[1]] = parseFloat(x[2])
    }
    return m
  },
  pool: () => {
    const out = node([path.join(PG, 'bench-pool.js'), '100', '40', '10', '4'], PG)
    const x = out.match(/qps (\d+)/)
    return x ? { 'pool:qps@100rows': parseInt(x[1], 10) } : {}
  },
}
const suites = SUITE === 'all' ? ['replay', 'write', 'pool'] : [SUITE]

const median = (a) => {
  const s = a.slice().sort((x, y) => x - y)
  const m = s.length >> 1
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
// higher-is-better for all current metrics
function verdict(optVals, baseVals) {
  const deltas = optVals.map((o, i) => (o - baseVals[i]) / baseVals[i])
  const med = median(deltas)
  const allSameSign = deltas.every((d) => d > 0) || deltas.every((d) => d < 0)
  const spread = Math.max(...deltas) - Math.min(...deltas)
  // reliable: every round agrees in direction and the delta clears the spread
  const reliable = allSameSign && Math.abs(med) > spread
  const label = !reliable ? 'INCONCLUSIVE' : med >= 0 ? 'reliable ↑' : 'REGRESSION ↓'
  return { med, spread, reliable, label }
}

async function main() {
  const baseSha = git('merge-base', 'HEAD', 'master')
  console.error(
    `verify: optimized(HEAD) vs base(${baseSha.slice(0, 8)}) — ${ROUNDS} alternating rounds, suite=${SUITE}`
  )

  // --- setup: build & snapshot opt and base ---
  console.error('• building optimized snapshot…')
  tsc()
  snapshot(OPT)
  console.error('• building base snapshot…')
  let restored = false
  const restore = () => {
    if (restored) return
    restored = true
    // restores every reverted/deleted tracked file (incl. branch-added tests)
    git('checkout', 'HEAD', '--', 'packages/pg-protocol/src', 'packages/pg/lib')
    tsc()
    apply(OPT)
  }
  process.on('exit', restore)
  try {
    git('checkout', baseSha, '--', 'packages/pg-protocol/src', 'packages/pg/lib')
    // delete test files so tsc doesn't compile branch-added tests (which use
    // APIs base lacks) against the reverted source; restore() brings them back
    const srcDir = path.join(PROTO, 'src')
    for (const f of fs.readdirSync(srcDir)) if (f.endsWith('.test.ts')) fs.rmSync(path.join(srcDir, f))
    tsc()
    snapshot(BASE)
  } finally {
    restore()
  }

  // --- alternating measurement ---
  const optRuns = {}
  const baseRuns = {}
  const record = (store, m) => {
    for (const k in m) (store[k] ??= []).push(m[k])
  }
  for (let r = 0; r < ROUNDS; r++) {
    console.error(`• round ${r + 1}/${ROUNDS}…`)
    for (const s of suites) {
      apply(OPT)
      record(optRuns, benches[s]())
      apply(BASE)
      record(baseRuns, benches[s]())
    }
  }
  apply(OPT) // leave optimized in place

  // --- report ---
  const keys = Object.keys(optRuns).filter((k) => baseRuns[k] && baseRuns[k].length === optRuns[k].length)
  let regressions = 0
  console.log(
    '\nmetric'.padEnd(26) + 'base'.padStart(10) + 'opt'.padStart(10) + 'Δ median'.padStart(11) + '  confidence'
  )
  for (const k of keys) {
    const v = verdict(optRuns[k], baseRuns[k])
    if (v.label.startsWith('REGRESSION')) regressions++
    const b = median(baseRuns[k])
    const o = median(optRuns[k])
    const pct = (v.med >= 0 ? '+' : '') + (v.med * 100).toFixed(1) + '%'
    console.log(
      k.padEnd(26) +
        b.toFixed(3).padStart(10) +
        o.toFixed(3).padStart(10) +
        pct.padStart(11) +
        `  ${v.label} (spread ${(v.spread * 100).toFixed(1)}pp)`
    )
  }
  console.log(
    `\n${keys.length} metrics over ${ROUNDS} alternating rounds. ` +
      `INCONCLUSIVE = within noise (don't quote it). REGRESSION = confident slowdown.`
  )
  if (GUARD && regressions) {
    console.error(`\n${regressions} confident regression(s) — failing.`)
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
