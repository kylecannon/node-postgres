#!/bin/zsh
# A/B the real-world pool.query pattern: original master (544b1ce8) vs optimized
# HEAD. Reverts only the source files we changed; moves the new test files aside
# so the original tree builds. Run from repo root with PG env set.
set -e
ROOT=/Volumes/Development/node-postgres
PROTO=$ROOT/packages/pg-protocol
SRC=(
  packages/pg-protocol/src/parser.ts
  packages/pg-protocol/src/buffer-reader.ts
  packages/pg-protocol/src/buffer-writer.ts
  packages/pg-protocol/src/serializer.ts
  packages/pg-protocol/src/messages.ts
  packages/pg-protocol/src/index.ts
  packages/pg/lib/result.js
  packages/pg/lib/connection.js
  packages/pg/lib/type-overrides.js
)
NEWTESTS=($PROTO/src/binary.test.ts $PROTO/src/reuse.test.ts)

bench() {  # $1 label
  (cd $PROTO && rm -f tsconfig.tsbuildinfo && npx tsc >/dev/null 2>&1)
  echo "[$1] rows/q=10 :  $(cd $ROOT/packages/pg && node bench-pool.js 10 40 10 5)"
  echo "[$1] rows/q=100:  $(cd $ROOT/packages/pg && node bench-pool.js 100 40 10 5)"
}

cd $ROOT
echo '### OPTIMIZED (HEAD) ###'
bench OPT

echo '### reverting source to original master (544b1ce8) ###'
mv $NEWTESTS /tmp/ 2>/dev/null || true
git checkout 544b1ce8 -- ${SRC[@]}
echo '### BASELINE (original master) ###'
bench BASE

echo '### restoring HEAD ###'
git checkout HEAD -- ${SRC[@]}
mv /tmp/binary.test.ts /tmp/reuse.test.ts $PROTO/src/ 2>/dev/null || true
(cd $PROTO && rm -f tsconfig.tsbuildinfo && npx tsc >/dev/null 2>&1)
echo "restored; HEAD build OK"
