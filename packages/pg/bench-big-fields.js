'use strict'
// Rows with very large individual fields (multi-MB text + jsonb). Stresses:
//   - buffer reassembly (a 3MB field spans ~46 socket chunks -> mergeBuffer)
//   - large value-string allocation (-> V8 large-object space)
//   - JSON.parse of multi-MB jsonb (big atomic synchronous op, blocks the loop)
//
// Compares: default (jsonb parsed) vs jsonb-as-text (skip JSON.parse) vs stream.
// Usage: node --expose-gc --max-old-space-size=4096 bench-big-fields.js [rows] [strategy]
const pg = require('./lib')

const ROWS = parseInt(process.argv[2] || '40', 10)
const TEXT_REPEATS = 90000 // 32 * 90000 ≈ 2.88MB text
const JSON_REPEATS = 60000 // ≈ 1.9MB string inside the jsonb

const SQL = `SELECT g AS id,
    repeat(md5(g::text), ${TEXT_REPEATS}) AS big_text,
    jsonb_build_object('id', g, 'blob', repeat(md5(g::text), ${JSON_REPEATS}),
      'tags', (SELECT jsonb_agg(jsonb_build_object('k', t, 'v', md5(t::text))) FROM generate_series(1, 200) t)) AS big_json
  FROM generate_series(1, ${ROWS}) g`

const JSONB_OID = 3802

function meter() {
  let maxLag = 0
  let last = process.hrtime.bigint()
  const rss0 = process.memoryUsage().rss
  let peak = rss0
  const t = setInterval(() => {
    const n = process.hrtime.bigint()
    const l = Number(n - last) / 1e6 - 2
    if (l > maxLag) maxLag = l
    last = n
    const r = process.memoryUsage().rss
    if (r > peak) peak = r
  }, 2)
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  return {
    async stop() {
      const wall = performance.now() - t0
      const cpu = process.cpuUsage(cpu0)
      await new Promise((r) => setTimeout(r, 40))
      clearInterval(t)
      return { wall, maxLag, peakMB: (peak - rss0) / 1e6, cpuMs: cpu.user / 1000 }
    },
  }
}

async function runAccumulate(parseJson) {
  const types = parseJson ? undefined : { getTypeParser: (oid, fmt) => (oid === JSONB_OID ? (v) => v : pg.types.getTypeParser(oid, fmt)) }
  const c = new pg.Client()
  await c.connect()
  const m = meter()
  const r = await c.query({ text: SQL, rowMode: 'array', types })
  const res = await m.stop()
  await c.end()
  return { rows: r.rows.length, ...res }
}

async function runStream() {
  const c = new pg.Client()
  await c.connect()
  const m = meter()
  let n = 0
  const q = c.query(new pg.Query({ text: SQL, rowMode: 'array' }))
  q.on('row', () => n++)
  await new Promise((res, rej) => {
    q.on('end', res)
    q.on('error', rej)
  })
  const res = await m.stop()
  await c.end()
  return { rows: n, ...res }
}

async function main() {
  const approxMB = (ROWS * (2.88 + 2.0)).toFixed(0)
  console.log(`${ROWS} rows, ~2.9MB text + ~2MB jsonb each (~${approxMB}MB total)\n`)
  console.log('strategy'.padEnd(28) + 'wall ms'.padStart(10) + 'cpu ms'.padStart(9) + 'maxLag ms'.padStart(11) + 'peakRSS MB'.padStart(12))
  const variants = [
    ['accumulate (jsonb parsed)', () => runAccumulate(true)],
    ['accumulate (jsonb as text)', () => runAccumulate(false)],
    ['stream (jsonb parsed)', runStream],
  ]
  for (const [name, fn] of variants) {
    global.gc && global.gc()
    const m = await fn()
    console.log(name.padEnd(28) + m.wall.toFixed(0).padStart(10) + m.cpuMs.toFixed(0).padStart(9) + m.maxLag.toFixed(1).padStart(11) + m.peakMB.toFixed(0).padStart(12))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
