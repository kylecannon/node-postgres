'use strict'
// Binary-vs-text throughput microbenchmark. Replays captured server bytes (both
// wire formats of the SAME logical rows) through the real Parser + Result path
// under tinybench, and prints rows/sec, ns/row, RME, and the speedup of binary
// relative to text — alongside the bytes-on-wire ratio so you can see the wire
// win next to the CPU win.
//
// Run capture first: node bench/capture-binary-fixtures.js
// Usage: node bench/replay-bench-binary.js [int_heavy|...|all] [array|object|both|parseonly]

const fs = require('fs')
const path = require('path')
const { Bench } = require('tinybench')
const { Parser } = require('../dist/parser')
const Result = require('../../pg/lib/result')

const fxPath = path.join(__dirname, 'binary-fixtures.json')
if (!fs.existsSync(fxPath)) {
  console.error('binary-fixtures.json not found. Run: node bench/capture-binary-fixtures.js')
  process.exit(1)
}
const fixtures = JSON.parse(fs.readFileSync(fxPath, 'utf8'))

function makeConsumer(rowMode) {
  let result = null
  let sink = 0
  const cb = (msg) => {
    if (msg.name === 'rowDescription') {
      result = new Result(rowMode, null)
      result.addFields(msg.fields)
    } else if (msg.name === 'dataRow') {
      const row = result.parseRow(msg.fields)
      // touch the row so V8 cannot dead-code-eliminate the decode work
      sink += row.length !== undefined ? row.length : 1
    }
  }
  return { cb, sink: () => sink }
}

function parseOnlyConsumer() {
  let sink = 0
  const cb = (msg) => {
    if (msg.name === 'dataRow') sink += msg.fieldCount
  }
  return { cb, sink: () => sink }
}

function countRows(buf) {
  let off = 0
  let rows = 0
  while (off + 5 <= buf.length) {
    if (buf[off] === 0x44) rows++
    off += 1 + buf.readUInt32BE(off + 1)
  }
  return rows
}

function makeTask(buf, mode) {
  const parser = new Parser()
  const consumer = mode === 'parseonly' ? parseOnlyConsumer() : makeConsumer(mode)
  return () => parser.parse(buf, consumer.cb)
}

const which = process.argv[2] || 'all'
const modeArg = process.argv[3] || 'object'

const fixtureKeys = which === 'all' ? Object.keys(fixtures) : [which]
let modes
if (modeArg === 'both') modes = ['array', 'object']
else modes = [modeArg]

async function main() {
  console.log(`# binary-vs-text replay  (mode(s): ${modes.join(', ')})\n`)
  for (const key of fixtureKeys) {
    const entry = fixtures[key]
    const meta = entry.meta
    for (const mode of modes) {
      const results = {}
      for (const fmt of ['text', 'binary']) {
        const buf = Buffer.from(entry[fmt], 'base64')
        const rowsPerPass = countRows(buf)
        const bench = new Bench({ time: 1000, warmupTime: 400, warmupIterations: 50 })
        bench.add(`${key}/${fmt}/${mode}`, makeTask(buf, mode))
        await bench.run()
        const r = bench.tasks[0].result
        const rowsPerSec = r.hz * rowsPerPass
        results[fmt] = { rowsPerSec, nsPerRow: 1e9 / rowsPerSec, rme: r.rme, n: r.samples.length, rowsPerPass }
      }
      const t = results.text
      const b = results.binary
      const speedup = b.rowsPerSec / t.rowsPerSec
      console.log(
        `${(key + '/' + mode).padEnd(22)}` +
          `text ${(t.rowsPerSec / 1e6).toFixed(3)} Mrows/s (${t.nsPerRow.toFixed(0)}ns ±${t.rme.toFixed(1)}%)  ` +
          `binary ${(b.rowsPerSec / 1e6).toFixed(3)} Mrows/s (${b.nsPerRow.toFixed(0)}ns ±${b.rme.toFixed(1)}%)  ` +
          `=> binary ${speedup >= 1 ? speedup.toFixed(2) + 'x faster' : (1 / speedup).toFixed(2) + 'x SLOWER'}  ` +
          `wire ${(meta.byteRatio * 100).toFixed(0)}%`
      )
    }
  }
  console.log('\n(wire% = binary DataRow bytes / text DataRow bytes; lower = smaller on the wire)')
}

main()
