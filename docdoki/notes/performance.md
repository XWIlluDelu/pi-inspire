# Performance and measurement

## Performance evidence

### Settings first-open flash

A Chromium production-build probe reproduced two distinct Settings dialog nodes
and two starts each of `overlay-in` and `pop-in` during the first open: the
Suspense loading fallback and ready component each mounted their own animated
shell. Subsequent opens reused the loaded module, explaining the cold-open bias.

The eager `SettingsDialog` now owns the overlay, header, and modal focus while
only `SettingsContent` is deferred. A fresh browser context with service workers
blocked and the Settings module response delayed by 600 ms verified the fix at
1280×720/light and 390×844/dark: one shell, one start per entrance animation,
and overlay opacity remaining 1 after the initial entrance through readiness.
An injected module-evaluation failure preserved the same dialog and Reload
control; Escape closed it and restored the opener. This is transition-correctness
evidence, not a general startup-latency benchmark.

`tests/web/settings-loading.test.tsx` gates the real lazy import and checks
loading-state dismissal, stable overlay/dialog/close-button identities, focus
continuity on readiness, and final opener restoration. Navigation, modal-focus,
and App integration checks also pass (35 tests across the four targeted files,
on both Node 26.5.0 and Node 22.23.2). Typecheck, production Web build, formatting,
lint, and unused-code checks pass.

### Targeted streaming work counters

The review identified two concrete costs outside the older evaluator's limited stream scenario: background body delivery before browser filtering, and cumulative assistant overlay serialization on every valid delta. The user explicitly requested these targeted changes; the historical no-change decisions below do not forbid them or establish their latency benefit.

`tests/server/runtime-stream-budget.test.ts` drives the real event reducer and overlay owner with alternating 32-character text/thinking fragments. With incremental accounting disabled, 1,000/2,000 updates serialize cumulative assistant messages 1,000/2,000 times and approximately 16.2/64.4 MB of JSON. The incremental path produces identical overlays while serializing only 34/68 KB of fragment JSON and no cumulative assistant messages in that hot path. It also checks escaped characters, split surrogates, revision growth, string/item/overlay limits, structural fallback, and final/snapshot validation. These are serialization-work counters, not network, memory-peak, event-loop-delay, or remote-latency measurements.

## Session-scale evidence

Persisted entries, active-branch projections and child RPC frames have different size distributions. Bound them independently.

These are observations, not limits to encode. Histories keep growing, and one tool result can make a future entry larger. The durable boundary is structural:

- Initial projection reads the session file incrementally and bounds each persisted line independently from total history size.
- Browser transcript pages are bounded by serialized bytes as well as item count; virtualization bounds mounted DOM, not transfer or retention.
- Pi RPC `get_entries { since }` is suitable only after a trusted baseline cursor exists, because an initial response still aggregates the whole append-order history into one JSONL frame.
- The malformed or unterminated child-output guard stays independent and fatal; a legitimate long history must avoid the aggregate `get_messages` path rather than receive a larger exception.

The measurement streamed each file to obtain complete-line sizes, then used `SessionManager.open`, `getEntries`, `getLeafId`, and `buildSessionContext` to serialize the active branch. The current code boundaries are `server/pi-rpc.ts`, `server/session-preview.ts`, `server/runtime.ts`, `shared/contracts.ts`, and `server/app.ts`.
