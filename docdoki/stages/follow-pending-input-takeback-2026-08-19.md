---
scope:
  - docdoki/specs/composer.md
  - shared/contracts.ts
  - server/pi-rpc.ts
  - server/runtime.ts
  - src/api.ts
  - src/store.ts
  - src/components/Transcript.tsx
  - src/components/transcript-rows.tsx
---

# Pending input take-back

## Objective

Let a user stop all pending Steer and Queue entries from being consumed while the active Pi task continues, without presenting a browser-only pause that disagrees with Pi.

## Current state

- Blocked: Pi's in-process `AgentSession.clearQueue()` atomically clears both queues but returns only `string[]` values, while the public RPC command union exposes no dequeue operation.
- Working: INSΠRE truthfully projects the exact text queues Pi reports, distinguishes Steer and Queue entries, and offers per-item and whole-list copy without claiming to control them.
- Constraint: a browser implementation cannot safely recover queued attachments, delivery identity, or a racing entry until Pi exposes those values at the authoritative dequeue boundary.

## Next actions

- [ ] Obtain an official Pi RPC dequeue operation that returns exactly the entries it removed, preserving delivery kind, order, text, and every supported content part.
- [ ] Expose that operation through INSΠRE's runtime boundary without editing installed Pi package code or simulating success in the browser.
- [ ] Present **Take back all** as an atomic action while the current task continues; only entries returned by Pi leave Pending.
- [ ] Keep returned entries in a distinct browser-owned **Held** surface with explicit copy and move-to-composer actions.
- [ ] Define requeue and reload behavior only after the authoritative payload and attachment lifecycle are available.

## Decisions

- Pending remains a truthful projection of Pi-owned consumable entries; Held, if implemented, is browser-owned and non-consumable.
- A race with Pi consumption uses Pi's returned remainder rather than a stale browser snapshot.
- Text, attachments, delivery kind, and ordering may not be silently lost or duplicated.
