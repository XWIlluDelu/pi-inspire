---
purpose: Proposed post-MVP enhancements from the 2026-07-22 deep review, awaiting human selection; none are settled direction until adopted into specs.
---

# Enhancement proposals (2026-07-22 review)

Findings from a full read of the implementation against the current specs. The
basic-function and code-quality review found the codebase in good shape; the
one defect found (global Escape-abort firing while closing the file picker or
the rename input) was fixed with a regression test in the same pass. Everything
below is optional forward work, ordered roughly by expected daily-use value.

## 1. Per-session composer drafts

The draft lives in `Composer` component state, so switching sessions or
refreshing the browser silently discards typed-but-unsent text. Keep a
`Map<sessionId, draft>` in the store (optionally mirrored to `sessionStorage`)
and restore it when a session becomes active. Low cost, high daily-use value,
and it settles the composer spec's currently hedged draft-preservation check.

## 2. Session list pagination

`loadSessions` fetches only the first page (40) and the nav renders exactly
that; the server already supports `offset`/`limit` and returns `total`, but no
caller uses them. With a long Pi history, older sessions are reachable only by
search. Add incremental loading (a "show more" row or scroll-triggered fetch)
in the nav and command palette.

## 3. Attachment lifecycle on the host

`AttachmentStore` keeps every upload in its map and on disk until process
shutdown, and the client error message ("One or more attachments expired")
promises an expiry that does not exist. For a long-lived host this is unbounded
growth. Delete an attachment's file and entry after the prompt that consumed it
settles, or add a TTL sweep — and make the error message truthful either way.

## 4. Transcript search

Once conversations replace the terminal, "where did Pi say X" becomes a daily
question. A client-side find over settled message text (with jump-to-match in
the virtualized transcript) is enough; no derived index, so session-continuity
constraints stay intact.

## 5. Session branch tree in the contextual pane

The workbench spec reserves the right region for session trees, and the catalog
already carries `parentSessionId`. A first slice: show the ancestry/children of
the active session in the context pane with open-on-click. Fork/branch creation
can wait for Pi runtime operations to be wired.

## 6. Background completion notification

When the tab is hidden and `agent_settled` arrives, fire a desktop
`Notification` (permission-gated, preference-gated) and/or a title-bar marker.
Small change in the store event path; large ergonomic gain for long tasks.

## 7. Diff/changes surface

The second reserved contextual surface with clear value: after a turn in which
Pi edited files, show `git diff --stat` of the project working tree with
per-file diffs. Needs one new bounded read-only host endpoint; the trust
boundary stays in the host.

## 8. Generic widget/status fallback for extensions

`setWidget` is currently dropped (documented in `events.ts`). A lossless
fallback — rendering widget text lines in the ActivityBar or the context pane —
would honor the conversation spec's "generic, lossless fallback" check for the
remaining extension surface.

## 9. Model picker quality

The composer model `<select>` is flat; with many providers it gets unwieldy.
Group options by provider and surface the current model's reasoning support;
optionally add "recent models" at the top. Pure front-end change.

## 10. In-transcript queue visibility

Queued steering/follow-up messages appear only as a count chip. Rendering the
queued texts as pending bubbles at the transcript tail (distinguishable style,
cancellable while queued) would make the queue truthful and manipulable.
Requires the host to expose queue contents, which `queue_update` already
carries.
