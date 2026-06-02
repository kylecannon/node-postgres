#!/bin/zsh
# A/B benchmark: pristine master (baseline) vs working tree (optimized),
# using the same tinybench harness. Run from repo root.
set -e
ROOT=/Volumes/Development/node-postgres
PROTO=$ROOT/packages/pg-protocol
cd $PROTO

echo "### OPTIMIZED (working tree) ###"
npx tsc >/dev/null 2>&1
node bench/replay-bench.js all all | tee /tmp/pg_opt.txt

echo ""
echo "### stashing to measure BASELINE ###"
cd $ROOT
git stash push -- packages/pg-protocol/src packages/pg/lib/result.js >/dev/null 2>&1
cd $PROTO
npx tsc >/dev/null 2>&1
echo "### BASELINE (master) ###"
node bench/replay-bench.js all all | tee /tmp/pg_base.txt

echo ""
echo "### restoring working tree ###"
cd $ROOT
git stash pop >/dev/null 2>&1
cd $PROTO
npx tsc >/dev/null 2>&1

echo ""
echo "### DELTA (baseline -> optimized) ###"
node -e '
const fs=require("fs")
const parse=(f)=>Object.fromEntries(fs.readFileSync(f,"utf8").trim().split("\n").filter(l=>l.includes("Mrows")).map(l=>{const m=l.match(/^(\S+)\s+([\d.]+) Mrows/);return [m[1],parseFloat(m[2])]}))
const base=parse("/tmp/pg_base.txt"), opt=parse("/tmp/pg_opt.txt")
for(const k of Object.keys(opt)){const b=base[k],o=opt[k];const d=((o-b)/b*100);console.log(k.padEnd(16),b.toFixed(3),"->",o.toFixed(3),"Mrows/s  ",(d>=0?"+":"")+d.toFixed(1)+"%")}
'
