'use strict'
// Captures REAL server response bytes for representative queries so we can
// replay them through the Parser deterministically (no network, no DB) and
// measure CPU-bound parsing/row-building + GC performance.
//
// Includes large, SaaS-realistic result sets (UUIDs, text, timestamptz, numeric,
// jsonb, booleans, nullable columns) in addition to the original micro-fixtures.

const fs = require('fs')
const path = require('path')
const pg = require('../../pg/lib')

// scale row counts via env, defaults sized like real "report/export" queries
const USERS = parseInt(process.env.BENCH_USERS || '10000', 10)
const ORDERS = parseInt(process.env.BENCH_ORDERS || '20000', 10)
const EVENTS = parseInt(process.env.BENCH_EVENTS || '50000', 10)

const QUERIES = {
  // --- original micro-fixtures (kept for continuity) ---
  pg_type: {
    text: 'select typname, typnamespace, typowner, typlen, typbyval, typcategory, typispreferred, typisdefined, typdelim, typrelid, typelem, typarray from pg_type',
  },
  seq: { text: 'SELECT * FROM generate_series(1, 1000)' },
  mixed: {
    text: `SELECT g AS id, g::float8 AS f, 'name_' || g AS name, (g % 2 = 0) AS flag, now() - (g || ' seconds')::interval AS ts
           FROM generate_series(1, 1000) g`,
  },

  // --- SaaS-realistic, larger fixtures ---

  // Wide entity rows: the bread-and-butter "list users" / "load account" query.
  // uuid, text, bool, timestamptz, numeric, int, nullable text, jsonb.
  users: {
    text: `SELECT
        ('00000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid AS id,
        'user_' || g || '@example.com' AS email,
        'First' || g AS first_name,
        'Last' || g AS last_name,
        (g % 3 = 0) AS is_active,
        (g % 11 = 0) AS is_admin,
        (now() - (g || ' minutes')::interval) AS created_at,
        (now() - ((g % 600) || ' seconds')::interval) AS updated_at,
        (g * 1.07)::numeric(12,2) AS balance,
        (g % 1000) AS login_count,
        CASE WHEN g % 5 = 0 THEN NULL ELSE 'Bio for user ' || g END AS bio,
        jsonb_build_object('theme', CASE WHEN g % 2 = 0 THEN 'dark' ELSE 'light' END,
                           'notifications', g % 2 = 0, 'plan', 'pro', 'seats', g % 20) AS settings
      FROM generate_series(1, ${USERS}) g`,
  },

  // Transactional rows: numerics, fks, enum-ish status text, timestamps, jsonb.
  orders: {
    text: `SELECT
        g AS id,
        (g % ${USERS}) + 1 AS user_id,
        ('ORD-' || lpad(g::text, 8, '0')) AS order_number,
        (ARRAY['pending','paid','shipped','delivered','cancelled'])[1 + g % 5] AS status,
        (g * 9.99)::numeric(12,2) AS total,
        ((g % 100) * 0.07)::numeric(6,2) AS tax,
        (now() - (g || ' hours')::interval) AS created_at,
        (g % 3 = 0) AS is_gift,
        CASE WHEN g % 4 = 0 THEN NULL ELSE 'note ' || g END AS notes,
        jsonb_build_object('items', g % 10, 'coupon', CASE WHEN g % 4 = 0 THEN 'SAVE10' ELSE NULL END) AS metadata
      FROM generate_series(1, ${ORDERS}) g`,
  },

  // Very wide rows (60 mixed-type columns) — stresses the compiled row-builder
  // (large generated function) and per-row field-loop scaling.
  wide: {
    text: `SELECT ${Array.from({ length: 60 }, (_, i) => {
      switch (i % 5) {
        case 0:
          return `(g + ${i}) AS c${i}` // int
        case 1:
          return `(g * ${i}.5)::float8 AS c${i}` // float
        case 2:
          return `('s${i}_' || g) AS c${i}` // text
        case 3:
          return `(g % 2 = 0) AS c${i}` // bool
        default:
          return `CASE WHEN g % 3 = 0 THEN NULL ELSE 'v${i}_' || g END AS c${i}` // nullable text
      }
    }).join(', ')} FROM generate_series(1, 3000) g`,
  },

  // NULL-dense rows (~85% of fields null) — exercises the null branch density in
  // both the parser and the row builders.
  null_heavy: {
    text: `SELECT ${Array.from(
      { length: 16 },
      (_, i) => `CASE WHEN g % 7 = 0 THEN ('val${i}_' || g) ELSE NULL END AS n${i}`
    ).join(', ')} FROM generate_series(1, 8000) g`,
  },

  // High-volume analytics events: narrower rows, jsonb payload, huge counts.
  events: {
    text: `SELECT
        g AS id,
        (g % ${USERS}) + 1 AS user_id,
        (ARRAY['click','view','signup','purchase','logout'])[1 + g % 5] AS event_type,
        (now() - (g || ' seconds')::interval) AS occurred_at,
        jsonb_build_object('path', '/page/' || (g % 50), 'ms', g % 5000, 'ref', 'https://ref/' || (g % 30)) AS props
      FROM generate_series(1, ${EVENTS}) g`,
  },
}

const run = async () => {
  const client = new pg.Client()
  await client.connect()

  const con = client.connection
  const fixtures = {}

  for (const [key, q] of Object.entries(QUERIES)) {
    const chunks = []
    const onData = (buf) => chunks.push(Buffer.from(buf))
    con.stream.on('data', onData)
    await client.query({ text: q.text, rowMode: 'array' })
    await new Promise((r) => setImmediate(r))
    con.stream.removeListener('data', onData)
    const all = Buffer.concat(chunks)
    fixtures[key] = all.toString('base64')
    console.log(`${key}: ${(all.length / 1e6).toFixed(2)} MB in ${chunks.length} chunk(s)`)
  }

  fs.writeFileSync(path.join(__dirname, 'fixtures.json'), JSON.stringify(fixtures))
  console.log('wrote fixtures.json')
  await client.end()
}

run().catch((e) => {
  console.error(e)
  process.exit(1)
})
