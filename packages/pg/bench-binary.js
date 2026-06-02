'use strict'
// End-to-end binary-vs-text A/B over a live connection. For each type-heavy
// shape it runs the SAME query twice — once with the text wire format and once
// with { binary: true } (extended protocol, result-format=binary) — and reports:
//   - user-CPU per query (the right metric for a CPU/parse optimization; local
//     wall-clock is I/O-bound and overlaps parsing with socket reads)
//   - cpu rows/sec
//   - max event-loop lag during the result (does the synchronous parse block?)
//   - bytes-on-wire per row (captured from the socket 'data' events)
//
// Binary is smaller on the wire for fixed-width types (int/float/timestamp/bytea)
// and skips text->value string parsing for some types, but the JS binary parsers
// for numeric/bytea can cost more CPU than the optimized text parsers — this A/B
// shows the net e2e effect per shape.
//
// Usage: PGHOST=... node [--expose-gc] bench-binary.js [rowCount]
const pg = require('./lib')

const N = parseInt(process.argv[2] || '50000', 10)

const SHAPES = {
  int_heavy: `SELECT g AS a, (g+1) AS b, (g*2) AS c, (g%1000) AS d,
      (g*1000)::int8 AS e, (g+5000000000)::int8 AS f, (g%32767)::int2 AS gg,
      (g+7) AS h, (g-3) AS i, (g<<1) AS j
    FROM generate_series(1, ${N}) g`,
  float_heavy: `SELECT (g*1.5)::float8 AS a, (g/3.0)::float8 AS b,
      (g*0.001)::float8 AS c, (g*9.99)::numeric(14,4) AS d,
      (g*1.07)::numeric(12,2) AS e, (g::float4*2.5) AS f,
      sqrt(g)::float8 AS gg, ln(g+1)::float8 AS h
    FROM generate_series(1, ${N}) g`,
  ts_heavy: `SELECT (now()-(g||' seconds')::interval) AS a,
      (now()-(g||' minutes')::interval) AS b, (now()-(g||' hours')::interval) AS c,
      (current_date-(g%3650)) AS d,
      (now()-(g||' days')::interval)::timestamp AS e,
      (now()-(g||' seconds')::interval) AS f
    FROM generate_series(1, ${N}) g`,
  bytea_heavy: `SELECT decode(md5(g::text),'hex') AS a,
      decode(md5((g+1)::text)||md5((g+2)::text),'hex') AS b,
      sha256(g::text::bytea) AS c, ('\\x'||md5((g+3)::text))::bytea AS d
    FROM generate_series(1, ${N}) g`,
  mixed_saas: `SELECT ('00000000-0000-4000-8000-'||lpad(g::text,12,'0'))::uuid AS id,
      'user_'||g||'@example.com' AS email, 'First'||g AS first_name,
      (g%3=0) AS is_active, (now()-(g||' minutes')::interval) AS created_at,
      (now()-((g%600)||' seconds')::interval) AS updated_at,
      (g*1.07)::numeric(12,2) AS balance, (g%1000) AS login_count,
      (g*1000)::int8 AS total_bytes, (g%5=0) AS is_admin
    FROM generate_series(1, ${N}) g`,
}

function lagMeter() {
  let max = 0
  let last = process.hrtime.bigint()
  const t = setInterval(() => {
    const n = process.hrtime.bigint()
    const l = Number(n - last) / 1e6 - 1
    if (l > max) max = l
    last = n
  }, 1)
  return { stop: () => (clearInterval(t), max) }
}

async function timeOne(client, text, binary) {
  // capture wire bytes for this run
  const con = client.connection
  let wireBytes = 0
  const onData = (b) => (wireBytes += b.length)
  con.stream.on('data', onData)
  const meter = lagMeter()
  const cpu0 = process.cpuUsage()
  const t0 = performance.now()
  const r = await client.query({ text, rowMode: 'array', binary })
  const wall = performance.now() - t0
  const cpu = process.cpuUsage(cpu0)
  const lag = meter.stop()
  con.stream.removeListener('data', onData)
  return { wall, cpuUs: cpu.user, lag, rows: r.rows.length, wireBytes }
}

async function bestOf(client, text, binary, iters) {
  let best = { cpuUs: Infinity, wall: Infinity, lag: Infinity, rows: 0, wireBytes: 0 }
  for (let i = 0; i < iters; i++) {
    const m = await timeOne(client, text, binary)
    if (m.cpuUs < best.cpuUs) best = m
    else {
      best.lag = Math.min(best.lag, m.lag)
      best.wall = Math.min(best.wall, m.wall)
    }
  }
  return best
}

async function main() {
  const client = new pg.Client()
  await client.connect()
  // warmup connection + JIT for both protocols
  await client.query({ text: 'SELECT * FROM generate_series(1,20000)', rowMode: 'array' })

  console.log(`rows=${N} per query, user-CPU is best-of-7 (min), lag is min observed\n`)
  console.log(
    'shape'.padEnd(13) +
      'fmt'.padEnd(8) +
      'cpuMs'.padStart(8) +
      'cpuRows/s'.padStart(12) +
      'wallMs'.padStart(9) +
      'maxLag'.padStart(9) +
      'B/row'.padStart(9)
  )
  const summary = []
  for (const [name, sql] of Object.entries(SHAPES)) {
    // warmup each shape (compile + prepared-stmt cache for binary)
    await timeOne(client, sql, false)
    await timeOne(client, sql, true)
    const t = await bestOf(client, sql, false, 7)
    const b = await bestOf(client, sql, true, 7)
    for (const [fmt, m] of [
      ['text', t],
      ['binary', b],
    ]) {
      console.log(
        name.padEnd(13) +
          fmt.padEnd(8) +
          (m.cpuUs / 1000).toFixed(1).padStart(8) +
          Math.round((m.rows / m.cpuUs) * 1e6)
            .toString()
            .padStart(12) +
          m.wall.toFixed(1).padStart(9) +
          m.lag.toFixed(1).padStart(9) +
          (m.wireBytes / m.rows).toFixed(1).padStart(9)
      )
    }
    const cpuRatio = b.cpuUs / t.cpuUs
    const wireRatio = b.wireBytes / t.wireBytes
    summary.push({ name, cpuRatio, wireRatio })
    console.log(
      `  -> binary CPU ${cpuRatio <= 1 ? (1 / cpuRatio).toFixed(2) + 'x less' : cpuRatio.toFixed(2) + 'x MORE'}, ` +
        `wire ${(wireRatio * 100).toFixed(0)}% of text\n`
    )
  }

  console.log('summary (binary relative to text):')
  for (const s of summary) {
    console.log(
      `  ${s.name.padEnd(13)} CPU ${(s.cpuRatio * 100).toFixed(0)}%  wire ${(s.wireRatio * 100).toFixed(0)}%` +
        `  ${s.cpuRatio < 1 ? '(binary cheaper)' : '(text cheaper on CPU)'}`
    )
  }
  await client.end()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
