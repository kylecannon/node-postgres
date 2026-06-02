'use strict'
// Deterministic, CPU-bound microbenchmark of the real parse + row-build path,
// driven by tinybench for proper warmup/sampling/statistics.
//
// Replays captured server bytes through the Parser and the pg Result builder.
// Usage: node bench/replay-bench.js [pg_type|seq|mixed|all] [array|object|both|parseonly|all]

const fs = require('fs')
const path = require('path')
const { Bench } = require('tinybench')
const { Parser } = require('../dist/parser')
const Result = require('../../pg/lib/result')

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'))

// Mimic packages/pg/lib/query.js dispatch: build a Result per RowDescription
// and parse every DataRow through it.
function makeConsumer(rowMode) {
  let result = null
  let sink = 0
  const cb = (msg) => {
    switch (msg.name) {
      case 'rowDescription':
        result = new Result(rowMode, null)
        result.addFields(msg.fields)
        break
      case 'dataRow': {
        const row = result.parseRow(msg.fields)
        // touch the row so V8 cannot dead-code-eliminate the work
        sink += row.length !== undefined ? row.length : 1
        break
      }
      default:
        break
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
  let offset = 0
  let rows = 0
  while (offset + 5 <= buf.length) {
    const code = buf[offset]
    const len = buf.readUInt32BE(offset + 1)
    if (code === 0x44) rows++
    offset += 1 + len
  }
  return rows
}

function makeTask(buf, mode) {
  // reuse one Parser across iterations (it fully resets after a complete buffer)
  const parser = new Parser()
  const consumer = mode === 'parseonly' ? parseOnlyConsumer() : makeConsumer(mode)
  return () => parser.parse(buf, consumer.cb)
}

const which = process.argv[2] || 'all'
const modeArg = process.argv[3] || 'both'

const fixtureKeys = which === 'all' ? Object.keys(fixtures) : [which]
let modes
if (modeArg === 'both') modes = ['array', 'object']
else if (modeArg === 'all') modes = ['parseonly', 'array', 'object']
else modes = [modeArg]

async function main() {
  for (const key of fixtureKeys) {
    const buf = Buffer.from(fixtures[key], 'base64')
    const rowsPerPass = countRows(buf)
    const bench = new Bench({ time: 1000, warmupTime: 400, warmupIterations: 50 })
    for (const mode of modes) {
      bench.add(`${key}/${mode}`, makeTask(buf, mode))
    }
    await bench.run()
    for (const task of bench.tasks) {
      const r = task.result
      const rowsPerSec = r.hz * rowsPerPass
      const nsPerRow = 1e9 / rowsPerSec
      console.log(
        `${task.name.padEnd(16)} ` +
          `${(rowsPerSec / 1e6).toFixed(3)} Mrows/s  ` +
          `${nsPerRow.toFixed(1)} ns/row  ` +
          `±${r.rme.toFixed(2)}%  (n=${r.samples.length}, ${rowsPerPass} rows/pass)`
      )
    }
    console.log('')
  }
}

main()
