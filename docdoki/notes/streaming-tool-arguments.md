---
purpose: Explain bounded incremental argument projection, its wire/work measurements.
---

# Streaming tool argument projection

## Identity and incremental ownership

Pi JSON/RPC >=0.84.3 supplies tool identity/name at `toolcall_start` (upstream PR #7953;
verified against installed Pi 0.85.1 `docs/rpc.md` and `dist/modes/json-event.js`). That permits a named
card before arguments complete; older identity-less starts retain end-only behavior. Contracts:
[[activity-presentation]], [[session-transport]] and [[conversation]].

`server/tool-argument-stream.ts` parses once into a worker/message-owned preview. Sensitive keyed
values are redacted before transport; cumulative raw argument JSON is not retained. Immutable path
updates in `shared/tool-argument-updates.ts` preserve call identity across both projections, and
prototype-shaped keys remain inert own properties. Final tool data replaces the preview once.

`server/runtime-stream-budget.ts` accounts for exact append JSON growth, including escaping and split
surrogates, without serializing the cumulative assistant on every fragment. Structural changes still
require full validation. If the item budget removes other argument paths, a character count cannot
prove the reduced tree: publish a complete checkpoint, not merely the latest path patch.

Same-tool fragments coalesce within the existing transport window. `sourceEventCount` preserves
revision continuity across batches; background viewers receive no argument bodies. Joining snapshots
can still serialize cumulative replacements, so established-viewer measurements do not describe that
handshake. Display truncation and partial-path resource/copy rules remain in the contracts.

## Recorded wire and work measurements

The Pi 0.85.1 authenticated WebSocket fixture projected a **157,814-byte** write call into a
**32,000-character** preview. It sent **18 batches / 39,191 additional JSON bytes** before compression,
versus **4,487,639 bytes** for repeated cumulative projection of the same updates. Final authoritative
events are outside that incremental measurement; batch counts depend on scheduling. The simultaneous
background viewer received no body. Regression assertions bound total bytes rather than the exact
batch count.

Host serialization counters for 1,000/2,000 eight-character body fragments were 10,000/20,000 fragment
bytes, with zero cumulative assistant-message serializations in the append hot path. These are
serialization/wire measurements, not a general end-to-end latency result.

Evidence: parser tests, runtime projection/stream-budget suites, shared reducer tests and authenticated
WebSocket batching fixtures. [[follow-streaming-tool-arguments-2026-09-08]] records the delivery run.
