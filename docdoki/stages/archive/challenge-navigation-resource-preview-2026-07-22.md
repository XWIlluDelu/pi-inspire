---
scope:
  - shared/contracts.ts
  - server/**
  - src/**
  - tests/**
---

# Navigation and resource preview

Closed 2026-07-25. The 2026-07-22 checkpoint — durable session navigation
(global pinned section, per-project groups with persistent collapse) and a
session-bound right-pane resource preview — shipped and has been stable since.
Its deferred correctness findings closed in the 2026-07-25 external-review
round; the still-unmeasured efficiency remainder was later consolidated into
[[groom-evidence-gated-maintenance-2026-08-01]]. Standing contracts live in the
workbench, session-continuity, and resource-preview specs (the earlier "active group stays forced open" state was
later replaced by honoring saved collapse with the active highlight on the
group header, as specced).

## Decisions

- Pins and folder-collapse state are inspire preference metadata, never Pi
  JSONL state; pinned sessions form one global non-duplicated section.
- The right pane is a Files/resources surface, not session metadata; every
  previewed local file requires session authority and an authenticated opaque
  handle, and remote URLs stay ordinary external links.
- HTML previews render scriptless in a sandboxed frame under a restrictive
  document CSP; raw HTML never joins the conversation DOM.
