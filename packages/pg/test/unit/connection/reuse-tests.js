'use strict'
// Guards the DataRow-recycling safety invariant: the parser may only recycle a
// single DataRowMessage when nothing can retain it. A 'message' listener may
// hold onto the message, so its presence MUST disable reuseObjects — covering
// both orderings (listener added before connect, and after attachListeners).
const helper = require('./test-helper')
const assert = require('assert')
const Connection = require('../../../lib/connection')
const suite = new helper.Suite()
const test = suite.test.bind(suite)
const { MemoryStream } = helper

const connectedConnection = () => {
  const con = new Connection({ stream: new MemoryStream() })
  con.connect(0, 'localhost') // non-ssl -> attachListeners runs synchronously
  return con
}

test('recycles DataRow messages by default (no message listener)', function () {
  const con = connectedConnection()
  assert.strictEqual(con._parser.reuseObjects, true)
})

test("a 'message' listener added before connect disables recycling", function () {
  const con = new Connection({ stream: new MemoryStream() })
  con.on('message', () => {})
  con.connect(0, 'localhost')
  assert.strictEqual(con._parser.reuseObjects, false, 'must not recycle when a message listener may retain the message')
})

test("a 'message' listener added after connect flips recycling off", function () {
  const con = connectedConnection()
  assert.strictEqual(con._parser.reuseObjects, true)
  con.on('message', () => {})
  assert.strictEqual(con._parser.reuseObjects, false, 'newListener hook must retroactively disable recycling')
})
