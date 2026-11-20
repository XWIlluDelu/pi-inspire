---
scope:
  - src/**
  - server/**
  - shared/**
  - extensions/**
  - scripts/**
  - tests/**
  - inspire.mjs
specs: [workbench, session-transport]
---

# Internal simplification

## Current state

The [design map](../spec_abstract.md) links the current contracts. The first simplification
reduced tracked TypeScript, JavaScript and CSS from 251,941 to 203,143 lines
(`3e123767` to `29870a41`, excluding generated font styles).

Measurements from the review:

| Workload | Result |
| --- | --- |
| Topbar Git status, 1,403 changed paths | 228,149 → 136 response bytes, including the count of three conflicts beyond the detail page |
| Recall newest 100 of 20,000 Composer inputs | 20,000 → 101 visited inputs |
| Replay 8 MiB of terminal output in 128-byte writes | 65,536 slices → at most 129 blocks |
| Sort a 5,000-row numeric preview | 107,640 → 5,000 numeric conversions with the same ordering |

## Remaining work

- Consolidate runtime queue and reconciliation code where the native scheduling rules match.
  Preserve the different completion evidence for input delivery, Pending handoff, terminal
  epochs and launcher exit.
- Replace duplicate synthetic tests with coverage at the owning layer. Retain real Pi, PTY,
  filesystem and browser fault cases.
