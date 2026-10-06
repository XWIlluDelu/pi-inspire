---
purpose: External Pi runtime ownership, development compatibility versions, and recorded dependency checks.
---

# Dependency boundaries

## Runtime and build dependencies

The user's installed `pi` supplies both the public SDK and RPC worker. Resolution is in
`server/pi-installation.ts` and `server/pi-runtime.ts`; Pi version metadata is reported, while
startup checks the required APIs.

The exact `@earendil-works/pi-coding-agent` **1.0.0** development pin supplies types and the default
native-test runtime. Its published dependency ranges currently resolve agent-core, ai and tui to
**1.0.2** in the lockfile. The separate browser `@earendil-works/pi-tui` pin remains **0.87.0** for
pure fuzzy search. Neither becomes a production Pi runtime or fallback; external installations
retain their own dependency trees.

`scripts/test-pi-command.mjs` selects the pinned development CLI or `INSPIRE_TEST_PI_COMMAND` for
Vitest, Playwright collection/workers and the browser-test Host. Native catalog-scale checks run
with that selection by default.

`scripts/verify-release-package.mjs` installs the packed application with production dependencies,
checks that Pi is absent, then supplies an external Pi installation and exercises SDK/RPC startup.
Production dependency auditing is a separate `npm audit --omit=dev` check.

## Production dependency check

`multer@2.4.0` resolves the multipart findings, including
[orphaned disk writes on aborted uploads](https://github.com/advisories/GHSA-3pph-fpjx-jg34).
On 2026-09-30, `npm audit --omit=dev` reported **zero vulnerabilities**; 67 attachment and application
route tests passed. [[follow-upload-dependency-2026-09-29]] records the completed update.

## Recorded Pi compatibility checks

| Baseline | Environment and checks | Result |
| --- | --- | --- |
| 1.0.0, current development pin | Linux, recorded 2026-10-03; default suite, portable/launcher checks, production-only package installation and external SDK/RPC startup | Those recorded checks passed. [[follow-native-workflow-quality-2026-10-03]] holds the evidence, not a claim about every later revision/platform. |
| 0.99.1 | Linux; isolated installation, 25 real RPC/runtime checks, codemode file/MCP calls with local model/service fixtures, and concurrent extension-dialog lifecycle | Passed. At that baseline child-call presentation and MCP management were deferred; current coverage is in [[spec_abstract]]. Dialog repair evidence: [[follow-core-review-repairs-2026-09-30]]. |
| 0.87.0 | Linux / Node 22; [CI run](https://github.com/XWIlluDelu/pi-inspire/actions/runs/35689791288), `npm run ci`, `release:verify`, and context-edit regressions | Passed. The job recorded external SDK/RPC Pi 0.87.0. |
| 0.86.0 | Linux / Node 26.5.0 full CI and release verification; Node 22.19.0 types and 168 focused tests | Passed; the separate Multer audit finding remained open. |
| 0.85.1 | Linux / Node 22.19.0, 2026-09-08; clean install, full CI, release verification | Passed. Production and development audits were clean at that time. |

### Integration changes retained

- **0.87.0:** context-edit tests append omission and string-replacement edits and exercise retain-none
  compaction followed by input. Inspire preserves raw display messages across reconciliation and
  reopening while Pi changes model context. No adapter change was required.
- **0.86.0:** system prompt/tool-loadout entries were removed from conversation rows and live overlays
  while keeping persistence expectations and message indices. `/bug` became terminal-only. Real RPC
  tests cover cache-warming and unknown usage kinds. The provider `TranscriptContext` and `user_bash`
  changes needed no adapter because Inspire implements neither a provider stream nor that hook.
- **0.85.1:** a clean external installation imports the SDK without the older 0.85.0 `pi-server`
  workaround. Browserslist was updated to 4.28.9 at this baseline.

The TUI package's missing license file is handled by a version-specific MIT notice whose source
provenance is recorded in `scripts/licenses/README.md`. The release verifier reads the browser TUI
version from its own `package.json` pin when checking that notice; this is separate from the native
Pi development baseline.
