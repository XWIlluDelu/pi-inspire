---
purpose: Evidence and responsibility boundaries from the 2026-10-06 code and documentation review.
---

# Maintainability review

Reviewed the full tree at `3106c0a`, with priority on changes after `01a5b03`.
Pi behavior was checked against the public 1.0.0 compatibility dependency and upstream
[`031b24a`](https://github.com/earendil-works/pi/tree/031b24aa6425067253cb94095fb806a9df9d619c).

## Consolidated responsibilities

- `worker-status-request.ts` owns the repeated hidden-status correlation, subscription,
  dispatch fencing and cleanup mechanics. Authentication, model refresh, retry state and
  pending-image adapters retain their own payload and completion semantics; image packets
  still preserve multiplicity and require a final cursor.
- Terminal HTTP mutations require operation identities. Nested validation refusals now
  return matching rejection receipts. The anonymous write path, separate receipt-service
  subtype and unused destructive protocol-replacement handshake were removed. Launcher
  tests own and stop their daemon processes rather than exercising a production kill API.
- Browser status handling uses the Host's normalized projection, not a second implementation
  of raw Pi status events. Unused tool-detail serialization, old New overloads and the
  redundant prompt-history compatibility detector were removed.
- One constant-state Markdown fence helper serves resource quoting and native shell History.
  It preserves content with 150,000 backtick runs without the former argument-stack overflow.

## Repaired behavior

- Attachment discovery no longer masquerades as durable registration. Failed publication
  can be retried, and discovered custom session directories remain registered after restart.
- Host shutdown cancels standalone provider login. Runtime shutdown reports failed worker
  retirement instead of discarding rejection results. A confirmed missing login also clears
  the browser's pending state and polling.
- Released Markdown readers retire their active worker so an obsolete document cannot block
  the next reader. Old model-refresh warnings and deferred transcript-page geometry cannot
  update a replacement owner.
- Export downloads resolve trusted internal source aliases before taking a canonical file
  snapshot. A directory-alias regression covers the `/tmp` versus `/private/tmp` failure mode.
- Terminal-state failures during write or sync remove staging files. Terminal History uses
  serialized positioned writes so compaction does not require truncating a Windows append-only
  handle.
- Herdr retirement recognizes removed kernfs nodes (`ENODEV`) as well as missing cgroup paths.
  It still pins directory identity and rejects unrelated inspection failures before lease cleanup.
- Login-shell environment capture frames exports on standard stdout and discards startup noise.
  A compiled Bash 3.2 reproduced its closure of descriptors 3–19; native macOS CI subsequently
  exposed a process abort with high-descriptor capture. Standard stdio avoids both paths.

Regression tests preserve ownership, publication and retry semantics rather than implementation
spelling. Runtime attachment fixtures now use disposable storage instead of scanning real Host
state. Vitest separates node and browser projects; filesystem-only web contracts run under Node,
without jsdom or the React setup. Current Pi discovery fixtures use canonical temporary roots,
file-URL imports and a shared isolated environment. On Windows, it preserves inherited key spelling
so Node's case-insensitive deduplication cannot discard required machine variables behind an
`undefined` alias. Fresh-process fixtures pass the selected Pi installation explicitly.

## Documentation ownership

Composer owns editing and input UI; Pi integration owns native dispatch; session branches own
exports; persistence owns writer/file admission; transport owns prompt operation receipts.
Repeated detailed contracts now link to those owners. Twenty-five obsolete archive stages were
removed after retaining their useful obligations and evidence. Router guidance was corrected
against native selection semantics. Remaining capability gaps stay in
[[follow-pi-native-capability-review-2026-10-02]], not in softened specifications.

Measured projection and work-count results are in [[performance-evidence]]. The standalone auth
runtime also skips an unused availability refresh; no startup-latency improvement was measured.

## Integrated verification

On Linux / Node 26.10.0:

- 228 Vitest files: 2,373 passed, two platform-specific tests skipped.
- Portable Node tests: 26 passed; affected production-launcher checks passed.
- Seventeen Chromium History/terminal/recovery scenarios passed, including desktop, narrow
  and touch flows. Dynamic activity inspection now uses disclosure controls rather than a
  fixed scroll-distance assumption.
- Formatting, lint, typecheck and unused-code checks passed.
- Release build and production-dependency-only package verification passed: external Pi 1.0.0
  startup, independent session-search worker, actual PTY creation/removal, mock/native Host
  lifecycle, font assets/notices and publish metadata.

On Linux / Node 22.23.2, nine targeted files / 48 tests passed, covering native model workflows,
project/session discovery, provider login, IPC, History compaction, exports and browser connection
teardown.

## Native CI follow-up

[Final CI](https://github.com/XWIlluDelu/pi-inspire/actions/runs/37411420190) passed all seven jobs:
Linux quality, macOS and Windows core/Chromium, all three release-package checks, and size reporting.
Both native Chromium suites passed their 131 scenarios. The integrated local suite passed 2,384
unit/integration checks and 26 portable checks.

Tests now use native text shortcuts, clipboard newline equivalence, rendered-resource readiness and
portal ownership. Obsolete inline-`@` chips assertions and redundant theme/layout matrices are gone.
The Changes layout unit check renders ContextPane directly, without depending on cold App imports;
attachment reclamation tests assert retained bytes and last-reference cleanup, not raw JSON spelling.

Plain output still runs through real PTYs. Marked-output frontend controls use an owned WebSocket
stream because ConPTY can front-load OSC markers before rendering their enclosed text. This fixture
repair does not establish production PowerShell marker positioning; a native capture is still needed
before changing that integration. Mock History navigation/cloning now retains the complete Transcript
and unique host message identities, so full-log reading no longer depends on pristine test order.

## Behavior-focused tests

Terminal recovery checks separate atomic quarantine, immutable retry identity and admission limits
from representative stored-request validation. Each damaged value no longer repeats the entire
quarantine workflow. Request-key probes keep the changed method, path and body independently valid,
so unrelated route validation cannot make a binding check pass.

Pending input has its own component suite. Ordered full-text copy and truncated previews share one
scenario; clear confirmation and asynchronous focus ownership remain separate. Focus checks observe
the recovery callback and prohibit premature focus transfer. The omitted-row case actually copies
the complete queue instead of checking only that a Copy button exists.

The four affected controller/component suites pass 71 focused checks. Typecheck, unused-code and
changed-file lint/format checks pass. Production code is unchanged by this test-organization cleanup.
