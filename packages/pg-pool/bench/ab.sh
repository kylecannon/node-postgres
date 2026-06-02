#!/bin/zsh
# Alternating-sample A/B for the pg-pool micro-bench: master index.js vs the
# working-tree index.js. Alternating (opt, base, opt, base, ...) cancels thermal
# drift, which otherwise swamps a ~5-10% effect on a laptop. Run from repo root.
#   zsh packages/pg-pool/bench/ab.sh [concurrency] [seconds] [rounds]
set -e
DIR=/Volumes/Development/node-postgres/packages/pg-pool
CONC=${1:-200}
SECS=${2:-4}
ROUNDS=${3:-6}

cp $DIR/index.js /tmp/pgpool-opt.js
git -C $DIR show "$(git -C $DIR merge-base HEAD master):packages/pg-pool/index.js" > /tmp/pgpool-base.js
restore() { cp /tmp/pgpool-opt.js $DIR/index.js; }
trap restore EXIT

q() { node --expose-gc $DIR/bench/pool-micro.js $CONC $SECS 2>&1 | grep -oE 'qps [0-9]+' | grep -oE '[0-9]+'; }

echo "alternating A/B  conc=$CONC secs=$SECS rounds=$ROUNDS  (optimized vs master)"
sumo=0; sumb=0
for r in $(seq 1 $ROUNDS); do
  cp /tmp/pgpool-opt.js  $DIR/index.js; O=$(q)
  cp /tmp/pgpool-base.js $DIR/index.js; B=$(q)
  D=$(echo "scale=1; ($O-$B)*100/$B" | bc)
  echo "  round $r: opt=$O base=$B  +$D%"
  sumo=$((sumo+O)); sumb=$((sumb+B))
done
echo "  mean: opt=$((sumo/ROUNDS)) base=$((sumb/ROUNDS))  +$(echo "scale=1; ($sumo-$sumb)*100/$sumb" | bc)%"
