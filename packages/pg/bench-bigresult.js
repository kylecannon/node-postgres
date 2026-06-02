'use strict'
// Parse-dominated e2e: one big result set so row parsing is the bulk of the
// wall-clock, not the network round-trip. Reports rows/sec for the parse path.
const pg = require('./lib')

const ROWS = 50000
const wide = {
  text: `SELECT g AS id, g::float8 AS f, 'name_' || g AS name, (g % 2 = 0) AS flag, md5(g::text) AS h FROM generate_series(1, ${ROWS}) g`,
  rowMode: 'array',
}

const time1 = async (client) => {
  const cpu0 = process.cpuUsage()
  const start = performance.now()
  const r = await client.query(wide)
  const ms = performance.now() - start
  const cpu = process.cpuUsage(cpu0)
  return { ms, cpuUs: cpu.user, rows: r.rows.length }
}

const run = async () => {
  const client = new pg.Client()
  await client.connect()
  for (let i = 0; i < 4; i++) await time1(client) // warmup
  let bestCpu = Infinity
  let bestMs = Infinity
  let rows = 0
  for (let i = 0; i < 11; i++) {
    const { ms, cpuUs, rows: n } = await time1(client)
    bestCpu = Math.min(bestCpu, cpuUs)
    bestMs = Math.min(bestMs, ms)
    rows = n
  }
  // user-CPU microseconds is the right metric for a CPU optimization; wall-clock
  // on a local connection is I/O-bound and overlaps parsing with network reads.
  console.log(`rows ${rows} bestCpuMs ${(bestCpu / 1000).toFixed(1)} cpuRowsPerSec ${((rows / bestCpu) * 1e6).toFixed(0)} bestWallMs ${bestMs.toFixed(1)}`)
  await client.end()
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
