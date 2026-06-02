'use strict'
// Isolates pg-pool's OWN per-query overhead (promisify, connect, _pulseQueue,
// acquire/release, the pending queue, EventEmitter emits) with a mock client —
// no real Postgres, so the numbers reflect the pool machinery, not the network.
//
//   node [--expose-gc] bench/pool-micro.js [concurrency] [seconds]
const { EventEmitter } = require('events')
const Pool = require('../index')

const MOCK_RESULT = { rows: [], rowCount: 0 }

// Minimal client honoring the contract pg-pool relies on. connect/query/end
// call their callbacks on nextTick to mimic real async behavior.
class MockClient extends EventEmitter {
  constructor() {
    super()
    this._queryable = true
    this._ending = false
    this.connection = { stream: { destroy() {} } }
  }
  connect(cb) {
    if (cb) process.nextTick(cb, null)
  }
  query(_text, values, cb) {
    const callback = typeof values === 'function' ? values : cb
    // shared result object so the mock adds no per-query GC of its own — the
    // measured allocations are pg-pool's, not the client's.
    process.nextTick(callback, null, MOCK_RESULT)
  }
  end(cb) {
    this._ending = true
    if (cb) process.nextTick(cb)
  }
  isConnected() {
    return true
  }
  ref() {}
  unref() {}
}

const CONCURRENCY = parseInt(process.argv[2] || '50', 10)
const SECONDS = parseInt(process.argv[3] || '5', 10)

async function main() {
  const pool = new Pool({ max: 10, Client: MockClient, idleTimeoutMillis: 0 })
  // warm the pool + JIT
  await Promise.all(Array.from({ length: CONCURRENCY }, () => pool.query('SELECT 1')))

  let count = 0
  let gcPause = 0
  let gcCount = 0
  const { PerformanceObserver } = require('perf_hooks')
  const obs = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      gcCount++
      gcPause += e.duration
    }
  })
  obs.observe({ entryTypes: ['gc'] })

  const endAt = performance.now() + SECONDS * 1000
  const cpu0 = process.cpuUsage()
  const worker = async () => {
    while (performance.now() < endAt) {
      await pool.query('SELECT 1')
      count++
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  const cpu = process.cpuUsage(cpu0)
  await new Promise((r) => setTimeout(r, 50))
  obs.disconnect()

  const secs = (performance.now() - (endAt - SECONDS * 1000)) / 1000
  const qps = count / secs
  console.log(
    `qps ${qps.toFixed(0)}  cpuUs/query ${(cpu.user / count) | 0}  ` +
      `GC ${gcCount} pause ${gcPause.toFixed(1)}ms (${((gcPause / count) * 1e6).toFixed(1)} ns/query)  ` +
      `(conc=${CONCURRENCY}, n=${count})`
  )
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
