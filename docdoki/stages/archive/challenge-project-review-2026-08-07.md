---
scope:
  - server/**
  - shared/**
  - src/**
  - tests/**
  - docdoki/**
  - README.md
  - package.json
  - package-lock.json
---

# Project review improvements

## Objective

Implement the verified whole-project review findings without weakening Inspire's fail-closed Pi/session ownership boundaries, then reconcile the living documentation and README with the implementation.

## Current state

- Working: the review change set is complete and verified locally.
- Modified files: runtime provenance and diagnostics, host deselection, responsive navigation/composer/settings/resources UI, extension-content filtering and recovery presentation, Dynamic residency, Pi dependency compatibility, benchmark maintenance, tests, DocDoki notes/specs, README, and current screenshots.
- Verification: `npm run check` passes 56 files and 622 tests; `npm run build` passes; `npm audit` reports zero vulnerabilities across production and development dependencies; `git diff --check` passes; the isolated performance evaluator accepts 21 samples and returns `no-performance-change`.
- Browser evidence: real Chromium checks cover the mock host at desktop, 900px drawer, 475px composer, 320px active transcript/settings/resources surfaces, plus the current production host after the final transcript-content hardening, with zero console errors or warnings beyond the React DevTools info message in development. Anonymous extension cards are absent. Non-virtualized transcript mode disables the virtualizer listener path, preventing post-test scroll callbacks from reaching a torn-down browser environment.

## Decisions

- Pi 0.84.1 is the exact runtime/TUI boundary. The extension `entry_appended` event is an ownership claim, and a bounded worker `get_entries` witness covers watcher-before-event ordering only when the exact ordered delta and final leaf match; extension payloads never reach the browser.
- Projection conflicts receive opaque incident ids and metadata-only private rotated JSONL diagnostics. Prompts, message content, tool output, extension payloads, credentials, paths, and raw child stderr stay out of the log.
- New session is an authoritative host deselection. The previous worker may remain in the idle cache, but no browser-only draft identity or session-bound status/resources/attention/Escape target remains selected.
- Below 900px navigation is an independent drawer; desktop collapse preference is preserved. Composer and Settings stack at narrow widths rather than shrinking controls below usable targets.
- Generic extension content renders only when it has a meaningful type or attribution; anonymous custom parts and Pi custom messages marked `display: false` stay hidden. Attributable content keeps a normal-sans title with raw type and payload in inspectable details. Malformed content parts are filtered at the browser boundary, and a top-level privacy-safe error boundary keeps unexpected render failures recoverable instead of showing a blank page.
- No application performance optimization was authorized: the frozen benchmark stayed below every activation threshold.

## Dead ends

- ❌ Hard-coded benchmark Chromium and fixed default ports — they made the evaluator interfere with the normal host or fail after browser-cache changes; the harness now discovers a browser and uses isolated configurable ports.
- ❌ Treating `entry_appended` as browser-visible transcript content — it leaks extension payloads and is unnecessary; the event remains host-only persistence provenance.

## Handoff

The implementation is ready for the user's review. The active 4587 Inspire process was not interrupted; restart it through the normal launcher when the user wants the new host-side runtime and diagnostics behavior to take effect. This stage is closed and should be read from `docdoki/stages/archive/` only if historical context is needed.
