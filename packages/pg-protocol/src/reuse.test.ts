import buffers from './testing/test-buffers'
import assert from 'assert'
import { Parser } from './parser'
import { DataRowMessage } from './messages'

// Collect rows by copying fields out during the (synchronous) callback, which is
// exactly how pg consumes DataRow messages. With reuseObjects enabled the parser
// recycles a single message + fields array, so consumers MUST copy synchronously.
const collect = (parser: Parser, buf: Buffer) => {
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

describe('Parser reuseObjects', function () {
  const threeRows = Buffer.concat([
    buffers.dataRow(['a', '1', null]),
    buffers.dataRow(['bb', '22', 'x']),
    buffers.dataRow(['é中', '3', null]), // multi-byte utf8 + null
  ])

  it('produces identical results whether reuse is on or off', function () {
    const off = collect(new Parser(), threeRows)
    const on = collect(Object.assign(new Parser(), { reuseObjects: true }), threeRows)
    const expected = [
      ['a', '1', null],
      ['bb', '22', 'x'],
      ['é中', '3', null],
    ]
    assert.deepEqual(off.rows, expected)
    assert.deepEqual(on.rows, expected)
  })

  it('recycles a single DataRowMessage when reuse is on', function () {
    const on = collect(Object.assign(new Parser(), { reuseObjects: true }), threeRows)
    assert.equal(on.distinctMessages, 1)
  })

  it('allocates a fresh DataRowMessage per row by default', function () {
    const off = collect(new Parser(), threeRows)
    assert.equal(off.distinctMessages, 3)
  })

  it('resizes the recycled fields array when the column count changes', function () {
    const parser = new Parser()
    parser.reuseObjects = true
    const mixed = Buffer.concat([buffers.dataRow(['only']), buffers.dataRow(['a', 'b', 'c']), buffers.dataRow(['x'])])
    const { rows } = collect(parser, mixed)
    assert.deepEqual(rows, [['only'], ['a', 'b', 'c'], ['x']])
  })

  it('reuses the same fields array for consecutive same-width rows, and a fresh one on width change', function () {
    const parser = new Parser()
    parser.reuseObjects = true
    const buf = Buffer.concat([
      buffers.dataRow(['a', '1']),
      buffers.dataRow(['b', '2']), // same width -> same backing array
      buffers.dataRow(['c', '2', '3']), // width change -> fresh array
    ])
    const fieldArrays: any[][] = []
    parser.parse(buf, (msg) => {
      if (msg.name === 'dataRow') fieldArrays.push((msg as DataRowMessage).fields)
    })
    assert.equal(fieldArrays.length, 3)
    assert.strictEqual(fieldArrays[0], fieldArrays[1], 'same-width rows share the recycled fields array')
    assert.notStrictEqual(fieldArrays[1], fieldArrays[2], 'a column-count change allocates a fresh fields array')
  })

  it('sets DataRowMessage.length correctly on the recycled (reuse-on) path', function () {
    const parser = new Parser()
    parser.reuseObjects = true
    const lengths: number[] = []
    parser.parse(buffers.dataRow(['!']), (msg) => {
      if (msg.name === 'dataRow') lengths.push((msg as DataRowMessage).length)
    })
    // body = int16 fieldCount (2) + int32 len (4) + 1 byte payload = 7, plus the
    // 4-byte length field itself = 11, matching the non-reuse constructor path.
    assert.deepEqual(lengths, [11])
  })

  it('is correct when messages are split across chunk boundaries', function () {
    const parser = new Parser()
    parser.reuseObjects = true
    const rows: any[][] = []
    // feed one byte at a time to exercise the partial-message reassembly path
    for (let i = 0; i < threeRows.length; i++) {
      parser.parse(threeRows.subarray(i, i + 1), (msg) => {
        if (msg.name === 'dataRow') rows.push((msg as DataRowMessage).fields.slice())
      })
    }
    assert.deepEqual(rows, [
      ['a', '1', null],
      ['bb', '22', 'x'],
      ['é中', '3', null],
    ])
  })
})
