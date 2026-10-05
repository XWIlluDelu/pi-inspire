---
scope:
  - server/**
  - src/**
  - shared/**
  - tests/**
  - scripts/**
  - docs/**
  - docdoki/**
---

# Pi 1.0 quality review

## Objective

Review the core repairs, native workflow coverage and interface changes after `36fb3ac`, focusing on
correctness, maintainability and measured responsiveness. Pi remains authoritative for tools, prompts,
configuration and execution; Inspire supplies GUI projections and explicit controls.

## Outcome

Completed with these verified corrections:

| Finding | Correction |
| --- | --- |
| A completed shell command became retryable after projection/retirement failure. | Reuse accepted persistence confirmation while retaining conflict and writer-stop fencing. |
| New → Manage models leaked its prospective destination into later Settings visits. | One Settings-entry helper sets category and destination together. |
| Tab from a portaled dropdown entered collapsed content. | The shared modal inventory includes summaries and excludes hidden/inert/closed content. |
| Large highlighted source DOM stalled the browser. | Bound synchronous highlighting to 64 Ki characters; larger leaves retain text and copying. |
| Manage models text had 3.87:1 contrast at 12.5px in light Amber. | Use the existing `accent-deep` text token, verified across palettes/themes. |
| Browser fixtures required global Pi during collection. | Share pinned/override CLI selection across Vitest, Playwright and the browser Host. |

Removed duplicate shell/Settings logic, organized terminal/model/completion tests by feature, and
removed assertions that only prohibited already-removed controls. Distinct native, Host, component
and browser boundaries remain covered. Scoped measurements are retained in [[performance-evidence]].

Completed records are archived. [[follow-pi-native-capability-review-2026-10-02]] owns the remaining
native gaps; Files/command design questions remain with their existing stages. Notebook kernel-name
inference is recorded as decided but unimplemented. Guides and screenshots name current controls;
overview/spec duplication is reduced.

## Verification

Integrated Linux checks:

- Default Vitest: **220 files, 2,310 passed, two skipped**.
- Portable: **26 passed**; Launcher: **nine passed, one skipped**.
- Web build, typecheck, formatting, lint and Knip passed.
- Chromium with no global Pi on PATH: **seven passed**, covering terminal ownership, menus,
  search/copy/touch, desktop/touch catalogs and shared navigation.

Topic checks also covered actual-Pi input/Pending/image recovery, compaction, command reload,
model configuration/auth fixtures, History/Fork/Clone/export, document isolation and Settings.
Release-package evidence: [[follow-native-workflow-quality-2026-10-03]] and [[dependency-boundaries]].
Related patches and stale-test corrections were folded into semantic feature/fix commits. No live
Host restart or publication was performed by this review.
