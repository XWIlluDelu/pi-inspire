---
scope:
  - server/**
  - src/**
  - shared/**
  - tests/**
  - scripts/verify-release-package.mjs
  - docdoki/**
---

# Native model and child-call quality review

## Objective

Review model selection/discovery and Codemode/nested-call presentation added after
[[challenge-pi-1-quality-2026-10-05]], with emphasis on real defects and maintainability.

## Outcome

Completed. Both features retain native Pi execution/configuration and GUI projection ownership.
Two verified model-discovery issues were repaired:

- Competing catalog and default-preview requests let a late default response replace refreshed
  selection/effort. One response now supplies both; the redundant endpoint, API/store methods and
  mocks are removed.
- A session-owned configuration save left older workspace discovery cached/in flight. Invalidation
  now occurs at successful file save, before readback; older completions cannot repopulate it.

Two regressions cover those boundaries. Fork/bootstrap fixtures match asynchronous discovery.
[[model-discovery-ownership]] retains the mechanisms and source pointers;
[[follow-native-model-workflow-2026-10-05]] and [[follow-codemode-mcp-adaptation-2026-10-05]] retain
feature-delivery evidence. No known repair remains in this review scope.

## Verification

- Model/API/component suites: **93 passed**; native model workflow: **3 passed**.
- Fresh production-bundle Chromium: **4 passed**, covering desktop/touch inheritance and native-default
  startup.
- Typecheck, web build, formatting, lint, unused-code and script-syntax checks passed.
- Existing native Codemode and desktop/touch child-call evidence was reused.

Related fixes and fixture corrections were folded into their corresponding feature commits. Current
MCP documentation distinguishes file configuration from the unavailable complete current-worker
management interface. The review did not restart the running Host or publish a release.
