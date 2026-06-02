'use strict'
// Real-world pattern: a Pool serving many concurrent `pool.query(...)` calls,
// each returning a realistic "list endpoint" result set in OBJECT mode (the
// default). Measures what an app actually cares about under load: queries/sec,
// CPU spent per 1000 queries, latency (avg/p99), and event-loop lag.
//
// Usage: node [--expose-gc] bench-pool.js [rowsPerQuery] [concurrency] [poolMax] [seconds]
const pg = require('./lib')

const ROWS = parseInt(process.argv[2] || '100', 10)
const CONCURRENCY = parseInt(process.argv[3] || '40', 10)
const POOL_MAX = parseInt(process.argv[4] || '10', 10)
const SECONDS = parseInt(process.argv[5] || '6', 10)

// realistic ~8-column SaaS "list users" row (uuid, text, bool, timestamptz,
// numeric, int, jsonb) — object mode, as a real app receives it.
const SQL = `SELECT
  ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid AS id,
  'user_' || g || '@example.com' AS email,
  'First' || g AS first_name, 'Last' || g AS last_name,
  (g % 3 = 0) AS is_active,
  now() - (g || ' minutes')::interval AS created_at,
  (g * 1.07)::numeric(12,2) AS balance,
  (g % 1000) AS login_count,
  jsonb_build_object('theme', 'dark', 'plan', 'pro', 'seats', g % 20) AS settings
  FROM generate_series(1, ${ROWS}) g`

function pctl(arr, p) {
  if (!arr.length) return 0
  const s = arr.slice().sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

async function main() {
  const pool = new pg.Pool({ max: POOL_MAX })
  // warmup (also opens connections + warms JIT)
  await Promise.all(Array.from({ length: CONCURRENCY }, () => pool.query({ text: SQL })))

  let count = 0
  const latencies = []
  let maxLag = 0
  let last = process.hrtime.bigint()
  const lagTimer = setInterval(() => {
    const now = process.hrtime.bigint()
    const lag = Number(now - last) / 1e6 - 4
    if (lag > maxLag) maxLag = lag
    last = now
  }, 4)

  const endAt = performance.now() + SECONDS * 1000
  const cpu0 = process.cpuUsage()
  const worker = async () => {
    while (performance.now() < endAt) {
      const t = performance.now()
      await pool.query({ text: SQL }) // object mode (default) — the real-world path
      latencies.push(performance.now() - t)
      count++
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker))
  const cpu = process.cpuUsage(cpu0)
  clearInterval(lagTimer)

  const secs = (performance.now() - (endAt - SECONDS * 1000)) / 1000
  const qps = count / secs
  const cpuMsPer1k = cpu.user / 1000 / (count / 1000)
  console.log(
    `qps ${qps.toFixed(0)}  cpuMs/1k-queries ${cpuMsPer1k.toFixed(1)}  ` +
      `lat avg ${(latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)}ms ` +
      `p99 ${pctl(latencies, 99).toFixed(2)}ms  maxLag ${maxLag.toFixed(1)}ms  ` +
      `(rows/q=${ROWS}, conc=${CONCURRENCY}, pool=${POOL_MAX}, n=${count})`
  )
  await pool.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
