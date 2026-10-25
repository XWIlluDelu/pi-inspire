---
scope:
  - src/{store,notifications}.ts
  - src/components/transcript-*.{ts,tsx}
  - src/components/{ChildCalls,CodeModeResult}.tsx
  - server/{runtime,mcp-config}.ts
  - scripts/build-web.mjs
  - tests/**
  - docs/pi-commands.md
  - docdoki/specs/{notifications,activity-presentation,herdr-enhancement,host-lifecycle}.md
---

# Project review repairs

## Objective

Repair the independently reproduced project-review findings that have a clear user or maintenance
benefit and a well-understood implementation. Keep Pi's ownership boundary and the existing visual
design. Work belongs on `auto-dev`; local client build publication is authorized, without publishing
remote branches or releases. A finding is not an obligation to add machinery merely because it
appeared in the review.

## Decisions

- Core session connection and discovery must not wait for optional browser notification enrollment.
  Notification settings still precede outcome offers, and late permission results must not overwrite
  a newer mode choice in another window of the same installation.
- Compact activity limits mounted work while retaining meaningful disclosure and selection state.
  View-local reading state does not require every hidden renderer to remain mounted.
- Removing a native-session slot releases its observation connection without stopping external Pi.
- MCP accepts the initial UTF-8 BOM accepted by current Pi; revisions still describe the original
  file content and existing field-preserving, conflict-checked writes remain in place.
- Delivered or possibly delivered ordinary uploads are durable assets. Correct the command guide;
  do not restore incomplete reference-based garbage collection.
- A build cannot use a newer source hash to certify an older bundle. Retain the existing build
  publication boundary without adding a watcher or retry framework.
- Large-directory virtualization, broader bundle work and known Pi capability presentation are
  outside this repair pass. They were conditional or secondary review suggestions.

## Current state

The review baseline is `9e93d2dd`. All seven confirmed findings are repaired; the attachment finding
was a documentation contradiction, while the other findings had isolated reproductions. The work
preserves the existing visual system and `.gitignore`.

| Finding | Implemented outcome |
| --- | --- |
| Q1: notification setup delayed session startup | The event stream supplies settings before offers; enrollment proceeds independently of connection, catalog loading and deep-link opening. |
| Q2: Compact retained omitted renderers | At most 24 activity items mount. Projection-owned reading choices restore disclosure, selected tools, output expansion and scroll position; omission restores focus within the group. Dynamic batches observe only mounted cards and retain explicit inspection. |
| Q3: delayed permission overwrote another window's Off | The gesture saves mode independently of permission. Later enrollment only updates transport. Explicit Host choices retire unresolved legacy migration even while grouping settings are pending; old API owners cannot write through a replacement connection. |
| Q4: reclaimed native observers kept polling | Slot removal detaches the observation connection synchronously. External Pi remains running, and busy history-only reclamation still retains observation. |
| Q5: BOM-prefixed MCP configuration failed parsing | The parser removes only the initial BOM; revision checks use original source bytes and writes preserve unrelated fields. |
| Q6: upload retention was described incorrectly | The command guide documents durable delivered or possibly delivered uploads and links explicit cleanup. No global garbage collection was introduced. |
| Q7: a concurrent save could certify an old bundle | The build samples its input hash before compilation and records that hash after publication. A save during compilation leaves the build stale for the next launch. |

## Verification

Final-code validation used isolated source/dependency copies and temporary HOME, XDG and Pi data.
The Node project used locked Pi 1.3.0 with offline fixtures. The BOM-specific fixture also passed
with the installed Pi 1.4.0 selected and isolated data, without loading user configuration.

- Full Biome format/lint, import boundaries, TypeScript build and Knip passed. DocDoki's private
  boundary and Git whitespace checks passed.
- `vitest run --project=web --project=integration --no-cache --maxWorkers=4`: 162 files,
  2,119 tests passed.
- The Node project: 203 files passed, 1 file skipped; 1,768 tests passed and 14 skipped.
  Launcher, real Herdr continuity and systemd worker-scope integration were excluded. Skips cover
  unavailable isolated systemd scopes, Windows/macOS-only behavior and filesystem case aliases.
- `node --test tests/portable/*.test.mjs`: 42 passed. The initial sandbox run made no progress;
  it was stopped, then the authorized isolated run with local process/socket access passed.
- Chromium on nyx: all 20 tests in `activity-presentation`, `reading-navigation` and
  `transcript-search` passed, including desktop and touch/narrow viewport flows. These are browser
  simulations, not physical Android/iOS acceptance or real background push delivery.

The first final-code browser run had 17 passes and 3 failures. A strict `9e93d2dd` build passed
the same 20 tests, so these were not labelled known baseline failures. Trace and instrumented
reproductions established two inaccurate test actions: a fixed header-end tap hit Copy instead of
disclosure, and Playwright `Locator.focus` discarded the unsupported `preventScroll` option. The
tests now tap the disclosure after separately exercising header and Copy behavior, and call native
`HTMLElement.focus` with `preventScroll`. Keyboard order, geometry, Copy isolation and disclosure
assertions remain. No product workaround was added for these test actions.

Focused counterexamples verified delayed permission/migration order, failing native polls during
reclamation, raw BOM revision conflicts and a real Vite save during compilation. Compact checks
include a 300-item run with 24 mounted items, retained reader state, strip focus and dynamic manual
inspection after remount. Mount counts demonstrate bounded render work; no jsdom timing is claimed
as device frame-rate evidence.

The local client build was published with outgoing assets retained. Its stamp equals the current
source hash. The running Host's homepage, worker, manifest and all current JavaScript/CSS resources
(20 files) matched `dist` byte for byte. The existing large-chunk warning remains; no bundle split
was justified by this repair pass. Host and real sessions were not restarted or modified.

## Next actions

No repair remains pending within this scope. Existing browser pages use the new client after reload;
backend fixes load at the next normal Host start. Physical mobile/background notification acceptance,
real Herdr/systemd integration and the conditional optimization proposals remain outside this run.
Changes are committed on `auto-dev` as AnoAnonyAnon, without push, merge, tag or release.
