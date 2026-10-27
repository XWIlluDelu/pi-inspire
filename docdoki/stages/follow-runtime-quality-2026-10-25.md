---
scope:
  - package*.json
  - src/**
  - server/**
  - tests/**
  - scripts/**
  - docs/**
---

# Runtime quality and device acceptance

## Objective

Keep native Pi ownership, asynchronous operation lifetimes and responsive reading behavior
consistent with [[northstar]]. The lasting contracts live in [[notifications]],
[[activity-presentation]], [[terminal]], [[composer]], [[interface-preferences]] and
[[state-ownership]].

## Implemented

- Core navigation starts independently of notification enrollment. Device intent, Host settings,
  receiver replacement and worker delivery have separate ownership boundaries.
- Model catalogs settle their own read state without replacing newer session observations.
  Explicit new-session choices survive refreshes and failed writes remain retryable.
- Pending recovery waits for operation receipts and transcript convergence, including reconnects.
  Recovery completes the originating caller without replaying the submitted mutation.
- Compact activity bounds mounted children while preserving deliberate disclosure, selection and
  reading offsets. Desktop conversation search remains visible; narrow screens use launchers.
- Terminal observer disconnects, failed attaches, refreshes and title updates preserve the active
  control lease and its geometry. Optional notification failures do not kill the daemon.
- Shutdown rejects new work and native-dialog enqueueing. Late observer creation is retired with
  its slot, and extension failures stay inside the owning request or shutdown boundary.
- Native MCP configuration accepts a UTF-8 BOM. Source-build freshness records the revision
  sampled before compilation rather than an edit that arrived during the build.
- Documentation distinguishes durable delivered uploads from unclaimed staging, explains public
  extension-state contracts, and gives first-use, pairing and lifecycle instructions in order.

## Evidence and delivery boundary

Focused unit and Chromium regressions cover these contracts, including delayed replies,
disconnected send/recovery, ownership races, bounded activity, desktop/narrow search and reading
position. Build-source verification changes a source input during a blocked build and confirms
that the resulting artifact remains stale. Local integration also passes typechecking, lint,
formatting, unused-code checks, isolated web/server compilation and the DocDoki privacy check.
Browser color checks compare resolved colors rather than minifier-dependent CSS spelling.
Physical-device evidence is tracked separately.

Version 0.6.5 also passes a local Linux production-only installation check: package contents,
external Pi startup, authenticated readiness/pairing, session recovery, PTY I/O, terminal
maintenance and Host restart preserving the same terminal. The production dependency audit is
clear after compatible request-parser, multipart-upload and schema-validation upgrades; focused
API, configuration, upload and notification regressions pass. Cross-platform evidence is tracked
in [[platform-compatibility]].

The CI repair at `c7f74095` was subsequently deployed and activated with operator authorization.
Authenticated readiness reported Inspire 0.6.5; Host and terminal services recovered, the served
browser assets matched the prepared build, and retained sessions remained readable. Native Pi and
the annotated 0.6.5 tag were unchanged. The review follow-up below is a separate change set delivered
through `auto-dev`, without merging into `main` or moving that tag.

### CI follow-up

The [original 0.6.5 matrix](https://github.com/XWIlluDelu/pi-inspire/actions/runs/40339358680)
passed all three installed-package checks but failed quality and Windows, while macOS exhausted
its job budget after browser failures. The follow-up restores the sidebar's specified compact search
font size after shared search styles overrode it, retaining WebKit's editing-size exception. It also
repairs test contracts without changing the tag, deployed assets, native Pi or runtime deadlines.
Large activity mounting and deliberate card
choices have independent checks; native model edit scenarios retain real metadata validation
without combining six cold worker starts into one test deadline. Native Bash logout is witnessed
by its exact file side effect after exit, independently of bounded PTY tail delivery.

Cross-platform fixtures use canonical temporary paths and apply POSIX permission assertions only
where meaningful. Browser acceptance follows current action menus, addressed branch commands,
model labels, recovery states and responsive layout. Held History-copy requests are scoped to the
original entry so they cannot also block a newer response copy. Reading checks retain real scroll
offsets, and clipboard checks assert the complete copied source.

The complete Chromium run also exposed an asynchronous mobile history race: a delayed explicit
close could dismiss a newly opened Settings panel. History ownership now waits for its own pending
traversal before reconciling the latest UI intent. A controlled delayed-popstate regression and real
login, modal Back, image-gallery and native-question flows cover the repair. Cancellation fixtures
finish their in-flight mock request handlers before disposing the browser context.

Reading scroll ownership retains an upward wheel across a queued layout scroll at latest instead
of snapping back to the bottom. A gesture that cannot move the transcript still permits subsequent
latest-follow. Native occupancy acceptance observes successful guard admission when the replacement
worker is created, rather than installing a probe after automatic recovery may already have finished.

The [first repair matrix](https://github.com/XWIlluDelu/pi-inspire/actions/runs/40349199484)
also measured 27.3 minutes for macOS Chromium, after successful core and launcher checks. Its
40-minute job budget cancelled the following 38-case WebKit phase without a Safari assertion
failure. The aggregate macOS budget is now 50 minutes; individual deadlines, one browser worker
and one CI retry are unchanged.

A later Windows run measured 3.35–4.65 seconds for single native configuration validations.
Its five two-validation scenarios exhausted the unit runner's shared five-second default;
those scenarios now have a 45-second integration budget, covering two existing 15-second
request deadlines and Windows process retirement. Global and production deadlines are unchanged.

Large argument-menu scrolling waits for the browser's asynchronous visibility observation before
stopping wheel input; estimated virtual-row geometry can move after a synchronous rectangle read.
Command fixtures finish each settled snapshot before starting the next simulated run and drain
pending handlers before browser-context disposal. File-refresh acceptance waits for changed source
content before checking retained mode and offsets, independently of concurrent workspace searching.
Export-format geometry is sampled in one browser task so a viewport relayout cannot split
measurements of a control and its containing row; the original alignment limits are retained.

Local Linux follow-up evidence includes 3,957 passing unit/integration cases, 42 portable checks,
and nine launcher checks (one platform skip), plus formatting, lint, types, unused-code checks and
a fresh isolated browser build. Launcher checks run from a temporary source copy so validation
cannot rebuild the staged deployment or control its instances. Cross-platform CI remains separate
evidence from this local run.

### Review follow-up

The six review findings are real current paths or bounded local repairs. None requires a new
coordination layer or a broader compatibility project:

- Zsh's ordinary command and cwd markers require a literal-percent pattern, rather than Zsh's
  end anchor. Native marker round trips cover plain text, percent signs and control characters.
- A cancelled dispatched input retains unknown acceptance even if retirement or reconciliation
  fails. Cleanup diagnostics and the existing writer fence remain separate from delivery evidence.
- Branch navigation rechecks its original worker, bridge and pending operation after final
  reconciliation; Stop or exit cannot leave a successful lease owned by a retired worker.
- A delayed Prompt Map seek retains its data but loses scrolling authority after a newer search,
  scroll or Latest action, including before its deferred animation frame.
- Linux direct launch remains available without a user service manager when offline inspection
  establishes that no service authority is present. Installed or indeterminate authority still
  refuses takeover; unusual manager lookup settings are not reconstructed.
- Source-inspection failure remains unknown instead of becoming package identity. The optional
  maintenance timer must skip it; a compiled package is recognized from its existing release layout.

These checks exercise controlled failure/ordering conditions, not claims of observed production
incidents. Real Pi duplicate execution, cross-platform process failure and physical-device
acceptance remain distinct from these regressions. The final combined unit/integration run passed
3,991 cases with 10 skips. Focused checks passed 119 runtime, 71 web, 54 Host-control/source-identity
and 19 shell cases; new navigation, cancellation and Zsh regressions also failed against the old
implementation. Eight Chromium reading-navigation cases passed using a separate temporary browser
build and mock Host. Formatting, lint, unused-code and no-emit TypeScript checks passed. The deployed
browser entry and build-stamp hashes stayed unchanged during validation. Operator-authorized rollout
uses the existing preparation and Inspire-owned Host/terminal restart controls; native Pi and other
projects' services remain outside that rollout. The current workflow needs explicit dispatch for
`auto-dev`; local results do not imply that its cross-platform CI has passed.

The [review matrix](https://github.com/XWIlluDelu/pi-inspire/actions/runs/40467001479)
identified a Windows-only setup failure in four source-identity cases: the isolated fixture
retained OS tools but removed Git from PATH, so `git init` failed before any assertion. This
fixture now explicitly preserves its Git search path while continuing to isolate user state and
Git configuration. The missing-Git scenario still replaces that path; production identity rules,
assertions and timeouts are unchanged. Windows Chromium passed 373 cases with one skip.
The local fixture, isolation, Git-configuration and maintenance regressions pass 45 cases with
one platform skip; native Windows execution remains a separate CI check.

## Remaining acceptance

- On Android, verify background task outcomes, click-through and offscreen same-Pi prompting,
  and inspect installed-window status/navigation bars in light and dark modes.
- On iOS/iPadOS, verify Add-to-Home-Screen delivery, permission, badge and click-through.
  [[follow-notifications-2026-10-22]] owns the notification acceptance boundary.
- Android navigation-bar rendering remains browser/OS-owned; the application supplies native
  theme inputs rather than fixed palette-independent color guarantees.

No new product behavior is implied by these outstanding device checks. Persistent-writer
continuity, external Pi ownership and manual service restart remain unchanged.
