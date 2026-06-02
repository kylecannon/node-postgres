'use strict'
const helper = require('./test-helper')
const assert = require('assert')
const suite = new helper.Suite()
const test = suite.test.bind(suite)

const Result = require('../../lib/result')

// The pg-protocol parser now yields a Buffer (a copy of the wire bytes) for any
// column whose RowDescription format is 'binary', and a string for text columns.
// result.js must pass that Buffer straight to the binary type parser without a
// lossy Buffer.from(string) re-encode. These tests stub the type registry so we
// can observe exactly what value reaches the parser for each column.

// int4 oid 23 binary parser: 4-byte big-endian signed int (matches pg-types).
function makeBinaryInt4(value) {
  const b = Buffer.allocUnsafe(4)
  b.writeInt32BE(value, 0)
  return b
}

// A types registry that records which raw values each column parser received and
// dispatches the correct parser per (oid, format).
function recordingTypes(record) {
  return {
    getTypeParser(oid, format) {
      return (raw) => {
        record.push({ oid, format, raw, isBuffer: Buffer.isBuffer(raw) })
        if (format === 'binary') {
          // emulate pg-types binary int4
          if (oid === 23) return raw.readInt32BE(0)
          // emulate a binary text/bytea passthrough
          return raw
        }
        // text
        if (oid === 23) return parseInt(raw, 10)
        return raw
      }
    },
  }
}

test('compiled object builder: binary column gets the Buffer passed to the binary parser', function () {
  const record = []
  const result = new Result('object', recordingTypes(record))
  result.addFields([{ name: 'n', dataTypeID: 23, format: 'binary' }])

  const buf = makeBinaryInt4(123456)
  const row = result.parseRow([buf])

  assert.strictEqual(row.n, 123456)
  assert.strictEqual(record.length, 1)
  assert.strictEqual(record[0].format, 'binary')
  assert.strictEqual(record[0].isBuffer, true, 'binary parser must receive a Buffer')
  // the EXACT buffer is forwarded (no re-encode / copy)
  assert.strictEqual(record[0].raw, buf)
})

test('compiled object builder: text column still gets the raw string', function () {
  const record = []
  const result = new Result('object', recordingTypes(record))
  result.addFields([{ name: 'n', dataTypeID: 23, format: 'text' }])

  const row = result.parseRow(['42'])

  assert.strictEqual(row.n, 42)
  assert.strictEqual(record[0].format, 'text')
  assert.strictEqual(record[0].isBuffer, false)
  assert.strictEqual(record[0].raw, '42')
})

test('compiled object builder: mixed text + binary columns', function () {
  const record = []
  const result = new Result('object', recordingTypes(record))
  result.addFields([
    { name: 't', dataTypeID: 25, format: 'text' },
    { name: 'b', dataTypeID: 23, format: 'binary' },
  ])

  const buf = makeBinaryInt4(-7)
  const row = result.parseRow(['hello', buf])

  assert.strictEqual(row.t, 'hello')
  assert.strictEqual(row.b, -7)
  // text col got a string, binary col got the Buffer
  const t = record.find((r) => r.format === 'text')
  const b = record.find((r) => r.format === 'binary')
  assert.strictEqual(t.isBuffer, false)
  assert.strictEqual(b.isBuffer, true)
  assert.strictEqual(b.raw, buf)
})

test('compiled object builder: null binary column stays null, parser not called', function () {
  const record = []
  const result = new Result('object', recordingTypes(record))
  result.addFields([{ name: 'b', dataTypeID: 23, format: 'binary' }])

  const row = result.parseRow([null])

  assert.strictEqual(row.b, null)
  assert.strictEqual(record.length, 0, 'parser must not run for SQL NULL')
})

test('array mode: binary column gets the Buffer passed to the binary parser', function () {
  const record = []
  const result = new Result('array', recordingTypes(record))
  result.addFields([
    { name: 't', dataTypeID: 25, format: 'text' },
    { name: 'b', dataTypeID: 23, format: 'binary' },
  ])

  const buf = makeBinaryInt4(99)
  const row = result.parseRow(['x', buf])

  assert.deepStrictEqual(row, ['x', 99])
  const b = record.find((r) => r.format === 'binary')
  assert.strictEqual(b.isBuffer, true)
  assert.strictEqual(b.raw, buf)
})

test('array mode: null binary column stays null, parser not called', function () {
  const record = []
  const result = new Result('array', recordingTypes(record))
  result.addFields([{ name: 'b', dataTypeID: 23, format: 'binary' }])

  const row = result.parseRow([null])

  assert.deepStrictEqual(row, [null])
  assert.strictEqual(record.length, 0)
})

test('interpreted object fallback (__proto__ shape): binary column gets the Buffer', function () {
  // a "__proto__" column forces the interpreted parseRow path (no compiled builder)
  const record = []
  const result = new Result('object', recordingTypes(record))
  result.addFields([
    { name: '__proto__', dataTypeID: 25, format: 'text' },
    { name: 'b', dataTypeID: 23, format: 'binary' },
  ])
  assert.strictEqual(result._rowBuilder, null, 'shape with __proto__ must use the interpreted path')

  const buf = makeBinaryInt4(2024)
  const row = result.parseRow(['p', buf])

  assert.strictEqual(row['__proto__'], 'p')
  assert.strictEqual(row.b, 2024)
  const b = record.find((r) => r.format === 'binary')
  assert.strictEqual(b.isBuffer, true)
  assert.strictEqual(b.raw, buf)
})

test('interpreted object fallback: null binary column stays null', function () {
  const record = []
  const result = new Result('object', recordingTypes(record))
  result.addFields([
    { name: '__proto__', dataTypeID: 25, format: 'text' },
    { name: 'b', dataTypeID: 23, format: 'binary' },
  ])
  assert.strictEqual(result._rowBuilder, null)

  const row = result.parseRow(['p', null])
  assert.strictEqual(row.b, null)
  // only the text column's parser ran
  assert.strictEqual(record.length, 1)
  assert.strictEqual(record[0].format, 'text')
})

test('addFields selects the binary type parser for binary columns', function () {
  const seen = []
  const types = {
    getTypeParser(oid, format) {
      seen.push({ oid, format })
      return (v) => v
    },
  }
  const result = new Result('object', types)
  result.addFields([
    { name: 'a', dataTypeID: 23, format: 'text' },
    { name: 'b', dataTypeID: 23, format: 'binary' },
  ])
  assert.deepStrictEqual(seen, [
    { oid: 23, format: 'text' },
    { oid: 23, format: 'binary' },
  ])
})
