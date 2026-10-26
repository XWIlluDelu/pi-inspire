---
scope:
  - src/{store,notifications,browser-notifications}.ts
  - src/components/transcript-*.{ts,tsx}
  - src/components/{ChildCalls,CodeModeResult}.tsx
  - src/components/TerminalPane.tsx
  - src/controllers/workspace-controller.ts
  - server/{runtime,mcp-config}.ts
  - server/{model-settings-routes,runtime-external-sessions}.ts
  - server/{pi-rpc,terminal-session-manager}.ts
  - public/manifest.webmanifest
  - scripts/build-web.mjs
  - scripts/verify-release-package.mjs
  - tests/**
  - README.md
  - connections/README.md
  - docs/{host,pi-commands,mcp,extensions,ssh-reverse,tool-presentations}.md
  - docdoki/specs/{notifications,activity-presentation,herdr-enhancement,host-lifecycle}.md
  - docdoki/specs/terminal.md
  - docdoki/specs/design-system.md
  - docdoki/spec_abstract.md
---

# Project review repairs

## Objective

Repair the independently reproduced project-review findings that have a clear user or maintenance
benefit and a well-understood implementation. Keep Pi's ownership boundary and the existing visual
design. Work belongs on `auto-dev`. The initial repair pass included local client publication;
the public-trial follow-up initially permitted source changes and local commits only. Later explicit
authorization allowed deployment and Host restart, as recorded below; remote push and public release
remain outside this work. A finding is not an obligation to add machinery merely because it appeared
in the review.

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

The initial review baseline was `9e93d2dd`. All seven original findings are repaired; the attachment finding
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

## Public-trial follow-up

The follow-up baseline is `fad41a98`. The confirmed terminal-notification and public-documentation
findings are repaired in source:

- Terminal bell and long-task alerts use the existing service-worker registration when available,
  retain desktop constructor fallback, and contain display failures. Visual tab marks remain available
  even when system display fails; optional notification errors cannot retire the terminal transport.
- Release verification no longer claims that the removed upload trust-migration CLI was exercised.
- The public design overview uses standard relative Markdown links. The packaged extension guide
  links to the source-only task-board tutorial in the repository, and SSH reverse examples consistently
  use the globally installed command with the existing source-checkout substitution instruction.

Validation used an independent source/dependency copy. Full Biome format/lint, import boundaries,
TypeScript and Knip passed. The browser-notification, terminal-pane, terminal-settings-dialog and
terminal-connection suites passed (85 tests), including service-worker rejection, unsupported mobile
constructors, desktop fallback and retained visual marks. Public Markdown targets and packaged-guide
links were checked, as were release-script syntax and the DocDoki privacy boundary. No running Host,
Pi process or terminal was used. The full installed-package lifecycle check was not rerun.

That first follow-up did not change Android system-bar styling. At that point, the observed
installed-PWA navigation-bar color still required device-level attribution; a screenshot alone did
not establish a CSS defect. The later metadata and implementation investigation is recorded below.
Android delivery of the manual task-alert notification is already verified. Background real-task and
notification-click acceptance remain separate from that completed check.

## Skill-guided quality pass

The next pass starts at `643cc761`. It reads the original
[code-simplifier agent](https://github.com/anthropics/claude-plugins-official/blob/main/plugins/code-simplifier/agents/code-simplifier.md)
and [docs-audit-and-refresh skill](https://github.com/QwenLM/qwen-code/blob/main/.qwen/skills/docs-audit-and-refresh/SKILL.md),
including its audit checklist. The requested scope extends the former to major source areas and the
latter to README plus the main user guides. Project conventions replace generic style preferences;
Qwen-specific navigation and bundled-skill paths do not apply here. No audit software is installed.

Implementation, tests, schemas and CLI dispatch are the evidence for documentation changes. The
review prioritizes installation, authentication and command flow before organization. README now
connects requirements, source/package entry points, first-session setup and daily use. The Host guide
owns configuration and lifecycle details; the extension guide owns Herdr prerequisites and bridge
installation. Model-update guidance is consolidated, existing section anchors are retained, and
optional MCP/presentation workflows explain prerequisites and application steps. Reverse SSH now
states its noninteractive authentication requirements and stops the direct tunnel before service
handoff, avoiding competition for the same remote listener. Historical records retain their dates
and original verification scope.

Three code refinements preserve behavior: workspace requests reuse their existing ownership/query
predicates; model loading uses explicit returns for directory, refreshed-session and snapshot paths;
external-session state uses explicit branches with the original conflict/running/outcome priority.
Notification fallback and build publication retain their separate failure and cleanup boundaries.
Broader component reshaping is not justified by this pass.

### Android installed navigation color

Installed WebAPK metadata confirms the manifest's fixed light theme color. Chrome
`155.0.8059.84` uses that custom installed color on its non-edge-to-edge navigation bar; see
[WebappIntentDataProvider](https://github.com/chromium/chromium/blob/155.0.8059.84/chrome/android/java/src/org/chromium/chrome/browser/webapps/WebappIntentDataProvider.java#L241)
and [CustomTabNavigationBarController](https://github.com/chromium/chromium/blob/155.0.8059.84/chrome/android/java/src/org/chromium/chrome/browser/customtabs/features/CustomTabNavigationBarController.java#L134).
The manifest now omits only `theme_color`, removing that custom override. The initial expectation
that this would expose a matching native light/dark surface was not a device result; subsequent
device evidence below disproves its sufficiency. Page theme hints remain dynamic; background and
application identity remain unchanged. No unsupported dark-color manifest fields are added.

The Host guide explains installed-app updates. An existing WebAPK must receive the new manifest
metadata after a future authorized deployment; reloading the page alone is insufficient. Actual
navigation appearance in both system themes remains a device check, not a claimed test result.

### Verification of this pass

- Full Biome format/lint, import boundaries, TypeScript build and Knip passed. The isolated client
  build passed with the existing large-chunk advisory; its emitted manifest matches the source.
- Theme/bootstrap and icon checks passed (28 tests), workspace controller/tree checks passed
  (17 tests), and model-settings/external-session checks passed (39 tests, one environment skip).
  HTTP fixtures initially lacked sandbox listen permission; the same suites passed with authorized
  local fixture listeners and empty temporary HOME, XDG and Pi directories. No real Host was used.
- Markdown links and anchors were checked across 56 tracked files, including packaged user-guide
  targets. The deliberate missing-image browser fixture is excluded from defect reporting.
  Guide JSON examples passed their real schemas and shell examples passed syntax checks. The
  launcher help was checked with inherited-environment mode; operational examples were verified
  against dispatch/implementation, without installing services or running maintenance commands.
- DocDoki privacy and Git whitespace checks passed. The full installed-package lifecycle and
  physical mobile acceptance were not rerun; test counts do not certify a release candidate.

## Final candidate and device follow-up

Candidate `72c9dd2a` subsequently passed the complete existing release-package verifier in an isolated
environment, including production-only installation, first startup, lifecycle and terminal recovery
checks. A later authorized deployment updated both client and Host. Local and public health, catalog
reads and event snapshots passed; current served resources matched the deployed build and outgoing
resources remained available. The separate terminal service retained its process identity. These
checks do not establish Android system-bar behavior.

A newly installed WebAPK on Android 16 / One UI 8.5 / Chrome `155.0.8059.84`, shell 194, reports an empty
theme color and a successful update, but still shows a light gesture-navigation area over a dark page
and system theme. The configuration change therefore did not resolve this device's white bar;
stale installed metadata is no longer an explanation for that observation.
The same dark page in an ordinary Chrome tab has no white bar, narrowing the remaining issue to
the installed window path rather than a styling error shared by both browsing modes.

Chrome 155's [edge-to-edge navigation path](https://github.com/chromium/chromium/blob/155.0.8059.84/chrome/android/java/src/org/chromium/chrome/browser/customtabs/features/CustomTabNavigationBarController.java#L74)
sets the native bar transparent, bypassing the custom/default-color path. Native inset and window
background handling remain relevant; transparent system bars do not prove the web viewport covers
that area. The manifest background enters the initial native window, but Chrome later replaces that
background after initialization and focus. Neither a static manifest color nor a screenshot alone
identifies the remaining layer. The page already supplies dark `color-scheme`, a dark body background,
`viewport-fit=cover` and safe-area handling. No additional runtime styling change is justified yet.

Chrome's [Android architecture notes](https://github.com/chromium/chromium/blob/155.0.8059.84/components/webapps/docs/android_architecture.md#L480)
describe a separate standalone edge-to-edge path controlled by `WebAppShortEdgesCutoutMode`.
That browser feature determines whether `viewport-fit=cover` coordinates native window and content
insets. An ordinary tab's successful appearance therefore does not prove that a WebAPK follows the
same drawing path. The feature's effective state and final native background on the affected device
remain unmeasured; website CSS cannot enable the browser feature or remove native wrapper padding.

## Independent quality re-review

The independent review starts at `f8178ed3` on `auto-dev` with a clean worktree and uses Astra Ultra.
It rereads the two upstream quality guides above and checks the implementation, tests, README and
main user guides. Existing behavior and project contracts determine the repairs; no larger redesign
or speculative performance refactor is introduced.

Five defects have deterministic regressions that fail against the original implementation:

- An earlier thinking HTTP response could overwrite a later model selection. The browser uses its
  existing snapshot generation to reconcile current state instead; an old failure also preserves
  a newer confirmed snapshot.
- A native status observation started before a successful model/effort change could roll that
  selection back. Poll and reconnect reads now check the existing selection revision at commit,
  while still accepting activity and ownership evidence.
- A failed PTY resize prematurely changed dimensions and replay state, retained a failed attachment,
  or revoked the previous writer during takeover. Native resize now precedes those commits;
  attachment cleanup covers the complete operation and a same-size retry remains effective.
- Scrolling downward but stopping within 80 pixels of the bottom incorrectly resumed latest-follow.
  Scroll and search-clear recovery now use the existing one-pixel latest-boundary tolerance, keeping
  deliberate reading positions stable through content growth.
- An extension UI response could override its RPC discriminator through an extra payload field.
  The wire frame now fixes `extension_ui_response` after copying response fields.

The documentation corrections consolidate obsolete deployment summaries and distinguish installed
and cross-platform source commands. The earlier deployment/device records remain historical evidence.
Resource authority, uploads, configuration edits, Git inspection, notification failure containment
and the existing request/model simplifications were also reviewed without another confirmed repair.

### Verification of the independent review

Validation used a complete temporary source/dependency copy, empty HOME/XDG/Pi directories and
offline fixtures. Sandbox-local listeners initially returned `EPERM`; the affected runs passed after
normal approval for isolated local sockets and child processes. No running Host or user session was used.

- Full format/lint, import boundaries, TypeScript and Knip passed; the isolated client build passed
  with the existing large-chunk advisory.
- Web/integration: 163 files and 2,138 tests passed. Node: 202 files passed, one skipped; 1,773 tests
  passed and 14 skipped. The final native-observation commit-point refinement also passed its four
  focused suites (70 tests) and repeated static checks. Launcher, real Herdr continuity and systemd
  worker-scope integration were excluded; skips retain their platform/environment meaning.
- Portable tests: 42 passed. Chromium reading navigation, transcript search and activity presentation:
  20 passed, including narrow/touch flows. These are browser fixtures, not physical-device acceptance.
- Documentation: 56 tracked Markdown files, 204 targets/anchors and 85 packaged relative targets
  checked; six JSON examples passed production schemas and 22 shell examples passed syntax checks.
  The deliberate broken-image fixture is excluded. DocDoki privacy and Git whitespace checks passed.
- A 16,795,320-byte projection fixture produced nine measured samples per mode: median forced
  reconciliation 7.398 ms, version-checked reconciliation 0.028 ms. This measures Host file reads only,
  not browser frame rate, real-device performance or network latency.

The installed-package lifecycle and other browser/platform matrix were not rerun; their absence is
not a new defect. This review's changes remain source-only until separately deployed.

## Next actions

This review permits source fixes and local commits only; deployment and Host restart require a
separate instruction. Preserve current tasks and terminal processes. Android's installed-window
white bar remains unresolved and is explicitly deferred by the user; no further investigation is
part of this review. Receipt of the manual phone notification remains verified. Background-task and
notification-click acceptance are separate checks, not regressions found here. Work stays on
`auto-dev`, without push, merge, tag or public release.
