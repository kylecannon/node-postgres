'use strict'
// Feeds a captured big-field response through the Parser in realistic ~64KB
// socket chunks, so the multi-MB-per-row reassembly path (mergeBuffer) is
// exercised. Parser-only consumer isolates reassembly + utf8 decode cost from
// the (separate, unavoidable) JSON.parse done by the type parser.
const fs = require('fs')
const { Parser } = require('../dist/parser')

const buf = fs.readFileSync('/tmp/bigfields.bin')
const CHUNK = parseInt(process.env.CHUNK || '65536', 10)
const chunks = []
for (let i = 0; i < buf.length; i += CHUNK) chunks.push(buf.subarray(i, i + CHUNK))

function onePass() {
  const parser = new Parser()
  parser.reuseObjects = true
  let n = 0
  const cb = (m) => {
    if (m.name === 'dataRow') n += m.fieldCount
  }
  for (const c of chunks) parser.parse(c, cb)
  return n
}

// warmup
let w = performance.now() + 500
while (performance.now() < w) onePass()

const samples = []
for (let s = 0; s < 9; s++) {
  let passes = 0
  const start = performance.now()
  const end = start + 600
  do {
    onePass()
    passes++
  } while (performance.now() < end)
  const mb = (passes * buf.length) / 1e6
  samples.push(mb / ((performance.now() - start) / 1000))
}
samples.sort((a, b) => a - b)
console.log(`mergeBuffer+decode: ${samples[samples.length >> 1].toFixed(0)} MB/s  (${chunks.length} chunks of ${(CHUNK / 1024) | 0}KB, ${(buf.length / 1e6).toFixed(1)}MB)`)
