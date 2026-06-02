#!/bin/zsh
# Definitive baseline-vs-optimized A/B across ALL benchmarks, same machine,
# back-to-back. "baseline" = pristine master (every source change stashed).
# Run from repo root with PG env set.
set -e
ROOT=/Volumes/Development/node-postgres
PROTO=$ROOT/packages/pg-protocol
PG=$ROOT/packages/pg
STASH_PATHS=(packages/pg-protocol/src packages/pg/lib/connection.js packages/pg/lib/result.js)

run_suite() {  # $1 = label (opt|base)
  local tag=$1
  (cd $PROTO && npx tsc >/dev/null 2>&1)
  echo "  [$tag] throughput (replay, tinybench)..."
  (cd $PROTO && node bench/replay-bench.js all both 2>&1) > /tmp/ab_${tag}_replay.txt
  echo "  [$tag] GC (gc-bench, object mode)..."
  ( cd $PROTO && BENCH_TARGET_ROWS=3000000 node --expose-gc bench/gc-bench.js seq object 2>&1
    BENCH_TARGET_ROWS=3000000 node --expose-gc bench/gc-bench.js users object 2>&1
    BENCH_TARGET_ROWS=3000000 node --expose-gc bench/gc-bench.js events object 2>&1 ) > /tmp/ab_${tag}_gc.txt
  echo "  [$tag] large-result e2e (500k rows)..."
  (cd $PG && node --expose-gc bench-large-result.js 500000 1000 2>&1) > /tmp/ab_${tag}_large.txt
}

echo "### Measuring OPTIMIZED (working tree) ###"
run_suite opt

echo "### Stashing all source changes -> pristine master ###"
cd $ROOT
git stash push -u -- ${STASH_PATHS[@]} >/dev/null 2>&1
echo "### Measuring BASELINE (master, no improvements) ###"
run_suite base

echo "### Restoring working tree ###"
cd $ROOT
git stash pop >/dev/null 2>&1
(cd $PROTO && npx tsc >/dev/null 2>&1)
rm -f $PROTO/tsconfig.tsbuildinfo

echo ""
echo "================ THROUGHPUT (Mrows/s, baseline -> optimized) ================"
node -e '
const fs=require("fs")
const p=f=>Object.fromEntries(fs.readFileSync(f,"utf8").trim().split("\n").filter(l=>l.includes("Mrows")).map(l=>{const m=l.match(/^(\S+)\s+([\d.]+) Mrows/);return [m[1],parseFloat(m[2])]}))
const b=p("/tmp/ab_base_replay.txt"), o=p("/tmp/ab_opt_replay.txt")
for(const k of Object.keys(o)){const d=(o[k]-b[k])/b[k]*100;console.log(k.padEnd(18),b[k].toFixed(3),"->",o[k].toFixed(3),"  "+(d>=0?"+":"")+d.toFixed(1)+"%")}
'
echo ""
echo "================ GC (object mode, baseline -> optimized) ================"
echo "-- BASELINE --"; cat /tmp/ab_base_gc.txt
echo "-- OPTIMIZED --"; cat /tmp/ab_opt_gc.txt
echo ""
echo "================ LARGE RESULT e2e 500k (baseline vs optimized) ================"
echo "-- BASELINE --"; cat /tmp/ab_base_large.txt
echo "-- OPTIMIZED --"; cat /tmp/ab_opt_large.txt
