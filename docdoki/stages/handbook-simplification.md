---
scope:
  - src/**
  - server/**
  - shared/**
  - extensions/**
  - scripts/**
  - tests/**
  - inspire.mjs
---

# Internal simplification

## Current state

Use the current [design contracts](../spec_abstract.md) for workbench behavior. The original
handbook and deletion estimates are historical.

At `29870a41`, the tracked TypeScript, JavaScript and CSS inventory was 203,143 lines.
Against the original inventory at `3e123767`, this removed 48,798 lines, including
16,695 application and style lines and 32,103 test lines. The inventory excludes generated
font styles and is a record of that snapshot.

- Catalog summaries reuse unchanged file versions. History search reads the admitted JSONL range
  and caps its excerpts. The event stream uses projected messages and settlement without repeating
  Pi's cumulative turn payloads.
- Prompt Map shares in-flight page reads and locates the active prompt in transcript order. The
  launcher computes the source fingerprint in its own process.
- Git status sends a summary for the topbar alone and loads file rows for visible detail views.
  In an authenticated HTTP check with 1,403 changed paths, the body went from 228,149 to 136 bytes.
  The summary counted all three conflicts, which were beyond the 1,000-row detail limit.
- Test fixtures isolate Pi trust from the user's agent directory. Keep the
  [CI baseline](../notes/platform-compatibility.md#ci-verification-scope) and use native or browser
  coverage for behavior that depends on those boundaries.
- Files reads Recent only while it is visible and shares workspace enumeration across concurrent
  lookups. Terminal attachment checks availability at the daemon. Its headless emulator owns
  playback ordering. Snapshots preserve pending decoder and parser input across resize and reconnect.
- Models loads on first use of its Settings category. Committed model edits retain the last
  confirmed picker and Common choices when discovery fails. Notification sends persist one state
  snapshot per batch. The service worker confines its cache to the application shell.
- The session index supplies branch ancestry to transcript, History and export. Composer recall
  walks backward from the viewed leaf. With 20,000 distinct inputs, returning the newest 100
  visited 101 inputs, down from 20,000. History reopens a branch after its page was cleared.
- Live events share one bounded catalog lookup for missing session summaries. The command
  palette retains its inventory while the user types or moves the selection. Files shares one
  Git path index across visible rows. An 8 MiB terminal replay after 128-byte writes now yields
  at most 129 blocks, down from 65,536 slices.
- The launcher and Host share listener validation and the desktop browser opener. The native
  terminal uses the caller's project directory. Host and reverse SSH service installers share
  directive-specific escaping for systemd paths.

- Composer and palette share command dispatch. Extension replies belong to the view that sent
  them. The shared prompt field supports source-controlled dialog text and local drafts.
- Tool cards reuse classified patch lines. Native Pi supplies the model capability reference in
  integration tests. Settings reports each native file independently and reveals only the edited
  MCP transport. Task-alert sends keep their enrollment through a grouping change.

## Remaining work

- Consolidate runtime queue and reconciliation code where the native scheduling rules match.
  Preserve the different completion evidence for input delivery, Pending handoff, terminal
  epochs and launcher exit.
- Replace duplicate synthetic tests with coverage at the owning layer. Retain real Pi, PTY,
  filesystem and browser fault cases.
