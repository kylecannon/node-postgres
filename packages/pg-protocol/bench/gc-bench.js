'use strict'
// GC-pressure benchmark: replays captured wire bytes through Parser + Result and
// reports allocation/GC behavior (scavenge & mark-sweep counts, total GC pause,
// bytes allocated per row) rather than throughput. Run with --expose-gc.
//
// node --expose-gc bench/gc-bench.js [pg_type|seq|mixed|all] [array|object]

const fs = require('fs')
const path = require('path')
const v8 = require('v8')
const { PerformanceObserver, constants } = require('perf_hooks')
const { Parser } = require('../dist/parser')
const Result = require('../../pg/lib/result')

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'))

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
const TARGET_ROWS = parseInt(process.env.BENCH_TARGET_ROWS || '20000000', 10)

async function main() {
for (const key of keys) {
  const buf = Buffer.from(fixtures[key], 'base64')
  const rowsPerPass = countRows(buf)
  const PASSES = Math.max(1, Math.round(TARGET_ROWS / rowsPerPass))

  // GC observer
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
  // reuse DataRow message/fields across rows (pg's default for queries without a
  // 'message' listener); set BENCH_REUSE=0 to measure the pre-reuse behavior.
  parser.reuseObjects = process.env.BENCH_REUSE !== '0'
  const consumer = makeConsumer(mode)

  // warmup (JIT) without counting
  for (let i = 0; i < 100; i++) parser.parse(buf, consumer.cb)

  global.gc()
  const heapBefore = v8.getHeapStatistics().total_heap_size
  const memBefore = process.memoryUsage()
  const t0 = performance.now()
  for (let i = 0; i < PASSES; i++) parser.parse(buf, consumer.cb)
  const wall = performance.now() - t0
  const memAfter = process.memoryUsage()

  // GC entries are delivered to the observer callback asynchronously; let the
  // event loop drain so all entries are counted before we read the totals.
  await new Promise((r) => setTimeout(r, 50))
  obs.disconnect()

  const totalRows = PASSES * rowsPerPass
  console.log(
    `${key}/${mode}: ${totalRows} rows in ${wall.toFixed(0)}ms | ` +
      `GC: ${gcCount} (scav ${scavenge}, major ${majorGc}), pause ${gcPause.toFixed(1)}ms ` +
      `(${((gcPause / wall) * 100).toFixed(1)}% of wall) | ` +
      `${(gcPause / totalRows * 1e6).toFixed(1)} ns GC/row | rss+${((memAfter.rss - memBefore.rss) / 1e6).toFixed(0)}MB`
  )
}

}
main()
