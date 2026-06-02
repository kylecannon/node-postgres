'use strict'
// Measures max event-loop lag while consuming a large result of tiny rows,
// where a single TCP chunk can pack hundreds of thousands of rows and the
// synchronous parse blocks the loop. Used for A/B (baseline vs optimized).
const pg = require('./lib')

function lagMeter() {
  let max = 0
  let last = process.hrtime.bigint()
  const t = setInterval(() => {
    const n = process.hrtime.bigint()
    const l = Number(n - last) / 1e6 - 1
    if (l > max) max = l
    last = n
  }, 1)
  return {
    stop: () => {
      clearInterval(t)
      return max
    },
  }
}

const N = parseInt(process.argv[2] || '200000', 10)

async function main() {
  // Cooperative yielding is opt-in (default off = unchanged delivery); enable it
  // here so this A/B measures the feature. On the base snapshot the option is
  // simply ignored, so the comparison stays valid.
  const c = new pg.Client({ maxResultChunkBytes: 512 * 1024 })
  await c.connect()
  await c.query({ text: 'SELECT * FROM generate_series(1,20000)', rowMode: 'array' })
  let best = Infinity
  for (let i = 0; i < 7; i++) {
    const m = lagMeter()
    await c.query({ text: `SELECT * FROM generate_series(1,${N})`, rowMode: 'array' })
    await new Promise((r) => setTimeout(r, 5))
    best = Math.min(best, m.stop())
  }
  console.log(`maxLagMs ${best.toFixed(1)}`)
  await c.end()
}
main().catch((e) => {
  console.error(e)
  process.exit(1)
})
