'use strict'
// Regression coverage for the compiled (new Function) row builders in result.js.
// The compiled path materializes rows from DB-supplied column names, so these
// tests lock in: compiled === interpreted output, signature injectivity (no
// cache collisions), bounded-cache overflow still produces correct rows, and the
// array-mode / binary / duplicate-name / zero-field edges.
const helper = require('./test-helper')
const assert = require('assert')
const suite = new helper.Suite()
const test = suite.test.bind(suite)

const Result = require('../../lib/result')

// Build the same shape twice: once on the compiled path, once forcing the
// interpreted fallback (_rowBuilder = null). Assert byte-identical output.
function assertCompiledMatchesInterpreted(rowMode, types, fields, rowData) {
  const compiled = new Result(rowMode, types)
  compiled.addFields(fields)
  assert.ok(compiled._rowBuilder !== null, 'expected a compiled builder for this shape')
  const compiledRow = compiled.parseRow(rowData)

  const interpreted = new Result(rowMode, types)
  interpreted.addFields(fields)
  interpreted._rowBuilder = null // force the interpreted fallback
  const interpretedRow = interpreted.parseRow(rowData)

  assert.deepStrictEqual(compiledRow, interpretedRow, 'compiled output must equal interpreted output')
  return compiledRow
}

test('compiled object row equals interpreted object row', function () {
  const row = assertCompiledMatchesInterpreted(
    'object',
    undefined,
    [
      { name: 'id', dataTypeID: 23, format: 'text' }, // int4 -> number
      { name: 'name', dataTypeID: 25, format: 'text' }, // text -> string
      { name: 'note', dataTypeID: 25, format: 'text' },
    ],
    ['7', 'kyle', null]
  )
  assert.deepStrictEqual(row, { id: 7, name: 'kyle', note: null })
  assert.strictEqual(Object.getPrototypeOf(row), Object.prototype, 'rows keep Object.prototype')
})

test('compiled array row equals interpreted array row', function () {
  const row = assertCompiledMatchesInterpreted(
    'array',
    undefined,
    [
      { name: 'id', dataTypeID: 23, format: 'text' },
      { name: 'name', dataTypeID: 25, format: 'text' },
    ],
    ['42', null]
  )
  assert.deepStrictEqual(row, [42, null])
})

test('object-builder signatures are injective (no name/format cache collision)', function () {
  // A single column literally named "a:0;b" must not collide with two columns
  // [a, b], whose signature is built from the same separator tokens.
  const one = new Result('object')
  one.addFields([{ name: 'a:0;b', dataTypeID: 25, format: 'text' }])
  const oneRow = one.parseRow(['x'])
  assert.deepStrictEqual(oneRow, { 'a:0;b': 'x' })

  const two = new Result('object')
  two.addFields([
    { name: 'a', dataTypeID: 25, format: 'text' },
    { name: 'b', dataTypeID: 25, format: 'text' },
  ])
  const twoRow = two.parseRow(['p', 'q'])
  assert.deepStrictEqual(twoRow, { a: 'p', b: 'q' }, 'second shape must get its own builder, not the first one')
})

test('bounded cache: shapes past MAX_OBJECT_ROW_BUILDERS still produce correct rows', function () {
  // Drive >1000 distinct shapes so the object-builder cache fills and stops
  // retaining; the overflow shapes must still compile and return correct rows.
  let lastRow
  for (let i = 0; i < 1100; i++) {
    const result = new Result('object')
    result.addFields([{ name: 'c' + i, dataTypeID: 25, format: 'text' }])
    lastRow = result.parseRow(['v' + i])
    assert.deepStrictEqual(lastRow, { ['c' + i]: 'v' + i })
  }
  // explicitly assert a late (definitely-uncached) shape is still correct
  const late = new Result('object')
  late.addFields([{ name: 'overflow_shape', dataTypeID: 25, format: 'text' }])
  assert.deepStrictEqual(late.parseRow(['ok']), { overflow_shape: 'ok' })
})

test('zero-field result yields an empty object', function () {
  const result = new Result('object')
  result.addFields([])
  assert.strictEqual(result._rowBuilder, null, 'no builder is compiled for a zero-field shape')
  assert.deepStrictEqual(result.parseRow([]), {})
})

test('duplicate column names: last value wins, compiled equals interpreted', function () {
  const row = assertCompiledMatchesInterpreted(
    'object',
    undefined,
    [
      { name: 'dup', dataTypeID: 25, format: 'text' },
      { name: 'dup', dataTypeID: 25, format: 'text' },
    ],
    ['first', 'second']
  )
  assert.deepStrictEqual(row, { dup: 'second' })
})

test('binary-format column is wrapped as a Buffer on both paths', function () {
  const identityTypes = { getTypeParser: () => (v) => v }
  const row = assertCompiledMatchesInterpreted(
    'object',
    identityTypes,
    [{ name: 'blob', dataTypeID: 17, format: 'binary' }],
    ['hi']
  )
  assert.ok(Buffer.isBuffer(row.blob), 'binary column should be a Buffer')
  assert.deepStrictEqual(row.blob, Buffer.from('hi'))
})
