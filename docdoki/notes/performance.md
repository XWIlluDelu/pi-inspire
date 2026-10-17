---
purpose: Reproduce representative rendering and projection measurements and distinguish their costs.
---

# Performance and measurement

## Maintained benchmarks

- `node scripts/benchmark-rich-text.mjs 3` builds the real RichText component with production React,
  project CSS and headless Chromium. `--baseline=<revision>` compares that revision's component
  against the same dependencies, styles and fixture.
- `npm run benchmark:projection` compares forced and version-checked Host projection reads.

The rich-text fixture mounts a completed prefix, waits for fonts and appends a short tail across
twelve updates: three warmups and nine measured samples per round. It measures immediate React
render/commit, forced layout, full formatting availability and animation-frame gaps separately.
Each case compares the streamed DOM with a fresh complete-source render.

## Rendering work

Unchanged math/code leaves reuse their output. Large Markdown sources parse in a shared worker,
with one active job and the latest queued source per reader. Compatible prefixes stay formatted
while new text appears immediately. React conversion, changed math/code leaves and layout remain
main-thread work. The official table-backed Micromark entity decoder works in that worker; its
default browser decoder requires `document`.

A reference comparison used React 19.2.7, Chromium 151.0.7922.34 and three rounds. Values below are
medians of round medians, comparing the synchronous leaf-reuse renderer with worker parsing:

| Mixed source characters | Immediate update, synchronous → worker | Largest frame gap, synchronous → worker | Full rich formatting, synchronous → worker |
| --- | ---: | ---: | ---: |
| 64,296 | 42.1 → 0.2 ms | 49.5 → 17.6 ms | 50.3 → 65.6 ms |
| 128,169 | 87.4 → 0.3 ms | 98.9 → 17.8 ms | 100.8 → 116.9 ms |
| 256,338 | 184.5 → 0.4 ms | 208.6 → 27.2 ms | 212.2 → 228.2 ms |

Worker parsing reduces input-thread blocking while full formatting still scales with source size.
[[rich-rendering]] owns the behavior and failure path.

## Stream work and serialized volume

`tests/server/runtime-stream-budget.test.ts` compares identical overlays with incremental accounting
off and on. For 1,000/2,000 alternating 32-character text/thinking fragments, cumulative accounting
serialized roughly 16.2/64.4 MB; incremental accounting used 34/68 KB of fragment JSON and no
cumulative message serialization in the append hot path.

The Pi 0.85.1 authenticated WebSocket argument fixture projected a 157,814-byte write call into a
32,000-character preview. One run sent 39,191 additional uncompressed JSON bytes in 18 batches,
against 4,487,639 bytes for repeated cumulative projection of those updates. Final authoritative
events are separate; scheduling changes batch counts, so regressions bound bytes instead.

For reconnect, a controller fixture containing one 128 KiB retained-text message returned 131,453
uncompressed JSON bytes after an external-activity observation invalidated its digest. Preserving
the digest returned the 240-byte unchanged confirmation instead. This is the size of that fixture's
envelope, not a fixed protocol size. See `tests/web/connection-controller.test.ts`.

These counters measure serialization and payload volume; use the browser benchmark for rendering
time and a paired deployment for network latency.

## Independent history bounds

Persisted entries, active-branch projections and child RPC frames need independent limits:

- Read session JSONL incrementally and bound each persisted line separately from total history size.
- Bound browser pages by serialized bytes and item count. DOM virtualization does not bound transfer.
- Use `get_entries { since }` only after a trusted cursor exists; an initial response can aggregate
  the complete append-order history into one RPC frame.
- Keep malformed/unterminated child-output guards fatal. Read large histories through paged projection
  rather than raising the guard to accommodate aggregate `get_messages`.

The relevant boundaries are in `server/pi-rpc.ts`, `server/session-preview.ts`,
[[session-persistence]] and [[session-transport]]. For each measurement, state the fixture, compared
operations, cold/warm state and output-equivalence check.
