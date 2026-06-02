'use strict'
// Big-payload benchmark (~400MB result). Shows what happens when a non-cursor
// client.query pulls a very large result: memory blowup vs bounded memory, and
// event-loop responsiveness with/without cooperative yielding.
//
// Usage: node --expose-gc --max-old-space-size=4096 bench-400mb.js [rows] [bytesPerRow]
const pg = require('./lib')
const Cursor = require('../pg-cursor')
const { PerformanceObserver } = require('perf_hooks')

const ROWS = parseInt(process.argv[2] || '100000', 10)
const BYTES = parseInt(process.argv[3] || '4000', 10)
const totalMB = (ROWS * BYTES) / 1e6
// repeat(md5(...), N) builds a BYTES-long text payload per row
const SQL = `SELECT g AS id, repeat(md5(g::text), ${Math.ceil(BYTES / 32)}) AS payload FROM generate_series(1, ${ROWS}) g`

function instrument() {
  let maxLag = 0
  let last = process.hrtime.bigint()
  const rss0 = process.memoryUsage().rss
  let peakRss = rss0
  const timer = setInterval(() => {
    const now = process.hrtime.bigint()
    const lag = Number(now - last) / 1e6 - 2
    if (lag > maxLag) maxLag = lag
    last = now
    const rss = process.memoryUsage().rss
    if (rss > peakRss) peakRss = rss
  }, 2)
  let gcPause = 0
  const obs = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) gcPause += e.duration
  })
  obs.observe({ entryTypes: ['gc'] })
  const t0 = performance.now()
  return {
    async stop(bytesSeen) {
      const wall = performance.now() - t0
      await new Promise((r) => setTimeout(r, 60))
      clearInterval(timer)
      obs.disconnect()
      return { wall, maxLag, peakMB: (peakRss - rss0) / 1e6, gcPause, mbps: bytesSeen / 1e6 / (wall / 1000) }
    },
  }
}

async function accumulate(yieldBytes) {
  const c = new pg.Client({ maxResultChunkBytes: yieldBytes })
  await c.connect()
  const inst = instrument()
  const r = await c.query({ text: SQL, rowMode: 'array' })
  let bytes = 0
  for (const row of r.rows) bytes += row[1].length
  const m = await inst.stop(bytes)
  await c.end()
  return m
}

async function stream() {
  const c = new pg.Client()
  await c.connect()
  const inst = instrument()
  let bytes = 0
  const q = c.query(new pg.Query({ text: SQL, rowMode: 'array' }))
  q.on('row', (row) => (bytes += row[1].length))
  await new Promise((res, rej) => {
    q.on('end', res)
    q.on('error', rej)
  })
  const m = await inst.stop(bytes)
  await c.end()
  return m
}

async function cursor() {
  const c = new pg.Client()
  await c.connect()
  const inst = instrument()
  let bytes = 0
  const cur = c.query(new Cursor(SQL, undefined, { rowMode: 'array' }))
  await new Promise((res, rej) => {
    const pump = () =>
      cur.read(500, (err, rows) => {
        if (err) return rej(err)
        for (const row of rows) bytes += row[1].length
        if (rows.length === 0) return res()
        setImmediate(pump)
      })
    pump()
  })
  const m = await inst.stop(bytes)
  await c.end()
  return m
}

// RSS never shrinks within a process, so to get an honest peak-memory number
// per strategy each one runs in its own fresh process. argv[4] selects it.
const runs = {
  'accumulate (yield off)': () => accumulate(0),
  'accumulate (yield 512KB)': () => accumulate(512 * 1024),
  'stream (.on(row))': stream,
  'cursor (batch 500)': cursor,
}

async function main() {
  const only = process.argv[4]
  if (only && runs[only]) {
    const m = await runs[only]()
    console.log(
      only.padEnd(28) +
        m.mbps.toFixed(0).padStart(8) +
        m.wall.toFixed(0).padStart(10) +
        m.maxLag.toFixed(1).padStart(11) +
        m.peakMB.toFixed(0).padStart(12) +
        m.gcPause.toFixed(0).padStart(8)
    )
    return
  }
  // driver: spawn one fresh process per strategy
  const { execFileSync } = require('child_process')
  console.log(`~${totalMB.toFixed(0)}MB result (${ROWS} rows x ${BYTES}B), fresh process per strategy\n`)
  console.log('strategy'.padEnd(28) + 'MB/s'.padStart(8) + 'wall ms'.padStart(10) + 'maxLag ms'.padStart(11) + 'peakRSS MB'.padStart(12) + 'GC ms'.padStart(8))
  for (const name of Object.keys(runs)) {
    const out = execFileSync(
      'node',
      ['--expose-gc', '--max-old-space-size=4096', __filename, String(ROWS), String(BYTES), name],
      { encoding: 'utf8', env: process.env }
    )
    process.stdout.write(out)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
