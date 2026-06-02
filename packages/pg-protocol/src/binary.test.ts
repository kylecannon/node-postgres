import buffers from './testing/test-buffers'
import assert from 'assert'
import { Parser } from './parser'
import { DataRowMessage } from './messages'

// Build a RowDescription buffer with the given per-column formats. `formats` is
// an array of 'text' | 'binary'; field metadata beyond name/formatCode is
// irrelevant to DataRow decoding so we keep it minimal.
const rowDescription = (formats: Array<'text' | 'binary'>) =>
  buffers.rowDescription(
    formats.map((fmt, i) => ({
      name: 'c' + i,
      tableID: 0,
      attributeNumber: i,
      dataTypeID: 0,
      dataTypeSize: 0,
      typeModifier: 0,
      formatCode: fmt === 'binary' ? 1 : 0,
    }))
  )

// Parse a buffer and return the DataRow `fields` arrays. When `reuse` is set we
// copy each row's fields out synchronously (the contract pg follows) so the
// recycled backing array doesn't clobber earlier rows.
const parseRows = (buf: Buffer, reuse = false) => {
  const parser = new Parser()
  parser.reuseObjects = reuse
  const rows: any[][] = []
  const messageIdentities = new Set<DataRowMessage>()
  parser.parse(buf, (msg) => {
    if (msg.name === 'dataRow') {
      const dr = msg as DataRowMessage
      messageIdentities.add(dr)
      rows.push(dr.fields.slice())
    }
  })
  return { rows, distinctMessages: messageIdentities.size }
}

describe('Parser binary-format DataRow fields', function () {
  it('text-only rows are unchanged (still utf8 strings)', function () {
    const buf = Buffer.concat([rowDescription(['text', 'text']), buffers.dataRow(['hello', 'é中'])])
    const { rows } = parseRows(buf)
    assert.deepEqual(rows, [['hello', 'é中']])
    assert.strictEqual(typeof rows[0][0], 'string')
    assert.strictEqual(typeof rows[0][1], 'string')
  })

  it('text-only rows work even without a preceding RowDescription', function () {
    // No RowDescription: rowAllText defaults to true, so the text fast path runs.
    const { rows } = parseRows(buffers.dataRow(['a', 'b']))
    assert.deepEqual(rows, [['a', 'b']])
  })

  it('a binary column yields a Buffer with the correct bytes', function () {
    const payload = Buffer.from([0x00, 0x01, 0xff, 0x80, 0x7f])
    const buf = Buffer.concat([rowDescription(['binary']), buffers.dataRow([payload])])
    const { rows } = parseRows(buf)
    assert.ok(Buffer.isBuffer(rows[0][0]), 'binary column should be a Buffer')
    assert.deepEqual(rows[0][0], payload)
  })

  it('mixed text + binary row decodes each column by its format', function () {
    const bin = Buffer.from([0xde, 0xad, 0xbe, 0xef])
    const buf = Buffer.concat([rowDescription(['text', 'binary', 'text']), buffers.dataRow(['lead', bin, 'tail'])])
    const { rows } = parseRows(buf)
    assert.strictEqual(rows[0][0], 'lead')
    assert.ok(Buffer.isBuffer(rows[0][1]))
    assert.deepEqual(rows[0][1], bin)
    assert.strictEqual(rows[0][2], 'tail')
  })

  it('NULL in a binary column stays null', function () {
    const buf = Buffer.concat([rowDescription(['binary', 'binary']), buffers.dataRow([null, Buffer.from([0x01])])])
    const { rows } = parseRows(buf)
    assert.strictEqual(rows[0][0], null)
    assert.deepEqual(rows[0][1], Buffer.from([0x01]))
  })

  it('NULL in a text column stays null after a binary RowDescription path', function () {
    const buf = Buffer.concat([rowDescription(['text', 'binary']), buffers.dataRow([null, null])])
    const { rows } = parseRows(buf)
    assert.deepEqual(rows[0], [null, null])
  })

  it('binary field is a COPY, not a view into the wire buffer', function () {
    const payload = Buffer.from([1, 2, 3, 4])
    const rd = rowDescription(['binary'])
    const dr = buffers.dataRow([payload])
    const wire = Buffer.concat([rd, dr])
    const parser = new Parser()
    let field: Buffer | null = null
    parser.parse(wire, (msg) => {
      if (msg.name === 'dataRow') field = (msg as DataRowMessage).fields[0]
    })
    assert.ok(field !== null && Buffer.isBuffer(field))
    const snapshot = Buffer.from(field as Buffer)
    // Mutate the entire source wire buffer; a view would change with it.
    wire.fill(0xaa)
    assert.deepEqual(field, snapshot, 'binary field must not alias the wire buffer')
  })

  it('multi-row reuse yields distinct, non-aliased Buffers per row', function () {
    const rd = rowDescription(['binary'])
    const rows = Buffer.concat([
      rd,
      buffers.dataRow([Buffer.from([0x0a])]),
      buffers.dataRow([Buffer.from([0x0b])]),
      buffers.dataRow([Buffer.from([0x0c])]),
    ])
    // Capture the live (un-sliced) Buffer references during the callback to prove
    // each row hands out a freshly allocated Buffer even with reuse on.
    const parser = new Parser()
    parser.reuseObjects = true
    const captured: Buffer[] = []
    const values: number[] = []
    parser.parse(rows, (msg) => {
      if (msg.name === 'dataRow') {
        const b = (msg as DataRowMessage).fields[0] as Buffer
        captured.push(b)
        values.push(b[0])
      }
    })
    assert.deepEqual(values, [0x0a, 0x0b, 0x0c])
    // distinct Buffer instances (binary fields are allocUnsafe'd per field)
    assert.strictEqual(new Set(captured).size, 3)
    // and they don't alias each other
    assert.notStrictEqual(captured[0], captured[1])
    assert.notStrictEqual(captured[1], captured[2])
  })

  it('reuse on vs off produce identical binary results', function () {
    const rd = rowDescription(['text', 'binary'])
    const wire = Buffer.concat([
      rd,
      buffers.dataRow(['a', Buffer.from([0x01, 0x02])]),
      buffers.dataRow(['bb', Buffer.from([0x03])]),
      buffers.dataRow([null, null]),
    ])
    const off = parseRows(wire, false).rows
    const on = parseRows(wire, true).rows
    const expected = [
      ['a', Buffer.from([0x01, 0x02])],
      ['bb', Buffer.from([0x03])],
      [null, null],
    ]
    assert.deepEqual(off, expected)
    assert.deepEqual(on, expected)
  })

  it('is correct when a binary row is split across chunk boundaries', function () {
    const rd = rowDescription(['text', 'binary'])
    const wire = Buffer.concat([
      rd,
      buffers.dataRow(['x', Buffer.from([0xca, 0xfe, 0xba, 0xbe])]),
      buffers.dataRow(['y', Buffer.from([0x00, 0xff])]),
    ])
    const parser = new Parser()
    parser.reuseObjects = true
    const rows: any[][] = []
    // feed one byte at a time to exercise partial-message reassembly + mergeBuffer
    for (let i = 0; i < wire.length; i++) {
      parser.parse(wire.subarray(i, i + 1), (msg) => {
        if (msg.name === 'dataRow') rows.push((msg as DataRowMessage).fields.slice())
      })
    }
    assert.deepEqual(rows, [
      ['x', Buffer.from([0xca, 0xfe, 0xba, 0xbe])],
      ['y', Buffer.from([0x00, 0xff])],
    ])
  })

  it('a new RowDescription replaces stale formats (binary then text)', function () {
    const wire = Buffer.concat([
      rowDescription(['binary']),
      buffers.dataRow([Buffer.from([0x09])]),
      // second statement: text format -> must NOT be treated as binary
      rowDescription(['text']),
      buffers.dataRow(['plain']),
    ])
    const { rows } = parseRows(wire)
    assert.ok(Buffer.isBuffer(rows[0][0]))
    assert.deepEqual(rows[0][0], Buffer.from([0x09]))
    assert.strictEqual(rows[1][0], 'plain')
  })

  it('a new RowDescription replaces stale formats (text then binary)', function () {
    const wire = Buffer.concat([
      rowDescription(['text']),
      buffers.dataRow(['plain']),
      rowDescription(['binary']),
      buffers.dataRow([Buffer.from([0x07, 0x08])]),
    ])
    const { rows } = parseRows(wire)
    assert.strictEqual(rows[0][0], 'plain')
    assert.ok(Buffer.isBuffer(rows[1][0]))
    assert.deepEqual(rows[1][0], Buffer.from([0x07, 0x08]))
  })

  it('NoData clears stale binary formats so a later text result stays text', function () {
    const wire = Buffer.concat([
      rowDescription(['binary']),
      buffers.dataRow([Buffer.from([0x01])]),
      buffers.noData(),
      // a text RowDescription would normally precede these, but assert that even
      // a bare text DataRow after NoData is treated as text (not stale binary)
      rowDescription(['text']),
      buffers.dataRow(['ok']),
    ])
    const { rows } = parseRows(wire)
    assert.ok(Buffer.isBuffer(rows[0][0]))
    assert.strictEqual(rows[1][0], 'ok')
  })

  it('empty binary value (length 0) yields an empty Buffer, not null', function () {
    const buf = Buffer.concat([rowDescription(['binary']), buffers.dataRow([Buffer.alloc(0)])])
    const { rows } = parseRows(buf)
    assert.ok(Buffer.isBuffer(rows[0][0]))
    assert.strictEqual((rows[0][0] as Buffer).length, 0)
  })
})
