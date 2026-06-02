'use strict'
// End-to-end test for `binary: true` result mode.
//
// A query issued with `{ binary: true }` requests binary-format columns from
// the backend (via the extended-protocol Bind message). The pg-protocol parser
// hands binary columns to result.js as copied Buffers, which are then passed to
// the per-column *binary* type parser selected by RowDescription.format.
//
// These tests round-trip a representative set of types and assert the binary
// result equals the text result (or, for the few types whose binary value is
// semantically equal but a different JS shape, asserts the semantic equality).
// They run in all three result.js code paths: the compiled object builder, the
// interpreted object fallback (forced via a `__proto__` column), and the array
// builder. NULLs and a bytea Buffer round-trip are included.
const helper = require('./test-helper')
const assert = require('assert')
const suite = new helper.Suite()

// Comparators -----------------------------------------------------------------

// strict deep-equal: binary and text yield identical JS values
const eqStrict = (name) => (text, bin) => {
  assert.deepStrictEqual(bin, text, `${name}: binary !== text (text=${text}, bin=${bin})`)
}

// Date equality by timestamp (binary parser adds usec helper methods to the Date
// instance, so the objects are not deep-equal, but they represent the same time)
const eqDate = (name) => (text, bin) => {
  assert.ok(text instanceof Date && bin instanceof Date, `${name}: both should be Date`)
  assert.strictEqual(bin.getTime(), text.getTime(), `${name}: Date time mismatch`)
}

// numeric: text parser returns a string, binary parser returns a number; assert
// they represent the same numeric value
const eqNumericValue = (name) => (text, bin) => {
  assert.strictEqual(Number(bin), Number(text), `${name}: numeric value mismatch`)
  assert.strictEqual(String(Number(bin)), String(Number(text)), `${name}: numeric value mismatch`)
}

// bytea: both must be Buffers with identical bytes (the key correctness fix —
// pg-types ships no binary parser for bytea, so pg installs a passthrough)
const eqBytea = (name) => (text, bin) => {
  assert.ok(Buffer.isBuffer(text), `${name}: text bytea should be a Buffer`)
  assert.ok(Buffer.isBuffer(bin), `${name}: binary bytea should be a Buffer, got ${typeof bin}`)
  assert.deepStrictEqual(bin, text, `${name}: bytea bytes differ`)
}

// int8[]: text parser yields string elements, binary parser yields number
// elements; assert the same numeric values element-by-element
const eqNumberArray = (name) => (text, bin) => {
  assert.ok(Array.isArray(text) && Array.isArray(bin), `${name}: both should be arrays`)
  assert.strictEqual(bin.length, text.length, `${name}: array length mismatch`)
  for (let i = 0; i < text.length; i++) {
    assert.strictEqual(Number(bin[i]), Number(text[i]), `${name}: element ${i} mismatch`)
  }
}

// Types that round-trip correctly between text and binary mode. Each entry is a
// SQL expression and a comparator. Avoid NaN here (see known-divergence note).
const cases = [
  { name: 'int2 min', expr: '(-32768)::int2', cmp: eqStrict },
  { name: 'int2 max', expr: '32767::int2', cmp: eqStrict },
  { name: 'int2 neg', expr: '(-42)::int2', cmp: eqStrict },
  { name: 'int4 min', expr: '(-2147483648)::int4', cmp: eqStrict },
  { name: 'int4 max', expr: '2147483647::int4', cmp: eqStrict },
  { name: 'int4 zero', expr: '0::int4', cmp: eqStrict },
  // int8 beyond MAX_SAFE_INTEGER returns a string in BOTH text and binary mode
  { name: 'int8 big', expr: '9223372036854775807::int8', cmp: eqStrict },
  { name: 'int8 small', expr: '123::int8', cmp: eqStrict },
  { name: 'int8 neg', expr: '(-9223372036854775808)::int8', cmp: eqStrict },
  { name: 'float4', expr: '3.5::float4', cmp: eqStrict },
  { name: 'float4 neg', expr: '(-12.25)::float4', cmp: eqStrict },
  { name: 'float8', expr: '3.141592653589793::float8', cmp: eqStrict },
  // float8 Inf round-trips; float8 NaN and ALL float4 Inf/NaN do NOT — those are
  // pre-existing bugs in pg-types' manual bit decoders (parseFloat32 /
  // parseFloat64 mishandle the all-ones exponent), independent of this change and
  // out of scope here. See the known-divergence note at the bottom of this file.
  { name: 'float8 Infinity', expr: "'Infinity'::float8", cmp: eqStrict },
  { name: 'float8 -Infinity', expr: "'-Infinity'::float8", cmp: eqStrict },
  { name: 'float8 -0', expr: '(-0.0)::float8', cmp: eqStrict },
  { name: 'bool true', expr: 'true', cmp: eqStrict },
  { name: 'bool false', expr: 'false', cmp: eqStrict },
  { name: 'text multibyte', expr: "'é中𝕏'::text", cmp: eqStrict },
  { name: 'text empty', expr: "''::text", cmp: eqStrict },
  { name: 'varchar', expr: "'hello world'::varchar", cmp: eqStrict },
  { name: 'bytea', expr: "decode('deadbeef0011ff','hex')", cmp: eqBytea },
  { name: 'bytea empty', expr: "decode('','hex')", cmp: eqBytea },
  { name: 'timestamptz', expr: "'2020-03-15 13:14:15.123+00'::timestamptz", cmp: eqDate },
  { name: 'timestamp', expr: "'2020-03-15 13:14:15.123'::timestamp", cmp: eqDate },
  { name: 'numeric', expr: '12345.6789::numeric', cmp: eqNumericValue },
  { name: 'numeric neg', expr: '(-987.654)::numeric', cmp: eqNumericValue },
  { name: 'int4[]', expr: "'{1,2,3}'::int4[]", cmp: eqStrict },
  { name: 'int4[] nested+null', expr: "'{{1,NULL},{3,4}}'::int4[]", cmp: eqStrict },
  { name: 'int8[]', expr: "'{10,20,30}'::int8[]", cmp: eqNumberArray },
]

async function fetchScalar(client, expr, opts) {
  const res = await client.query(Object.assign({ text: `select ${expr} as v` }, opts))
  return res.rows[0].v
}

async function fetchScalarArrayMode(client, expr, opts) {
  const res = await client.query(Object.assign({ text: `select ${expr} as v`, rowMode: 'array' }, opts))
  return res.rows[0][0]
}

// The compiled object builder is used for ordinary column shapes. A column named
// `__proto__` cannot be expressed as an object literal key, so result.js falls
// back to the interpreted parseRow — this forces that path.
async function fetchScalarProto(client, expr, opts) {
  const res = await client.query(Object.assign({ text: `select ${expr} as "__proto__"` }, opts))
  return res.rows[0].__proto__
}

suite.test('binary results round-trip across all result.js code paths', async () => {
  const client = helper.client()
  try {
    for (const c of cases) {
      // Path 1: compiled object builder
      const text = await fetchScalar(client, c.expr, {})
      const bin = await fetchScalar(client, c.expr, { binary: true })
      c.cmp(c.name + ' [object]')(text, bin)

      // Path 2: array builder
      const textArr = await fetchScalarArrayMode(client, c.expr, {})
      const binArr = await fetchScalarArrayMode(client, c.expr, { binary: true })
      c.cmp(c.name + ' [array]')(textArr, binArr)

      // Path 3: interpreted object fallback (via __proto__ column)
      const textProto = await fetchScalarProto(client, c.expr, {})
      const binProto = await fetchScalarProto(client, c.expr, { binary: true })
      c.cmp(c.name + ' [interpreted]')(textProto, binProto)
    }
  } finally {
    await client.end()
  }
})

suite.test('binary results handle SQL NULL in every path', async () => {
  const client = helper.client()
  try {
    const nullTypes = ['int2', 'int4', 'int8', 'float4', 'float8', 'bool', 'bytea', 'text', 'timestamptz', 'numeric']
    for (const t of nullTypes) {
      const expr = `null::${t}`
      assert.strictEqual(await fetchScalar(client, expr, { binary: true }), null, `${t} null [object]`)
      assert.strictEqual(await fetchScalarArrayMode(client, expr, { binary: true }), null, `${t} null [array]`)
      assert.strictEqual(await fetchScalarProto(client, expr, { binary: true }), null, `${t} null [interpreted]`)
    }
  } finally {
    await client.end()
  }
})

suite.test('bytea binary result is a Buffer that survives later reads (copy, not view)', async () => {
  const client = helper.client()
  try {
    // Two rows in one result set; both binary Buffers must be distinct copies and
    // not aliased to the transient parser buffer (which would corrupt earlier
    // rows once later bytes are parsed).
    const res = await client.query({
      text: "select decode('aabbccdd','hex') as v union all select decode('11223344','hex') order by v",
      binary: true,
    })
    assert.strictEqual(res.rows.length, 2)
    const a = res.rows[0].v
    const b = res.rows[1].v
    assert.ok(Buffer.isBuffer(a) && Buffer.isBuffer(b))
    assert.deepStrictEqual(a, Buffer.from('11223344', 'hex'))
    assert.deepStrictEqual(b, Buffer.from('aabbccdd', 'hex'))
    assert.notStrictEqual(a, b)
  } finally {
    await client.end()
  }
})

suite.test('binary: true forces the extended protocol for value-less queries', async () => {
  // Without the requiresPreparation() change a bare `{ text, binary: true }`
  // (no values) would use the simple query path and silently stay text. Assert
  // that bytea comes back as a Buffer, proving binary format was actually used.
  const client = helper.client()
  try {
    const v = (await client.query({ text: "select decode('cafe','hex') as v", binary: true })).rows[0].v
    assert.ok(Buffer.isBuffer(v), 'expected Buffer (binary format) for value-less binary query')
    assert.deepStrictEqual(v, Buffer.from('cafe', 'hex'))
  } finally {
    await client.end()
  }
})

// Known divergences (NOT fixed here — they live in pg-types, not pg/pg-protocol).
// This test documents and pins the *current* binary-mode behavior of types that
// pg-types either lacks a binary parser for or decodes differently than text, so
// callers know which types are unsafe to request binary and so a future pg-types
// fix surfaces here. bytea is intentionally NOT in this list: pg installs a
// binary passthrough for it (see type-overrides.js) so it round-trips correctly.
suite.test('documents known binary/text divergences from pg-types', async () => {
  const client = helper.client()
  try {
    // json: text mode JSON.parses to an object; binary mode returns the raw utf8
    // string (pg-types has no binary json parser -> noParse stringifies the bytes).
    const jt = (await client.query({ text: `select '{"a":1}'::json as v` })).rows[0].v
    const jb = (await client.query({ text: `select '{"a":1}'::json as v`, binary: true })).rows[0].v
    assert.deepStrictEqual(jt, { a: 1 })
    assert.strictEqual(typeof jb, 'string', 'json binary currently returns a string (pg-types gap)')

    // jsonb: binary wire format has a leading 0x01 version byte before the json
    // text; pg-types has no binary jsonb parser, so the result is a string that
    // begins with that stray version byte.
    const bt = (await client.query({ text: `select '{"a":1}'::jsonb as v` })).rows[0].v
    const bb = (await client.query({ text: `select '{"a":1}'::jsonb as v`, binary: true })).rows[0].v
    assert.deepStrictEqual(bt, { a: 1 })
    assert.strictEqual(typeof bb, 'string', 'jsonb binary currently returns a string (pg-types gap)')

    // uuid: 16 raw bytes in binary; pg-types has no binary uuid parser, so the
    // string is garbage rather than the dashed text form.
    const ut = (await client.query({ text: `select 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid as v` })).rows[0].v
    const ub = (await client.query({ text: `select 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11'::uuid as v`, binary: true }))
      .rows[0].v
    assert.strictEqual(ut, 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11')
    assert.notStrictEqual(ub, ut, 'uuid binary does not match text (pg-types gap)')

    // float8 NaN: pg-types parseFloat64 decodes the all-ones exponent as Infinity.
    const ft = (await client.query({ text: `select 'NaN'::float8 as v` })).rows[0].v
    const fb = (await client.query({ text: `select 'NaN'::float8 as v`, binary: true })).rows[0].v
    assert.ok(Number.isNaN(ft))
    assert.ok(!Number.isNaN(fb), 'float8 NaN currently decodes to non-NaN in binary (pg-types gap)')
  } finally {
    await client.end()
  }
})

suite.test('mixed binary + text columns in one row decode correctly', async () => {
  // All columns share one result-format code, so binary:true makes every column
  // binary; this verifies a multi-column row of differing types round-trips.
  const client = helper.client()
  try {
    const text = (
      await client.query({
        text: "select 42::int4 as a, 'hi'::text as b, decode('ff00','hex') as c, true as d",
      })
    ).rows[0]
    const bin = (
      await client.query({
        text: "select 42::int4 as a, 'hi'::text as b, decode('ff00','hex') as c, true as d",
        binary: true,
      })
    ).rows[0]
    assert.strictEqual(bin.a, text.a)
    assert.strictEqual(bin.b, text.b)
    assert.deepStrictEqual(bin.c, text.c)
    assert.strictEqual(bin.d, text.d)
  } finally {
    await client.end()
  }
})
