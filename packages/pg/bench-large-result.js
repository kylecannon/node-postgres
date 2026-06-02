'use strict'
// "Hundreds of thousands of rows" benchmark. Compares the strategies for large
// result sets across the three axes that matter at scale:
//   - throughput (rows/sec)
//   - peak memory (RSS delta) — does materializing the whole set blow up heap?
//   - event-loop responsiveness (max lag) — does parsing block the loop?
//
// Strategies:
//   accumulate/array   client.query({rowMode:'array'})         -> all rows in memory
//   accumulate/object  client.query()                          -> all rows in memory (default)
//   stream/array       Query + 'row' listener, no accumulation -> low memory
//   cursor/array       pg-cursor, batched                      -> bounded memory + non-blocking
//
// Usage: node [--expose-gc] bench-large-result.js [rowCount] [batchSize]
const pg = require('./lib')
const Cursor = require('../pg-cursor')
const { PerformanceObserver } = require('perf_hooks')

const N = parseInt(process.argv[2] || '200000', 10)
const BATCH = parseInt(process.argv[3] || '1000', 10)

// realistic-ish ~6-column row (not just a bare int)
const SQL = `SELECT g AS id, (g % 50000) + 1 AS user_id,
  (ARRAY['click','view','signup','purchase','logout'])[1 + g % 5] AS event_type,
  (g * 1.5)::float8 AS value, (g % 2 = 0) AS flag,
  'session_' || (g % 10000) AS session
  FROM generate_series(1, ${N}) g`

function instrument() {
  let maxLag = 0
  let last = process.hrtime.bigint()
  let peakRss = process.memoryUsage().rss
  const timer = setInterval(() => {
    const now = process.hrtime.bigint()
    const lag = Number(now - last) / 1e6 - 2
    if (lag > maxLag) maxLag = lag
    last = now
    const rss = process.memoryUsage().rss
    if (rss > peakRss) peakRss = rss
  }, 2)
  let gcPause = 0
  let gcCount = 0
  const obs = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      gcCount++
      gcPause += e.duration
    }
  })
  obs.observe({ entryTypes: ['gc'] })
  const rss0 = process.memoryUsage().rss
  const t0 = performance.now()
  return {
    async stop() {
      const wall = performance.now() - t0
      await new Promise((r) => setTimeout(r, 60)) // flush GC observer
      clearInterval(timer)
      obs.disconnect()
      return {
        wall,
        maxLag,
        peakRssMB: (peakRss - rss0) / 1e6,
        gcPause,
        gcCount,
      }
    },
  }
}

const strategies = {
  'accumulate/array': async (client) => {
    const r = await client.query({ text: SQL, rowMode: 'array' })
    return r.rows.length
  },
  'accumulate/object': async (client) => {
    const r = await client.query({ text: SQL })
    return r.rows.length
  },
  'stream/array': async (client) => {
    let n = 0
    const q = client.query(new pg.Query({ text: SQL, rowMode: 'array' }))
    q.on('row', () => n++)
    await new Promise((resolve, reject) => {
      q.on('end', resolve)
      q.on('error', reject)
    })
    return n
  },
  'cursor/array': async (client) => {
    const cursor = client.query(new Cursor(SQL, undefined, { rowMode: 'array' }))
    let n = 0
    await new Promise((resolve, reject) => {
      const pump = () =>
        cursor.read(BATCH, (err, rows) => {
          if (err) return reject(err)
          n += rows.length
          if (rows.length === 0) return resolve()
          setImmediate(pump)
        })
      pump()
    })
    await cursor.close().catch(() => {})
    return n
  },
}

async function main() {
  const client = new pg.Client()
  await client.connect()
  // warmup connection + JIT
  await client.query({ text: `SELECT * FROM generate_series(1, 20000)`, rowMode: 'array' })

  console.log(`rows=${N}  (cursor batch=${BATCH})  row width ~6 cols\n`)
  console.log('strategy'.padEnd(20) + 'rows/s'.padStart(12) + 'wall ms'.padStart(10) + 'maxLag ms'.padStart(11) + 'peakRSS MB'.padStart(12) + 'GC ms'.padStart(8))
  for (const [name, fn] of Object.entries(strategies)) {
    global.gc && global.gc()
    const inst = instrument()
    const rows = await fn(client)
    const m = await inst.stop()
    console.log(
      name.padEnd(20) +
        String(Math.round((rows / m.wall) * 1000)).padStart(12) +
        m.wall.toFixed(0).padStart(10) +
        m.maxLag.toFixed(1).padStart(11) +
        m.peakRssMB.toFixed(0).padStart(12) +
        m.gcPause.toFixed(0).padStart(8)
    )
  }
  await client.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
