---
scope:
  - shared/contracts.ts
  - server/**
  - src/**
  - tests/**
---

# Navigation and resource preview

## Objective

Make session navigation behave like a durable workbench index and turn the right contextual region into a useful file/resource preview surface driven by references in Pi conversations.

## Current state

- Implemented: unpinned sessions are grouped by exact project directory with persistent collapse controls; the active session’s group currently remains forced open and is recorded as follow-up work.
- Implemented: pinned sessions form one global section above project groups without duplicate rows.
- Implemented: the right contextual region is a Files pane with session-derived resources and image, PDF, sandboxed HTML, Markdown/text/code, audio/video, loading, error, and unsupported states.
- Implemented: local Markdown links/images, Pi tool-call paths, `<file name="…">` attachment references, inline path references, OSC 8 file links, and embedded Pi image blocks converge on the preview interaction; thinking and hidden custom content are excluded.
- Implemented: file access requires an exact selected-session reference and an authenticated opaque handle; HTML is scriptless and sandboxed.
- Deferred review findings are recorded in `docdoki/notes/follow-up-code-review-2026-07-22.md`. The attempted follow-up fixes were withdrawn before this checkpoint.

## Next actions

- [x] Add persistent project-group collapse metadata and a global, non-duplicated pinned-session section at the top of navigation.
- [x] Add a trusted-host resource resolver that requires paths explicitly referenced by the owning Pi session and serves resolved files through authenticated opaque handles.
- [x] Replace session metadata in the right pane with a session-resource list and previews for images, sandboxed HTML, PDFs, Markdown/text/code, audio/video where browser support exists, and a truthful unsupported-file state.
- [x] Make local Markdown links/images, structured Pi tool paths, attachment tags, inline file paths, and embedded image blocks open the resource pane while external web links keep their normal behavior.
- [x] Verify path authorization, HTML isolation, navigation behavior, focused rendering, the full test suite, and production build for this checkpoint.
- [ ] Address the correctness, accessibility, ownership-race, and efficiency findings in `docdoki/notes/follow-up-code-review-2026-07-22.md` as a separate change.

## Decisions

- Pins are inspire interface metadata stored with preferences, never Pi JSONL state.
- Pinned sessions form one global section above project groups and are omitted from their ordinary groups; this gives “pin to top” literal product meaning without duplicating rows.
- Search temporarily exposes matching groups even when they are normally collapsed.
- The right pane is a Files/resources surface. Session metadata is not its primary content.
- The browser cannot request arbitrary filesystem paths. Every local file requires an exact reference from the owning session’s authoritative messages or structured tool data; relative references resolve against that session’s project directory.
- Remote web URLs remain ordinary external links and are not fetched by the privileged host.
- HTML previews run without scripts in a sandboxed frame under a restrictive document CSP; raw HTML never joins the conversation DOM.

## Handoff

This checkpoint is implemented and ready for its pre-commit validation. Future work starts from the bounded follow-up list rather than silently folding review fixes into this feature commit.
