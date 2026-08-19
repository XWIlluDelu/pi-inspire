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

Let a user stop all currently pending Steer and Queue entries from being consumed while the active Pi task continues, without presenting a browser-only pause that disagrees with Pi.

## Current state

- The Pending surface already supports multiple entries in each Pi-owned queue, distinguishes rows with `S` / `Q`, provides per-row and numbered whole-list copy, and reports the aggregate as `N pending`.
- Pi's terminal `Alt+Up` calls `AgentSession.clearQueue()`: it clears both queues and returns their text while the active task continues.
- The installed Pi RPC protocol does not expose that operation. Its current core return shape also omits queued image payloads, so copying the TUI path blindly could silently lose attachments.

## Remaining work

- [ ] Obtain or add an official Pi RPC dequeue operation that atomically returns exactly the entries it actually removed, preserving delivery kind, order, text, and every supported content part.
- [ ] Expose that operation through INSΠRE's runtime boundary without editing installed Pi package code or simulating success in the browser.
- [ ] Present the action as **Take back all**, not a persistent pause mode: the current task continues, later Steer/Queue submissions behave normally, and only entries actually returned by Pi leave Pending.
- [ ] Keep returned entries in a distinct **Held** surface so they cannot be mistaken for inputs Pi will still consume; preserve `S` / `Q`, per-item and whole-list copy, and offer an explicit move-to-composer/edit path.
- [ ] Define requeue and reload behavior only after the authoritative payload and attachment lifecycle are available; never silently discard an attachment or duplicate an entry at the dequeue boundary.

## Acceptance

- Taking back pending input does not abort or pause the active agent task.
- Pending is always a truthful projection of Pi-owned consumable entries; Held is always browser-owned and non-consumable.
- A race with Pi consuming an entry yields the exact remaining set from Pi, not a stale browser guess.
- No text, image, file identity, delivery kind, or ordering information is silently lost.
