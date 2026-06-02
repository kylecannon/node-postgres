'use strict'
// Isolates the Result row-builder cost (no protocol parsing) to compare:
//   - compiled builders (the normal path; also the prepared-stmt cache-hit path)
//   - interpreted fallback (canCompile=false, e.g. Cloudflare Workers, or a
//     "__proto__" column) — forced by nulling the compiled builder.
// Also measures addFields cost: cold compile vs object-builder cache hit.
//
// node bench/result-bench.js [fixture]

const fs = require('fs')
const path = require('path')
const { Bench } = require('tinybench')
const { Parser } = require('../dist/parser')
const Result = require('../../pg/lib/result')

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures.json'), 'utf8'))

// Parse a fixture once to extract its row-description fields + the raw string[]
// rows, so we can replay JUST the row-building step.
function extract(buf) {
  let fieldDescs = null
  const rows = []
  const parser = new Parser()
  parser.parse(buf, (msg) => {
    if (msg.name === 'rowDescription') fieldDescs = msg.fields
    else if (msg.name === 'dataRow') rows.push(msg.fields.slice())
  })
  return { fieldDescs, rows }
}

function buildResult(rowMode, fieldDescs, interpreted) {
  const r = new Result(rowMode, null)
  r.addFields(fieldDescs)
  if (interpreted) r._rowBuilder = null // simulate no-codegen / fallback path
  return r
}

const key = process.argv[2] || 'users'
const buf = Buffer.from(fixtures[key], 'base64')
const { fieldDescs, rows } = extract(buf)

async function main() {
  console.log(`fixture=${key}  cols=${fieldDescs.length}  rows=${rows.length}\n`)

  for (const mode of ['array', 'object']) {
    const compiled = buildResult(mode, fieldDescs, false)
    const interp = buildResult(mode, fieldDescs, true)
    const bench = new Bench({ time: 1000, warmupTime: 300 })
    bench
      .add(`${mode} compiled`, () => {
        let s = 0
        for (let i = 0; i < rows.length; i++) s += compiled.parseRow(rows[i]).length
        return s
      })
      .add(`${mode} interpreted(fallback)`, () => {
        let s = 0
        for (let i = 0; i < rows.length; i++) s += interp.parseRow(rows[i]).length
        return s
      })
    await bench.run()
    for (const t of bench.tasks) {
      const rps = t.result.hz * rows.length
      console.log(
        `${t.name.padEnd(26)} ${(rps / 1e6).toFixed(3)} Mrows/s  ${(1e9 / rps).toFixed(1)} ns/row  ±${t.result.rme.toFixed(2)}%`
      )
    }
    console.log('')
  }

  // addFields: cold compile (unique shape) vs object-builder cache hit (same shape)
  const ab = new Bench({ time: 800, warmupTime: 200 })
  ab.add('addFields cache-hit (same shape)', () => {
    const r = new Result(null, null)
    r.addFields(fieldDescs)
  })
  await ab.run()
  for (const t of ab.tasks) {
    console.log(`${t.name.padEnd(34)} ${(t.result.hz / 1e3).toFixed(1)}k ops/s  ${(t.result.mean * 1e3).toFixed(2)} us/op  ±${t.result.rme.toFixed(2)}%`)
  }
}

main()
