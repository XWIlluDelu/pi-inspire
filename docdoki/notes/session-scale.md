---
purpose: Measured Pi histories show why persisted-entry framing, active-branch paging, and child RPC framing need independent limits.
---

# Session-scale evidence

A 2026-08-01 scan used the application's pinned Pi parser to inspect the 20 largest top-level histories among 44 local sessions. The largest file was 50,913,891 bytes; the largest active-branch message projection serialized to 17,800,501 bytes; and the largest individual persisted JSONL entry was 6,618,255 bytes. Several active branches exceeded the host's 8 MiB child-line guard even though each contributing entry remained below that guard.

These are observations, not limits to encode. Histories keep growing, and one tool result can make a future entry larger. The durable boundary is structural:

- Initial projection reads the session file incrementally and bounds each persisted line independently from total history size.
- Browser transcript pages are bounded by serialized bytes as well as item count; virtualization bounds mounted DOM, not transfer or retention.
- Pi RPC `get_entries { since }` is suitable only after a trusted baseline cursor exists, because an initial response still aggregates the whole append-order history into one JSONL frame.
- The malformed or unterminated child-output guard stays independent and fatal; a legitimate long history must avoid the aggregate `get_messages` path rather than receive a larger exception.

The measurement streamed each file to obtain complete-line sizes, then used `SessionManager.open`, `getEntries`, `getLeafId`, and `buildSessionContext` to serialize the active branch. The current code boundaries are `server/pi-rpc.ts`, `server/session-preview.ts`, `server/runtime.ts`, `shared/contracts.ts`, and `server/app.ts`.
