#!/bin/zsh
# Commit-based A/B: original base code (the branch point with master) vs the
# optimized HEAD, across the full bench suite. Reverts only the shipping source
# files our branch changed, runs the suite, then restores HEAD. A trap restores
# HEAD even on error so the tree is never left reverted. Run from repo root.
#
# NOTE: this is PHASE-SEPARATED (all-optimized, then all-base). On a thermally
# noisy laptop that can distort a small (<~10%) delta by a few points — trust it
# for direction and big effects. For accurate small deltas use ALTERNATING
# sampling (opt, base, opt, base, …) as in packages/pg-pool/bench/ab.sh; the
# numbers in BENCHMARKS.md were re-verified that way.
set -e
ROOT=/Volumes/Development/node-postgres
PROTO=$ROOT/packages/pg-protocol
PG=$ROOT/packages/pg
cd $ROOT

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "working tree has uncommitted tracked changes — commit/stash them first." >&2
  exit 1
fi

BASE=$(git merge-base HEAD master)
echo "BASE (original) = $BASE   OPTIMIZED = $(git rev-parse --short HEAD)"

# shipping source files our branch changed (exclude bench scripts + test files)
SRC=($(git diff --name-only $BASE HEAD -- packages/pg-protocol/src packages/pg/lib ':!*.test.ts'))
TMP=$(mktemp -d)

restore() {
  git checkout -q HEAD -- ${SRC[@]} 2>/dev/null || true
  mv $TMP/*.test.ts $PROTO/src/ 2>/dev/null || true
  (cd $PROTO && rm -f tsconfig.tsbuildinfo && npx tsc >/dev/null 2>&1) || true
}
trap restore EXIT

suite() {  # $1 = label
  local t=$1
  (cd $PROTO && rm -f tsconfig.tsbuildinfo && npx tsc >/dev/null 2>&1)
  (cd $PROTO && node bench/replay-bench.js all both) >/tmp/ab_${t}_replay.txt 2>&1
  ( cd $PROTO
    BENCH_TARGET_ROWS=3000000 node --expose-gc bench/gc-bench.js seq object
    BENCH_TARGET_ROWS=3000000 node --expose-gc bench/gc-bench.js users object
    BENCH_TARGET_ROWS=3000000 node --expose-gc bench/gc-bench.js mixed object ) >/tmp/ab_${t}_gc.txt 2>&1
  (cd $PG && node bench-pool.js 100 40 10 5) >/tmp/ab_${t}_pool.txt 2>&1
  (cd $PG && node bench-loop-lag.js 1000000) >/tmp/ab_${t}_loop.txt 2>&1
  (cd $PROTO && node bench/write-bench.js) >/tmp/ab_${t}_write.txt 2>&1
}

echo "### measuring OPTIMIZED (HEAD) ###"
suite opt

echo "### reverting source to BASE ###"
mv $PROTO/src/*.test.ts $TMP/ 2>/dev/null || true   # tests reference new APIs; set aside
git checkout -q $BASE -- ${SRC[@]}
echo "### measuring BASELINE (original code) ###"
suite base

restore
trap - EXIT
echo "### restored HEAD ###"

echo ""
echo "================ PARSE THROUGHPUT — Mrows/s (base -> optimized) ================"
node -e '
const fs=require("fs")
const p=f=>Object.fromEntries(fs.readFileSync(f,"utf8").trim().split("\n").filter(l=>l.includes("Mrows")).map(l=>{const m=l.match(/^(\S+)\s+([\d.]+) Mrows/);return [m[1],parseFloat(m[2])]}))
const b=p("/tmp/ab_base_replay.txt"), o=p("/tmp/ab_opt_replay.txt")
for(const k of Object.keys(o)){const d=(o[k]-b[k])/b[k]*100;console.log(k.padEnd(18),b[k].toFixed(3).padStart(7),"->",o[k].toFixed(3).padStart(7),"  "+(d>=0?"+":"")+d.toFixed(1)+"%")}
'
echo ""
echo "================ GC (object mode, 3M rows) ================"
echo "-- BASELINE --"; cat /tmp/ab_base_gc.txt
echo "-- OPTIMIZED --"; cat /tmp/ab_opt_gc.txt
echo ""
echo "================ REAL-WORLD POOL (100-row list query) ================"
echo "BASELINE : $(cat /tmp/ab_base_pool.txt)"
echo "OPTIMIZED: $(cat /tmp/ab_opt_pool.txt)"
echo ""
echo "================ EVENT-LOOP LAG (1M-row result, lower = better) ================"
echo "BASELINE : $(cat /tmp/ab_base_loop.txt)"
echo "OPTIMIZED: $(cat /tmp/ab_opt_loop.txt)"
echo ""
echo "================ WRITE PATH (bind) ================"
echo "-- BASELINE --";  grep -E "bind|full" /tmp/ab_base_write.txt
echo "-- OPTIMIZED --"; grep -E "bind|full" /tmp/ab_opt_write.txt
