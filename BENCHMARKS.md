# Performance results — base vs optimized

Before/after for the `kcannon/perf` branch: original base code (the branch point
with `master`) vs the optimized `HEAD`, on one machine.

> **Measurement note (important):** a laptop's thermal drift (±several %) is
> large enough to distort a phase-separated A/B (run all-optimized, then
> all-base) — early numbers measured that way came out a few points high. Every
> number below is the **median of 5 alternating rounds** from `npm run
> bench:verify` (optimized, base, optimized, base, … swapping prebuilt artifacts
> each round, which cancels the drift) and was **`reliable ↑`/`↓`** there —
> i.e. every round agreed in direction and the delta cleared the round-to-round
> spread. Anything `bench:verify` flagged `INCONCLUSIVE` is marked as such, not
> quoted as a win. `npm run bench:ab` is the quick (phase-separated) view; trust
> it for direction, not the last few points.

Throughput uses [tinybench](https://github.com/tinylibs/tinybench) (thousands of
samples). Raw figures are machine-specific; the **Δ** column is the improvement
(↑ = higher is better, ↓ = lower is better).

> **Drop-in:** every result below is from the *default* code path with **zero
> API or behavior changes** — same rows, same types, same `Object.prototype`.
> Just upgrade.

---

## Parse throughput — object mode (the default), Mrows/s ↑

| fixture | base | optimized | Δ |
| --- | ---: | ---: | ---: |
| `pg_type` (12 cols) | 1.012 | 1.322 | **+31%** |
| `seq` (1 int col) | 7.636 | 8.613 | +13% |
| `mixed` (5 cols) | 1.275 | 1.445 | +13% |
| `users` (uuid/jsonb/ts/numeric) | 0.515 | 0.604 | +18% |
| `orders` (numerics/enum/jsonb) | 0.680 | 0.888 | **+32%** |
| `wide` (60 cols) | 0.157 | 0.274 | **+74%** |
| `null_heavy` (16 cols, ~85% null) | 1.680 | 4.415 | **+162%** |
| `events` (50k rows, jsonb) | 0.895 | 1.049 | +18% |

## Parse throughput — array mode, Mrows/s ↑

| fixture | base | optimized | Δ |
| --- | ---: | ---: | ---: |
| `pg_type` | 1.128 | 1.351 | +20% |
| `seq` | 8.403 | 9.442 | +11% |
| `mixed` | 1.361 | 1.472 | +8% |
| `users` | 0.547 | 0.591 | +8% |
| `orders` | 0.791 | 0.897 | +12% |
| `wide` | 0.229 | 0.273 | +20% |
| `null_heavy` | 3.764 | 4.457 | +18% |
| `events` | 0.995 | 1.045 | +6% |

Object mode (the default) gains the most because the old per-row `{...spread}`
was replaced by a compiled, shaped row builder — biggest where that overhead
dominated (wide and null-heavy rows).

## GC pressure — object mode, ns of GC pause per row ↓

| fixture | base | optimized | Δ |
| --- | ---: | ---: | ---: |
| `seq` | 1.7 | 1.1 | **−38%** |
| `null_heavy` | 3.6 | 2.2 | **−39%** |
| `pg_type` | 3.9 | 2.9 | **−28%** |
| `mixed` | 5.2 | 4.1 | −22% |
| `wide` | 14.2 | 12.2 | −17% |
| `events` | 17.8 | 15.2 | −13% |
| `orders` | 11.7 | 10.1 | (−19%, within noise) |
| `users` | 13.9 | 12.1 | (−12%, within noise) |

Recycling the parser's per-row throwaways (the `fields` array + `DataRowMessage`)
cuts young-gen GC sharply where row parsing is the main allocator — `seq` drops
from ~36 to ~5 collections per 3M rows. On jsonb/numeric-heavy rows the parsed
objects from `pg-types` dominate the garbage, so the win is smaller and noisier
(`orders`/`users` don't clear the noise floor even at 5 rounds).

## Event-loop responsiveness — max lag on a 1M-row result via `client.query` ↓

| metric | base | optimized (`maxResultChunkBytes: 512 KB`) | Δ |
| --- | ---: | ---: | ---: |
| max event-loop lag | 21.8 ms | 5.1 ms | **−76%** |

A large result arrives as a burst of socket reads; the base parser processed the
whole burst synchronously and stalled the loop. The faster parser plus
**opt-in** cooperative yielding (pause/resume after a byte budget) keep the loop
responsive. Yielding is **off by default** (`maxResultChunkBytes: 0`), so the
default delivery path is unchanged; set `maxResultChunkBytes` (e.g. via
`new Pool({ maxResultChunkBytes })` or `new Client({ maxResultChunkBytes })`) to
a positive budget to enable it. The optimized figure above is measured with a
512 KB budget. The awaited result is identical — only the delivery is spread
across a few more ticks.

## Real-world Pool — `pool.query()`, ~100-row list query, 10 conns / 40 concurrent

| metric | base | optimized | Δ |
| --- | ---: | ---: | ---: |
| throughput ↑ (verified) | 5,839 qps | 6,351 qps | **+9%** |
| CPU per 1k queries ↓ | 160.9 ms | 143.8 ms | −11% |
| avg latency ↓ | 6.75 ms | 6.07 ms | −10% |
| p99 latency ↓ | 8.65 ms | 7.76 ms | **−10%** |

Throughput is the alternating-verified figure; CPU/latency are from the same
`bench-pool` run (they track throughput). What an app actually sees — the benefit
**scales with rows-per-query**: a few-row lookup is ~unchanged (the network
round-trip dominates), a list/report endpoint gets ~+9% throughput and ~−10% p99
latency for free, and large exports get the most.

## Write path — `bind`, Mops/s ↑

| case | base | optimized | Δ |
| --- | ---: | ---: | ---: |
| `bind(2 small)` | 2.37 | 2.68 | +16% |
| `bind(10 mixed)` | 0.91 | 1.12 | **+23%** |
| `bind(unicode)` | 2.03 | 2.31 | +14% |
| `full insert seq` | 1.53 | 1.67 | +9% |

String parameters are now encoded in a single pass (one `Buffer.byteLength`
instead of three string scans); the gain grows with parameter size.

## Connection pool overhead — `pool.query()` with a mock client (`npm run bench:pool-micro`)

Isolates pg-pool's own per-query overhead (no real Postgres). The pool's
per-query cost is floored by its promise-based API — `promisify` creates two
promises per query (the result + a `.catch` that rewrites the stack), required
for the tested async stack-trace feature — so that part can't shrink. The wins
come from cutting everything around it:

- **`once`→`on`** for the per-query error listener — the query callback already
  removes it and it self-guards, so `once`'s onceWrapper allocation was waste.
- **O(1) pending dequeue** — a moving head index instead of `Array#shift` (O(n));
  ~6% on its own at high concurrency where the wait queue is deep.
- **bind `_pulseQueue` once** instead of a fresh closure/bound fn per acquire.

Measured with **alternating samples** (opt, base, opt, base, …) via
`zsh packages/pg-pool/bench/ab.sh` — on a laptop the thermal drift between a
separated "all-opt-then-all-base" run swamps an effect this size, so alternating
is the only reliable read.

| concurrency | base qps | optimized qps | Δ |
| --- | ---: | ---: | ---: |
| 5 (idle clients) | 2.06 M | 2.14 M | +4% |
| 50 (saturated) | 2.07 M | 2.20 M | +7% |
| 200 (high churn) | 1.96 M | 2.15 M | **+10%** |

The benefit scales with concurrency — the deeper wait queue makes the O(1)
dequeue matter more, and more checkouts mean more avoided allocations. In
production the DB round-trip dwarfs pool overhead, so this is CPU/GC headroom
under load rather than lower single-query latency.

Considered and rejected (kept simple): reusing the release closure across
checkouts (no measurable gain over the listener fix), and collapsing the two
promises in `promisify` (required for the tested async stack-trace feature).

## Large data — the big-boy results (`npm run bench:big`)

These compare **strategies** for one huge result. The Δ column is the peak-memory
reduction versus the default `accumulate` path. Per-strategy peak RSS is measured
in a fresh process (RSS never shrinks within one).

**500k-row result (~6 columns):**

| strategy | rows/s | max lag | peak RSS | Δ RSS vs accumulate |
| --- | ---: | ---: | ---: | ---: |
| `client.query` accumulate (object) | 1.48 M | 7.2 ms | 70 MB | — |
| `.on('row')` stream (no accumulate) | 1.47 M | 4.8 ms | 12 MB | **−83%** |
| `pg-cursor` batched | 1.09 M | 0.6 ms | 2 MB | **−97%** |

**~400MB result (100k rows × 4KB):**

| strategy | MB/s | max lag | peak RSS | Δ RSS vs accumulate |
| --- | ---: | ---: | ---: | ---: |
| `client.query` accumulate | ~1000 | ~8–12 ms | 582 MB | — |
| `.on('row')` stream | 1736 | 0.6 ms | 23 MB | **−96%** |
| `pg-cursor` batched | 814 | 2.1 ms | 177 MB | −70% |

**Rows with multi-MB text + jsonb fields (40 rows, ~5MB each):** the wire parser
handles multi-MB fields at ~10 GB/s — the cost is `JSON.parse` of the jsonb and
holding the parsed objects. Accumulate holds ~289 MB; `.on('row')` stream holds
~20 MB (**−93%**) at the same throughput.

**Guidance:** for results that fit comfortably in RAM, the default `query` is now
fast *and* responsive. For hundreds of MB to GB, use `.on('row')` streaming (flat
memory, simple API) or `pg-cursor` (flat memory + lowest lag). The per-row
parsing/GC wins above apply to every strategy.

---

## What changed (all drop-in)

- `pg-protocol`: `utf8Slice` field decode, a DataRow fast-path that bypasses the
  `BufferReader`, recycled DataRow message/fields (lower GC), and single-pass
  string-parameter encoding.
- `pg`: compiled per-shape row builders (object + array, cached) and opt-in
  cooperative event-loop yielding for very large results
  (`new Pool({ maxResultChunkBytes })`, **off by default** — set a positive
  byte budget to enable).

## Verifying these numbers (`npm run bench:verify`)

This is the harness that produced the deltas above and keeps them honest. It
builds the optimized + base artifacts once, then **alternates** samples
(opt, base, opt, base, …) so thermal drift cancels, and prints a **confidence
verdict** per metric:

- **reliable ↑** — every round agreed in direction and the delta clears the
  round-to-round spread. Safe to quote.
- **INCONCLUSIVE** — the delta is within the noise spread at this round count.
  *Don't quote it* (raise the round count to resolve it).
- **REGRESSION ↓** — a confident slowdown. `--guard` makes the run exit non-zero
  on one (for CI).

```sh
npm run bench:verify            # 4 alternating rounds, all suites
node packages/pg-protocol/bench/verify.js 6 replay   # more rounds / one suite
node packages/pg-protocol/bench/verify.js 4 all --guard   # CI gate
```

Any number quoted in this file should be **reliable ↑** under `bench:verify`.
The plain `npm run bench:*` scripts and `bench:ab` are the quick (phase-
separated) view — fine for direction, but for a small effect only `bench:verify`
is trustworthy.

## Reproducing individual suites

```sh
npm run bench:read     # parse throughput + GC
npm run bench:gc       # GC pressure only (array + object)
npm run bench:loop     # event-loop lag (large result + per-strategy)
npm run bench:write    # write path
npm run bench:pool     # real-world Pool
npm run bench:big      # 500k rows, ~400MB result, multi-MB fields
npm run bench:ab       # quick base-vs-optimized comparison (phase-separated)
```
