'use strict'
// Write-path (outbound serializer) benchmark: throughput + GC for the messages
// a parameterized INSERT/SELECT sends — parse, bind (the hot one; serializes
// param values), execute. Covers varied param types incl. Buffers and nulls.
//
// node [--expose-gc] bench/write-bench.js

const v8 = require('v8')
const { PerformanceObserver } = require('perf_hooks')
const { Bench } = require('tinybench')
const { serialize } = require('../dist/serializer')
// pg converts JS values (numbers/bools/dates/...) to wire strings via this mapper
// before the serializer sees them, so the realistic bind cost includes it.
const { prepareValue } = require('../../pg/lib/utils')

const smallParams = ['brian', 100]
const wideParams = [
  'a-medium-length-string-value-here',
  12345,
  true,
  null,
  '2024-01-02T03:04:05.000Z',
  3.14159,
  'another text column',
  null,
  'user@example.com',
  98765,
]
const bufParams = ['name', Buffer.allocUnsafe(256)]
const unicodeParams = ['héllo wörld 中文 emoji', 42]

const cases = {
  'parse(insert)': () => serialize.parse({ text: 'INSERT INTO foobar(name, age) VALUES ($1, $2)' }),
  'bind(2 small)': () => serialize.bind({ values: smallParams, valueMapper: prepareValue }),
  'bind(10 mixed)': () => serialize.bind({ values: wideParams, valueMapper: prepareValue }),
  'bind(buffer 256B)': () => serialize.bind({ values: bufParams, valueMapper: prepareValue }),
  'bind(unicode)': () => serialize.bind({ values: unicodeParams, valueMapper: prepareValue }),
  execute: () => serialize.execute({}),
  'full insert seq': () => {
    serialize.parse({ text: 'INSERT INTO foobar(name, age) VALUES ($1, $2)', name: 's1' })
    serialize.bind({ statement: 's1', values: smallParams, valueMapper: prepareValue })
    serialize.execute({})
  },
}

async function throughput() {
  const bench = new Bench({ time: 1000, warmupTime: 300 })
  for (const [name, fn] of Object.entries(cases)) bench.add(name, fn)
  await bench.run()
  console.log('--- throughput ---')
  for (const t of bench.tasks) {
    if (!t.result || t.result.error) {
      console.log(`${t.name.padEnd(20)} ERROR: ${t.result && t.result.error}`)
      continue
    }
    console.log(`${t.name.padEnd(20)} ${(t.result.hz / 1e6).toFixed(2)} Mops/s  ${(1e9 / t.result.hz).toFixed(0)} ns/op  ±${t.result.rme.toFixed(2)}%`)
  }
}

function gc() {
  if (!global.gc) {
    console.log('\n(run with --expose-gc for GC stats)')
    return
  }
  console.log('\n--- GC (5M bind(10 mixed) ops) ---')
  let scav = 0
  let pause = 0
  const obs = new PerformanceObserver((l) => {
    for (const e of l.getEntries()) {
      scav++
      pause += e.duration
    }
  })
  obs.observe({ entryTypes: ['gc'] })
  for (let i = 0; i < 100000; i++) serialize.bind({ values: wideParams, valueMapper: prepareValue })
  global.gc()
  const N = 5000000
  const t0 = performance.now()
  for (let i = 0; i < N; i++) serialize.bind({ values: wideParams, valueMapper: prepareValue })
  const wall = performance.now() - t0
  return new Promise((r) =>
    setTimeout(() => {
      obs.disconnect()
      console.log(`${N} ops in ${wall.toFixed(0)}ms | GC ${scav}, pause ${pause.toFixed(1)}ms | ${((pause / N) * 1e6).toFixed(1)} ns GC/op`)
      r()
    }, 50)
  )
}

;(async () => {
  await throughput()
  await gc()
})()
