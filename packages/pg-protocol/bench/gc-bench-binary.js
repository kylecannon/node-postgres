'use strict'
// Binary-vs-text GC-pressure benchmark. Replays captured wire bytes (both
// formats of the SAME logical rows) through Parser + Result and reports GC
// behavior — scavenge/major counts, total GC pause, %-of-wall, and ns-GC/row —
// rather than throughput. This isolates the allocation side of binary vs text:
//   * binary int/float/timestamp avoid the intermediate decoded String, but
//   * binary bytea allocates a copied Buffer per field (text bytea -> String).
// Run with --expose-gc.
//
// Run capture first: node bench/capture-binary-fixtures.js
// node --expose-gc bench/gc-bench-binary.js [int_heavy|...|all] [array|object]

const fs = require('fs')
const path = require('path')
const { PerformanceObserver, constants } = require('perf_hooks')
const { Parser } = require('../dist/parser')
const Result = require('../../pg/lib/result')

const fxPath = path.join(__dirname, 'binary-fixtures.json')
if (!fs.existsSync(fxPath)) {
  console.error('binary-fixtures.json not found. Run: node bench/capture-binary-fixtures.js')
  process.exit(1)
}
const fixtures = JSON.parse(fs.readFileSync(fxPath, 'utf8'))

function makeConsumer(rowMode) {
  let result = null
  let sink = 0
  const cb = (msg) => {
    if (msg.name === 'rowDescription') {
      result = new Result(rowMode, null)
      result.addFields(msg.fields)
    } else if (msg.name === 'dataRow') {
      const row = result.parseRow(msg.fields)
      sink += row.length !== undefined ? row.length : 1
    }
  }
  return { cb, sink: () => sink }
}

function countRows(buf) {
  let off = 0
  let rows = 0
  while (off + 5 <= buf.length) {
    if (buf[off] === 0x44) rows++
    off += 1 + buf.readUInt32BE(off + 1)
  }
  return rows
}

const which = process.argv[2] || 'all'
const mode = process.argv[3] || 'object'
const keys = which === 'all' ? Object.keys(fixtures) : [which]

// scale passes so every fixture processes ~the same total number of rows
const TARGET_ROWS = parseInt(process.env.BENCH_TARGET_ROWS || '10000000', 10)

function measure(buf, mode) {
  const rowsPerPass = countRows(buf)
  const PASSES = Math.max(1, Math.round(TARGET_ROWS / rowsPerPass))

  let gcCount = 0
  let gcPause = 0
  let scavenge = 0
  let majorGc = 0
  const obs = new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      gcCount++
      gcPause += e.duration
      if (e.detail && e.detail.kind === constants.NODE_PERFORMANCE_GC_MAJOR) majorGc++
      else scavenge++
    }
  })
  obs.observe({ entryTypes: ['gc'] })

  const parser = new Parser()
  parser.reuseObjects = process.env.BENCH_REUSE !== '0'
  const consumer = makeConsumer(mode)

  for (let i = 0; i < 50; i++) parser.parse(buf, consumer.cb) // warmup/JIT

  global.gc()
  const memBefore = process.memoryUsage()
  const t0 = performance.now()
  for (let i = 0; i < PASSES; i++) parser.parse(buf, consumer.cb)
  const wall = performance.now() - t0
  const memAfter = process.memoryUsage()

  return new Promise((resolve) => {
    // GC entries arrive async; let the loop drain before reading totals.
    setTimeout(() => {
      obs.disconnect()
      const totalRows = PASSES * rowsPerPass
      resolve({
        totalRows,
        wall,
        gcCount,
        scavenge,
        majorGc,
        gcPause,
        gcPctWall: (gcPause / wall) * 100,
        nsGcPerRow: (gcPause / totalRows) * 1e6,
        rssDeltaMB: (memAfter.rss - memBefore.rss) / 1e6,
      })
    }, 50)
  })
}

async function main() {
  console.log(`# binary-vs-text GC  (mode: ${mode}, ~${(TARGET_ROWS / 1e6).toFixed(0)}M rows/fixture)\n`)
  for (const key of keys) {
    const entry = fixtures[key]
    const res = {}
    for (const fmt of ['text', 'binary']) {
      const buf = Buffer.from(entry[fmt], 'base64')
      res[fmt] = await measure(buf, mode)
    }
    const t = res.text
    const b = res.binary
    for (const [fmt, m] of [
      ['text', t],
      ['binary', b],
    ]) {
      console.log(
        `${(key + '/' + fmt).padEnd(22)}` +
          `${m.totalRows} rows in ${m.wall.toFixed(0)}ms | ` +
          `GC ${m.gcCount} (scav ${m.scavenge}, major ${m.majorGc}), ` +
          `pause ${m.gcPause.toFixed(1)}ms (${m.gcPctWall.toFixed(1)}% wall) | ` +
          `${m.nsGcPerRow.toFixed(1)} ns GC/row | rss+${m.rssDeltaMB.toFixed(0)}MB`
      )
    }
    const gcRatio = b.nsGcPerRow / (t.nsGcPerRow || 1e-9)
    console.log(
      `${'  -> binary GC/row'.padEnd(22)}${
        gcRatio <= 1 ? (1 / gcRatio).toFixed(2) + 'x LESS' : gcRatio.toFixed(2) + 'x MORE'
      } GC than text\n`
    )
  }
}

main()
