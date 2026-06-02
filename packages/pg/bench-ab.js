'use strict'
// Focused, parse-bound e2e benchmark for controlled A/B runs.
// Measures qps for multi-row queries (where row parsing is a meaningful share
// of per-query cost). No 100MB bytea test (avoids GC noise across A/B).
const pg = require('./lib')

const params = {
  text: 'select typname, typnamespace, typowner, typlen, typbyval, typcategory, typispreferred, typisdefined, typdelim, typrelid, typelem, typarray from pg_type where typtypmod = $1 and typisdefined = $2',
  values: [-1, true],
}
const seq = { text: 'SELECT * FROM generate_series(1, 1000)' }

const exec = (client, q) => client.query({ text: q.text, values: q.values, rowMode: 'array' })

const bench = async (client, q, ms) => {
  const start = performance.now()
  let count = 0
  while (true) {
    await exec(client, q)
    count++
    if (performance.now() - start > ms) return count
  }
}

const run = async () => {
  const client = new pg.Client()
  await client.connect()
  // warmup
  await bench(client, params, 1500)
  await bench(client, seq, 1500)

  const secs = 4
  const results = {}
  for (const [name, q] of [
    ['param', params],
    ['seq', seq],
  ]) {
    // best-of-3 to reduce scheduling noise
    let best = 0
    for (let i = 0; i < 3; i++) {
      const n = await bench(client, q, secs * 1000)
      best = Math.max(best, n / secs)
    }
    results[name] = best
    console.log(`${name} qps ${best.toFixed(1)}`)
  }
  await client.end()
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
