---
scope:
  - server/**
  - shared/**
  - src/**
  - tests/**
  - scripts/**
  - package.json
  - docdoki/**
---

# Simplification and code-quality review

## Objective

Review and repair dead code/artifacts, unnecessary fallback and abstraction layers,
oversized code/documents, and documentation drift without weakening Pi ownership,
resource authorization, or terminal continuity.

## Final state

Completed this review slice. [[simplification-review]] records the repairs, retained
boundaries, file/document restructuring, and verification limits.

- Removed obsolete fork transfer helpers and benchmark code, redundant Pending and
  command adapters, and confirmed unused controls; preserved historical design and
  measurement evidence.
- Made Hidden-clear validation independent of deletion-adapter identity and fixed
  terminal emulator cleanup after PTY spawn failure.
- Separated Host event and terminal gateways; partitioned all 108 store tests into
  six responsibility-scoped suites without weakening assertions.
- Split oversized contracts by authority and concern, consolidated duplicate
  startup/fork details, reflowed the composer contract, and repaired associations.
- Reproduced and fixed StrictMode modal-opener loss with a red-to-green regression.
- Linux Node 22.23.2 full check passed: 17 portable, 1,226 unit/integration, and
  6 launcher tests, with three skips. Production Chromium passed all 34 tests.
  Final verification used an isolated snapshot excluding another session's
  unfinished streaming-tool-argument slice; that slice retains its own work owner.
- Existing loading-state, hidden-directory, and image-layout work was preserved.
  No daily Host restart, release, or commit was performed. Native macOS/Windows
  execution remains outside the evidence of this Linux review.

## Disposition

No remaining action belongs to this review stage. Large ownership-centric runtime
and projection files remain documented review candidates, not a promise that every
large file should be mechanically split. Further changes should justify their
boundary and preserve the existing persistence and transport regression evidence.
