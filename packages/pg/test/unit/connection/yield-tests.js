'use strict'
const helper = require('./test-helper')
const assert = require('assert')
const Connection = require('../../../lib/connection')
const { Client } = require('../../../lib')
const suite = new helper.Suite()
const test = suite.test.bind(suite)
const { MemoryStream } = helper

// A MemoryStream that records pause()/resume(). Cooperative yielding only
// engages when the stream exposes both, so the plain MemoryStream (which has
// neither) always takes the non-yielding path.
function pausableStream() {
  const stream = new MemoryStream()
  stream.destroyed = false
  stream.pauseCalls = 0
  stream.resumeCalls = 0
  stream.pause = function () {
    this.pauseCalls++
  }
  stream.resume = function () {
    this.resumeCalls++
  }
  return stream
}

// A result chunk the parser treats as an incomplete message — its declared
// length far exceeds the bytes present, so the parser buffers it and emits
// nothing. Lets us drive the byte-budget logic without crafting full messages.
function partialChunk(size) {
  const buf = Buffer.alloc(size)
  buf[0] = 0x44 // 'D' (DataRow)
  buf.writeUInt32BE(0x00ffffff, 1) // huge declared length -> always incomplete
  return buf
}

test('cooperative yield is off by default', function () {
  const con = new Connection({ stream: new MemoryStream() })
  assert.strictEqual(con._yieldEveryBytes, 0)
})

test('maxResultChunkBytes enables cooperative yield', function () {
  const con = new Connection({ stream: new MemoryStream(), maxResultChunkBytes: 512 * 1024 })
  assert.strictEqual(con._yieldEveryBytes, 512 * 1024)
})

test('maxResultChunkBytes: 0 keeps yield disabled', function () {
  const con = new Connection({ stream: new MemoryStream(), maxResultChunkBytes: 0 })
  assert.strictEqual(con._yieldEveryBytes, 0)
})

test('Client forwards maxResultChunkBytes to its Connection', function () {
  const enabled = new Client({ maxResultChunkBytes: 256 * 1024 })
  assert.strictEqual(enabled.connection._yieldEveryBytes, 256 * 1024)
  // default Client opts out -> unchanged delivery
  const def = new Client()
  assert.strictEqual(def.connection._yieldEveryBytes, 0)
})

test('does not pause the stream on the default (off) path', function () {
  const stream = pausableStream()
  const con = new Connection({ stream })
  con.connect(0, 'localhost')
  stream.emit('data', partialChunk(64)) // larger than any budget, but yield is off
  assert.strictEqual(stream.pauseCalls, 0, 'must never pause when yielding is disabled')
})

test('does not pause for a burst under the byte budget', function () {
  const stream = pausableStream()
  const con = new Connection({ stream, maxResultChunkBytes: 1000 })
  con.connect(0, 'localhost')
  stream.emit('data', Buffer.alloc(4)) // 4 bytes < 1000-byte budget
  assert.strictEqual(stream.pauseCalls, 0)
})

test('pauses after the byte budget is crossed and resumes on the next tick', function () {
  const stream = pausableStream()
  const con = new Connection({ stream, maxResultChunkBytes: 10 })
  con.connect(0, 'localhost')
  stream.emit('data', partialChunk(16)) // 16 >= 10-byte budget -> pause now
  assert.strictEqual(stream.pauseCalls, 1, 'pauses once the budget is crossed')
  assert.strictEqual(stream.resumeCalls, 0, 'resume is deferred to the next tick, not synchronous')
  return new Promise((resolve) => {
    setImmediate(() => {
      assert.strictEqual(stream.resumeCalls, 1, 'resumes on the next event-loop tick')
      resolve()
    })
  })
})
