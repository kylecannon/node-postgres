'use strict'
// Covers the O(1) pending-queue dequeue + lazy slice-compaction (index.js
// _pulseQueue: the `_pendingHead > 64 && _pendingHead*2 > length` branch). The
// existing suite never queues more than ~30 waiters, so the slice path and the
// waitingCount = length - head bookkeeping under a deep, non-draining queue were
// untested. A max:1 pool fed N > 2*64 queries forces the head index past the
// threshold while the queue stays more than half full.
const expect = require('expect.js')
const { EventEmitter } = require('events')
const describe = require('mocha').describe
const it = require('mocha').it

const Pool = require('../')

// Minimal client honoring pg-pool's contract; completes each query on nextTick.
class MockClient extends EventEmitter {
  constructor() {
    super()
    this._queryable = true
    this._ending = false
    this.connection = { stream: { destroy() {} } }
  }
  connect(cb) {
    if (cb) process.nextTick(cb, null)
  }
  query(_text, values, cb) {
    const callback = typeof values === 'function' ? values : cb
    process.nextTick(callback, null, { rows: [], rowCount: 0 })
  }
  end(cb) {
    this._ending = true
    if (cb) process.nextTick(cb)
  }
  isConnected() {
    return true
  }
  ref() {}
  unref() {}
}

describe('pending-queue O(1) dequeue + lazy compaction', () => {
  it('preserves FIFO order and waitingCount across a slice-compaction of a deep queue', async () => {
    const pool = new Pool({ max: 1, Client: MockClient, idleTimeoutMillis: 0 })
    const N = 140 // > 2*64, so _pendingHead crosses the slice threshold while draining

    const order = []
    let maxHead = 0
    const queries = []
    for (let i = 0; i < N; i++) {
      queries.push(
        pool.query('SELECT 1').then(() => {
          order.push(i)
          if (pool._pendingHead > maxHead) maxHead = pool._pendingHead
          // the getter must stay coherent with its backing fields throughout
          expect(pool.waitingCount).to.equal(pool._pendingQueue.length - pool._pendingHead)
          expect(pool.waitingCount >= 0).to.equal(true)
        })
      )
    }

    // a deep queue (well past the 64 compaction threshold) is built synchronously
    expect(pool.waitingCount >= 100).to.equal(true)

    await Promise.all(queries)

    // FIFO preserved end to end despite the mid-drain slice
    expect(order).to.eql(Array.from({ length: N }, (_, i) => i))
    // compaction kept the head bounded — without slicing it would climb toward N
    expect(maxHead < 100).to.equal(true)
    // fully drained -> reset to a clean state
    expect(pool.waitingCount).to.equal(0)
    expect(pool._pendingHead).to.equal(0)
    expect(pool._pendingQueue.length).to.equal(0)

    await pool.end()
  })
})
