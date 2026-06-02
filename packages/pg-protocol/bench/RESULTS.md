# Performance results — base vs optimized

Before/after for the `kcannon/perf` branch: original base code (the branch point
with `master`) vs the optimized `HEAD`. All numbers are a **controlled,
back-to-back A/B on one machine** — the harness reverts the changed shipping
source to the base commit, runs the suite, restores `HEAD`, and runs it again.

Reproduce the whole thing with one command (from the repo root):

```sh
npm run bench:ab
```

Throughput uses [tinybench](https://github.com/tinylibs/tinybench) (thousands of
samples, relative margin of error shown). Numbers are representative, not
absolute — a laptop is thermally noisy, so only the back-to-back deltas are
meaningful, not the raw figures.

> **Drop-in:** every result below is from the *default* code path with **zero
> API or behavior changes** — same rows, same types, same `Object.prototype`.
> Just upgrade. (Binary mode is the one opt-in piece — see
> [`BINARY.md`](./BINARY.md).)

---

## Parse throughput — Mrows/s (base → optimized)

| fixture | array | object (default) |
| --- | --- | --- |
| `pg_type` (12 cols) | 1.129 → 1.346 (+19%) | 1.008 → 1.330 (**+32%**) |
| `seq` (1 int col) | 8.227 → 9.343 (+14%) | 7.703 → 9.495 (+23%) |
| `mixed` (5 cols) | 1.358 → 1.492 (+10%) | 1.266 → 1.480 (+17%) |
| `users` (uuid/jsonb/ts/numeric) | 0.547 → 0.599 (+10%) | 0.513 → 0.614 (+20%) |
| `orders` (numerics/enum/jsonb) | 0.793 → 0.889 (+12%) | 0.681 → 0.882 (**+30%**) |
| `wide` (60 cols) | 0.226 → 0.271 (+20%) | 0.156 → 0.271 (**+74%**) |
| `null_heavy` (16 cols, ~85% null) | 3.763 → 4.482 (+19%) | 1.668 → 4.665 (**+180%**) |
| `events` (50k rows, jsonb) | 0.993 → 1.060 (+7%) | 0.890 → 1.060 (+19%) |

Object mode (the default) gains the most because the old per-row `{...spread}`
was replaced by a compiled, shaped row builder. The win is largest where that
overhead dominated: wide rows and null-heavy rows.

## GC pressure — object mode, 3M rows (base → optimized)

| fixture | GC collections | total pause |
| --- | --- | --- |
| `seq` | 36 → **5** | 5.3 → 3.0 ms |
| `users` | 424 → 371 | 34.8 → 32.9 ms |
| `mixed` | 156 → 124 | 14.7 → 12.4 ms |

Recycling the parser's per-row throwaways (the `fields` array + `DataRowMessage`)
cuts young-gen collections sharply where row parsing is the main allocator
(`seq`: 36 → 5). On jsonb-heavy rows (`users`) most garbage is the parsed JSON
objects from `pg-types`, so the relative win is smaller.

## Real-world Pool — `pool.query()`, ~100-row list query, 10 conns / 40 concurrent

| metric | base → optimized |
| --- | --- |
| throughput | 5,901 → **6,555 qps** (+11%) |
| CPU per 1k queries | 161.5 → **144.9 ms** (−10%) |
| avg latency | 6.77 → 6.10 ms (−10%) |
| **p99 latency** | 8.57 → **7.81 ms** (−9%) |
| max event-loop lag | 2.5 → **1.4 ms** (−44%) |

This is what an app actually sees. The benefit **scales with rows-per-query**:
a few-row lookup is ~unchanged (the network round-trip dominates), a list/report
endpoint gets ~+11% throughput and ~−9% p99 latency for free, and large
exports get the most.

## Write path — `bind` (base → optimized)

| case | base → optimized |
| --- | --- |
| `bind(2 small)` | 2.37 → 2.69 Mops/s (+14%) |
| `bind(10 mixed)` | 0.91 → 1.12 Mops/s (**+23%**) |
| `bind(unicode)` | 1.99 → 2.27 Mops/s (+14%) |
| `full insert seq` | 1.52 → 1.65 Mops/s (+9%) |

String parameters are now encoded in a single pass (one `Buffer.byteLength`
instead of three string scans); the gain grows with parameter size.

## Binary protocol mode (opt-in, `{ binary: true }`)

Binary is a **targeted** win, not a blanket one (full detail in
[`BINARY.md`](./BINARY.md)):

| type | binary vs text CPU (e2e) | wire size |
| --- | --- | --- |
| **bytea** | **2.6× less** | 53% |
| timestamp / date | 1.3× more | **41%** |
| int / numeric | 1.6× more | ~92% |
| float | 3.6× more | ~93% |

Use binary for bytea-heavy (CPU + bandwidth) and wide-timestamp (bandwidth)
result sets; the optimized **text** path stays fastest for numeric-heavy rows.

---

## What changed (all drop-in unless noted)

- `pg-protocol`: `utf8Slice` field decode, a DataRow fast-path that bypasses the
  `BufferReader`, recycled DataRow message/fields (lower GC), single-pass string
  parameter encoding, and binary-format DataRow parsing.
- `pg`: compiled per-shape row builders (object + array, cached), cooperative
  event-loop yielding for very large results (`new Pool({ maxResultChunkBytes })`,
  default 512 KB), and binary type parsers for bytea/uuid/json/jsonb.

## Reproducing individual suites

```sh
npm run bench:read     # parse throughput + GC
npm run bench:write    # write path
npm run bench:binary   # binary vs text
npm run bench:pool     # real-world Pool
npm run bench:ab       # this whole base-vs-optimized comparison
```
