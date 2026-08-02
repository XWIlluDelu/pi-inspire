# Performance and measurement

## Performance measurement

Compare fixed workloads with the same runtime and fixture configuration. Measure parsing, rendering and transport volume separately.

## Session-scale evidence

Persisted entries, active-branch projections and child RPC frames have different size distributions. Bound them independently.

These are observations, not limits to encode. Histories keep growing, and one tool result can make a future entry larger. The durable boundary is structural:

- Initial projection reads the session file incrementally and bounds each persisted line independently from total history size.
- Browser transcript pages are bounded by serialized bytes as well as item count; virtualization bounds mounted DOM, not transfer or retention.
- Pi RPC `get_entries { since }` is suitable only after a trusted baseline cursor exists, because an initial response still aggregates the whole append-order history into one JSONL frame.
- The malformed or unterminated child-output guard stays independent and fatal; a legitimate long history must avoid the aggregate `get_messages` path rather than receive a larger exception.

The measurement streamed each file to obtain complete-line sizes, then used `SessionManager.open`, `getEntries`, `getLeafId`, and `buildSessionContext` to serialize the active branch. The current code boundaries are `server/pi-rpc.ts`, `server/session-preview.ts`, `server/runtime.ts`, `shared/contracts.ts`, and `server/app.ts`.
