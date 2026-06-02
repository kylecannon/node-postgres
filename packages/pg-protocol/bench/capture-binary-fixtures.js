'use strict'
// Captures REAL server response bytes for type-heavy result shapes in BOTH the
// text and binary wire formats, so we can replay them through Parser + Result
// deterministically (no network) and compare text-vs-binary on:
//   - throughput (rows/sec) and ns/row        -> replay-bench-binary.js
//   - GC pressure (collections, pause, ns/row) -> gc-bench-binary.js
//   - bytes-on-wire (binary int/float/ts are smaller and skip string parsing)
//
// Binary mode is requested per-query via { binary: true }, which forces the
// extended protocol so the Bind message can carry result-format=binary; the
// captured RowDescription then carries format='binary' per column, and the
// replay harness drives the SAME Parser/Result path the real client uses.
//
// Output binary-fixtures.json (gitignored, large) maps:
//   { [shape]: { text: <base64>, binary: <base64>,
//                meta: { cols, rows, textBytes, binaryBytes, ... } } }
//
// Usage: PGHOST=... node bench/capture-binary-fixtures.js

const fs = require('fs')
const path = require('path')
const pg = require('../../pg/lib')

// Row counts sized so each fixture replays a meaningful number of rows but the
// captured JSON stays manageable. Override via env.
const N = parseInt(process.env.BENCH_BINARY_ROWS || '20000', 10)

// Type-heavy shapes chosen to isolate where binary helps or hurts:
//   int_heavy   : many int4/int8 — binary is fixed 4/8 bytes, text varies and
//                 must be parseInt'd; biggest expected binary win.
//   float_heavy : float8/numeric — binary float8 is 8 bytes & a Buffer read;
//                 numeric binary is a digit-array decode (interesting: not
//                 always a win vs parseFloat on short text).
//   ts_heavy    : timestamptz/date/time — binary is fixed 8 bytes + int math vs
//                 parsing a ~29-char ISO string; strong binary win.
//   bytea_heavy : bytea — text is hex-encoded (2x size + hex decode), binary is
//                 the raw bytes; large wire + CPU win for binary.
//   mixed_saas  : realistic wide SaaS row (uuid/text/bool/ts/numeric/int/jsonb)
//                 — the everyday case; shows the blended effect.
const QUERIES = {
  int_heavy: {
    text: `SELECT
        g AS a, (g + 1) AS b, (g * 2) AS c, (g % 1000) AS d,
        (g * 1000)::int8 AS e, (g + 5000000000)::int8 AS f,
        (g % 32767)::int2 AS gg, (g + 7) AS h,
        (g - 3) AS i, (g << 1) AS j
      FROM generate_series(1, ${N}) g`,
  },

  float_heavy: {
    text: `SELECT
        (g * 1.5)::float8 AS a, (g / 3.0)::float8 AS b,
        (g * 0.001)::float8 AS c, (g * 9.99)::numeric(14,4) AS d,
        (g * 1.07)::numeric(12,2) AS e, (g::float4 * 2.5) AS f,
        (sqrt(g))::float8 AS gg, (ln(g + 1))::float8 AS h
      FROM generate_series(1, ${N}) g`,
  },

  ts_heavy: {
    text: `SELECT
        (now() - (g || ' seconds')::interval) AS a,
        (now() - (g || ' minutes')::interval) AS b,
        (now() - (g || ' hours')::interval) AS c,
        (current_date - (g % 3650)) AS d,
        (now() - (g || ' days')::interval)::timestamp AS e,
        (now() - (g || ' seconds')::interval) AS f
      FROM generate_series(1, ${N}) g`,
  },

  bytea_heavy: {
    text: `SELECT
        decode(md5(g::text), 'hex') AS a,
        decode(md5((g + 1)::text) || md5((g + 2)::text), 'hex') AS b,
        sha256(g::text::bytea) AS c,
        ('\\x' || md5((g + 3)::text))::bytea AS d
      FROM generate_series(1, ${N}) g`,
  },

  mixed_saas: {
    text: `SELECT
        ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid AS id,
        'user_' || g || '@example.com' AS email,
        'First' || g AS first_name,
        (g % 3 = 0) AS is_active,
        (now() - (g || ' minutes')::interval) AS created_at,
        (now() - ((g % 600) || ' seconds')::interval) AS updated_at,
        (g * 1.07)::numeric(12,2) AS balance,
        (g % 1000) AS login_count,
        (g * 1000)::int8 AS total_bytes,
        (g % 5 = 0) AS is_admin
      FROM generate_series(1, ${N}) g`,
  },
}

function wireStats(buf) {
  let off = 0
  let rows = 0
  let dataRowBytes = 0
  let rowDescBytes = 0
  let cols = 0
  while (off + 5 <= buf.length) {
    const code = buf[off]
    const len = buf.readUInt32BE(off + 1)
    if (code === 0x44) {
      // DataRow
      rows++
      dataRowBytes += 1 + len
    } else if (code === 0x54) {
      // RowDescription
      rowDescBytes += 1 + len
      cols = buf.readUInt16BE(off + 5)
    }
    off += 1 + len
  }
  return { rows, cols, dataRowBytes, rowDescBytes, totalBytes: buf.length }
}

const run = async () => {
  const client = new pg.Client()
  await client.connect()
  const con = client.connection
  const fixtures = {}

  for (const [key, q] of Object.entries(QUERIES)) {
    const entry = { meta: {} }
    for (const binary of [false, true]) {
      const chunks = []
      const onData = (b) => chunks.push(Buffer.from(b))
      con.stream.on('data', onData)
      await client.query({ text: q.text, rowMode: 'array', binary })
      await new Promise((r) => setImmediate(r))
      con.stream.removeListener('data', onData)
      const all = Buffer.concat(chunks)
      const fmt = binary ? 'binary' : 'text'
      entry[fmt] = all.toString('base64')
      const s = wireStats(all)
      entry.meta.cols = s.cols
      entry.meta.rows = s.rows
      entry.meta[`${fmt}Bytes`] = s.dataRowBytes
      entry.meta[`${fmt}BytesPerRow`] = +(s.dataRowBytes / s.rows).toFixed(2)
    }
    const m = entry.meta
    m.byteRatio = +(m.binaryBytes / m.textBytes).toFixed(3)
    fixtures[key] = entry
    console.log(
      `${key.padEnd(12)} cols=${String(m.cols).padStart(2)} rows=${m.rows}  ` +
        `text=${(m.textBytes / 1e6).toFixed(2)}MB (${m.textBytesPerRow} B/row)  ` +
        `binary=${(m.binaryBytes / 1e6).toFixed(2)}MB (${m.binaryBytesPerRow} B/row)  ` +
        `binary/text=${(m.byteRatio * 100).toFixed(1)}%`
    )
  }

  const outPath = path.join(__dirname, 'binary-fixtures.json')
  fs.writeFileSync(outPath, JSON.stringify(fixtures))
  console.log(`\nwrote ${outPath} (${(fs.statSync(outPath).size / 1e6).toFixed(1)} MB)`)
  await client.end()
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
