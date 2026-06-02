#!/usr/bin/env node
'use strict'
// One entry point for every benchmark. Handles the annoying parts for you:
//   - builds pg-protocol (the micro-benches use the compiled dist)
//   - captures fixtures on demand (only if missing)
//   - passes --expose-gc / --max-old-space-size where needed
//   - defaults the DB connection (override with PG* env vars)
//
//   node bench/run.js <command> [args]
//   (or from repo root: npm run bench:<command>)
const { spawnSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const BENCH = __dirname // packages/pg-protocol/bench
const PROTO = path.join(BENCH, '..') // packages/pg-protocol
const PG = path.join(BENCH, '../../pg') // packages/pg
const ROOT = path.join(BENCH, '../../..') // repo root

// Default the DB connection so nobody has to remember the env vars.
const env = { ...process.env }
if (!env.PGHOST) {
  Object.assign(env, { PGHOST: '127.0.0.1', PGPORT: '54399', PGUSER: 'user', PGDATABASE: 'data', PGTESTNOSSL: 'true' })
}

const run = (cmd, args, opts = {}) => {
  const r = spawnSync(cmd, args, { stdio: 'inherit', env, ...opts })
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} exited with ${r.status}`)
  }
}
const node = (args, cwd) => run(process.execPath, args, { cwd })

const b = (...p) => path.join(BENCH, ...p)
const pg = (...p) => path.join(PG, ...p)

function build() {
  process.stderr.write('• building pg-protocol… ')
  fs.rmSync(path.join(PROTO, 'tsconfig.tsbuildinfo'), { force: true })
  const r = spawnSync('npx', ['tsc'], { cwd: PROTO, env, stdio: ['ignore', 'ignore', 'inherit'] })
  if (r.status !== 0) throw new Error('pg-protocol build failed')
  process.stderr.write('done\n')
}

function ensureFixtures(file, captureScript) {
  if (fs.existsSync(b(file))) return
  process.stderr.write(`• capturing ${file} (needs Postgres at ${env.PGHOST}:${env.PGPORT})…\n`)
  try {
    node([b(captureScript)], PROTO)
  } catch (e) {
    console.error(
      '\nCapture failed — is Postgres reachable? Start a throwaway one with:\n' +
        '  docker run -d --rm --name npg-bench -p 54399:5432 \\\n' +
        '    -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_USER=user -e POSTGRES_DB=data postgres:14\n' +
        '(or point PGHOST/PGPORT/PGUSER/PGDATABASE at your own).\n'
    )
    throw e
  }
}

const commands = {
  read() {
    ensureFixtures('fixtures.json', 'capture-fixtures.js')
    console.log('\n=== parse throughput (tinybench) ===')
    node([b('replay-bench.js'), 'all', 'both'], PROTO)
    console.log('\n=== GC pressure ===')
    node(['--expose-gc', b('gc-bench.js'), 'all', 'object'], PROTO)
  },
  write() {
    console.log('\n=== serializer / write-path ===')
    node(['--expose-gc', b('write-bench.js')], PROTO)
  },
  gc() {
    ensureFixtures('fixtures.json', 'capture-fixtures.js')
    console.log('\n=== GC pressure: array mode (collections, pause, ns-GC/row) ===')
    node(['--expose-gc', b('gc-bench.js'), 'all', 'array'], PROTO)
    console.log('\n=== GC pressure: object mode ===')
    node(['--expose-gc', b('gc-bench.js'), 'all', 'object'], PROTO)
  },
  loop() {
    console.log('\n=== event-loop lag: 1M-row result via plain client.query (lower = better) ===')
    node([pg('bench-loop-lag.js'), '1000000'], PG)
    console.log('\n=== event-loop lag by strategy: accumulate vs stream vs cursor ===')
    node(['--expose-gc', pg('bench-large-result.js'), '500000', '1000'], PG)
  },
  pool(args) {
    console.log('\n=== real-world Pool + pool.query() ===')
    node([pg('bench-pool.js'), ...(args.length ? args : ['100', '40', '10', '5'])], PG)
  },
  e2e(args) {
    console.log('\n=== large-result strategies (accumulate / stream / cursor) ===')
    node(['--expose-gc', pg('bench-large-result.js'), ...(args.length ? args : ['500000', '1000'])], PG)
  },
  ab() {
    console.log('\n=== baseline (master) vs optimized A/B ===')
    run('zsh', [b('full-ab.sh')], { cwd: ROOT })
  },
  big() {
    // the "big boy" large-data scenarios: hundreds of thousands of rows, a
    // ~400MB result, and rows with multi-MB text/jsonb fields.
    console.log('\n=== 500k-row result: accumulate vs stream vs cursor ===')
    node(['--expose-gc', pg('bench-large-result.js'), '500000', '1000'], PG)
    console.log('\n=== ~400MB result: throughput, peak memory, event-loop lag ===')
    node(['--expose-gc', '--max-old-space-size=4096', pg('bench-400mb.js'), '100000', '4000'], PG)
    console.log('\n=== rows with multi-MB text + jsonb fields ===')
    node(['--expose-gc', '--max-old-space-size=4096', pg('bench-big-fields.js'), '40'], PG)
  },
  guard(args) {
    ensureFixtures('fixtures.json', 'capture-fixtures.js')
    node([b('regression-guard.js'), ...args], PROTO)
  },
  capture() {
    node([b('capture-fixtures.js')], PROTO)
  },
  all() {
    this.read()
    this.write()
    this.gc()
    this.loop()
    this.pool([])
  },
}

const help = `node bench/run.js <command> [args]   (or: npm run bench:<command>)

  read      parse throughput + GC (deterministic microbench)
  write     serializer / write-path throughput + GC
  gc        GC pressure only — array + object, all fixtures
  loop      event-loop lag — large result + per-strategy (accumulate/stream/cursor)
  pool      real-world Pool + pool.query()   [rows conc poolMax secs]
  e2e       large-result strategies: accumulate vs stream vs cursor   [rows batch]
  big       big-data scenarios: 500k rows, ~400MB result, multi-MB text/jsonb fields
  ab        baseline (master) vs optimized A/B  (throughput, GC, lag, pool, write)
  guard     regression guard   (--update to (re)snapshot the baseline)
  capture   (re)capture all fixtures
  all       read + write + gc + loop + pool

Auto-builds pg-protocol and captures fixtures as needed. DB defaults to
127.0.0.1:54399 (user/data, trust) — override with PGHOST/PGPORT/PGUSER/PGDATABASE.`

function main() {
  const [cmd, ...args] = process.argv.slice(2)
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(help)
    return
  }
  if (!commands[cmd]) {
    console.error(`unknown command: ${cmd}\n\n${help}`)
    process.exit(1)
  }
  build()
  commands[cmd](args)
}

main()
