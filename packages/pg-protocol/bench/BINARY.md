# Binary vs text wire protocol benchmarks

These benchmarks quantify where the PostgreSQL **binary** result format helps and
where it hurts, versus the default **text** format, across the three axes that
matter at scale: throughput (rows/sec, CPU), GC pressure, and bytes-on-wire.

Binary is requested per query with `{ binary: true }`, which forces the extended
protocol so the `Bind` message can carry `result-format = binary`; the captured
`RowDescription` then reports `format: 'binary'` per column and the replay
harness drives the **same** `Parser` + `Result` path the real client uses.

## Scripts

All read `binary-fixtures.json` (gitignored — capture it first):

```sh
# capture both wire formats of each type-heavy shape (needs a DB)
PGHOST=127.0.0.1 PGPORT=54399 PGUSER=user PGDATABASE=data PGTESTNOSSL=true \
  node bench/capture-binary-fixtures.js

# throughput (tinybench, RME): rows/sec, ns/row, binary speedup, wire ratio
node bench/replay-bench-binary.js all object     # or: array | both

# GC pressure: scavenge/major counts, pause, %-wall, ns-GC/row
node --expose-gc bench/gc-bench-binary.js all object

# end-to-end over a live connection: user-CPU/query, cpu rows/sec, loop lag, B/row
cd ../pg && PGHOST=... node bench-binary.js 50000
```

## Shapes

`int_heavy` (10 int2/4/8 cols), `float_heavy` (float4/8 + numeric),
`ts_heavy` (timestamptz/timestamp/date), `bytea_heavy` (4 bytea cols),
`mixed_saas` (uuid/text/bool/ts/numeric/int8 — the everyday wide row).

## Headline numbers

Captured at 20k rows/fixture (replay/GC), 50k rows (e2e), Node on darwin-arm64.
Numbers are representative, not absolute — laptop, thermally noisy; compare
back-to-back only.

### Bytes on the wire (binary DataRow bytes / text DataRow bytes)

| shape       | text B/row | binary B/row | binary/text |
| ----------- | ---------: | -----------: | ----------: |
| int_heavy   |       99.0 |         93.0 |       93.9% |
| float_heavy |      120.8 |        113.9 |       94.3% |
| ts_heavy    |      183.0 |         75.0 |   **41.0%** |
| bytea_heavy |      223.0 |        119.0 |   **53.4%** |
| mixed_saas  |      191.7 |        136.9 |       71.4% |

Fixed-width types that have a verbose text encoding win big on the wire:
**timestamp 2.4x smaller, bytea ~1.9x smaller** (text bytea is hex = 2 chars/byte
plus a `\x` prefix). Small integers/floats barely shrink — a 4-byte int4 is often
larger than its 1-3 digit text form, so the per-field length prefix dominates.

### CPU / throughput (isolated replay, object mode, ±<1% RME)

| shape       | text Mrows/s | binary Mrows/s | binary vs text |
| ----------- | -----------: | -------------: | -------------- |
| int_heavy   |        1.224 |          0.855 | 1.43x SLOWER   |
| float_heavy |        1.480 |          0.317 | 4.67x SLOWER   |
| ts_heavy    |        0.388 |          0.522 | **1.34x faster** |
| bytea_heavy |        1.344 |          0.552 | 2.44x SLOWER\* |
| mixed_saas  |        0.749 |          0.503 | 1.49x SLOWER   |

\* In the **isolated replay** bytea binary looks slower because it allocates +
copies a `Buffer` per field while text returns an interned-ish hex string and we
only `.length` it; in the **e2e** test (below) the text path's hex-decode cost
shows up and binary bytea is a clear win.

### GC (isolated replay, object mode, ~4M rows/fixture)

| shape       | text ns-GC/row | binary ns-GC/row | binary vs text   |
| ----------- | -------------: | ---------------: | ---------------- |
| int_heavy   |            4.0 |             26.9 | 6.7x MORE        |
| float_heavy |            2.0 |             33.7 | 17x MORE         |
| ts_heavy    |           10.3 |             13.5 | 1.3x MORE        |
| bytea_heavy |            4.3 |              2.8 | **1.5x LESS**    |
| mixed_saas  |            4.6 |             12.5 | 2.7x MORE        |

The binary numeric/float parsers build intermediate digit arrays/objects, so they
allocate more than `parseFloat` on a short text string. Binary bytea allocates
less (no hex string).

### End-to-end over a live connection (50k rows, user-CPU best-of-7)

| shape       | text cpuMs | binary cpuMs | binary CPU    | wire |
| ----------- | ---------: | -----------: | ------------- | ---: |
| int_heavy   |       52.4 |         83.8 | 1.60x MORE    |  92% |
| float_heavy |       49.0 |        176.4 | 3.60x MORE    |  93% |
| ts_heavy    |      159.7 |        189.1 | 1.18x MORE    |  41% |
| bytea_heavy |       65.5 |         28.9 | **2.27x less** |  53% |
| mixed_saas  |       86.5 |        153.6 | 1.77x MORE    |  72% |

## Takeaways

- **bytea: use binary.** ~1.9x smaller on the wire AND ~2.3x less client CPU e2e
  (text hex-decode is expensive; binary is a raw Buffer copy). The clear win.
- **timestamp/date: binary is great on the wire (41% of text size)** and roughly
  CPU-neutral to faster in isolation; the wire win matters most over real network
  links where text timestamps are ~29 verbose chars each.
- **int/float/numeric: prefer text.** The values are short in text form, so binary
  barely shrinks the wire, and the JS binary parsers (especially `numeric`, which
  rebuilds a digit array) cost more CPU and allocate more than `parseInt` /
  `parseFloat` on a few characters.
- **mixed SaaS rows: net loss on CPU** with current parsers, modest wire savings —
  binary pays off only when the row is dominated by bytea or wide timestamps, or
  when the network (not client CPU) is the bottleneck.

Net: binary is a **bandwidth + CPU win for bytea**, a **bandwidth win for
timestamps**, and currently a **CPU loss for numeric-heavy** rows. The fastest
path for the common case stays the optimized text parsers + compiled row builders.
