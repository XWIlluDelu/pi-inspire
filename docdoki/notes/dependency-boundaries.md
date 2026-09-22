---
purpose: Distinguish INSΠRE's external Pi runtime authority from its build-time dependency witnesses and production dependency tree.
---

# Dependency boundaries

The user's separately installed `pi` is the sole production runtime authority. INSΠRE resolves that executable, imports the public SDK from its package root, and starts RPC workers from the same root. Pi's version is diagnostic metadata, not an INSΠRE admission rule.

`@earendil-works/pi-coding-agent` remains exactly pinned in `devDependencies` as a reproducible TypeScript and integration-test witness. Updating that witness follows the latest published Pi so CI exercises current public APIs, but the checkout copy is neither packaged nor used as a production fallback. `@earendil-works/pi-tui` remains an exact development dependency for the browser's deliberately imported fuzzy-search implementation.

The npm release therefore has two independent checks:

- a production-only install contains no Pi package and has a clean `npm audit --omit=dev` result;
- release verification supplies one external Pi package explicitly and proves the installed host uses it for both SDK access and a real RPC worker.

Pi's own shrinkwrapped dependency tree belongs to the external Pi installation rather than INSΠRE's production dependency graph. INSΠRE does not override, downgrade, or silently substitute that tree.

## Current baseline: Pi 0.87.0

Both exact Pi development dependencies and the lockfile now use `0.87.0`.
The external runtime authority and browser fuzzy-search boundary are unchanged.
The version-specific TUI license override uses the same MIT text, verified against
the published npm source revision recorded in `scripts/licenses/README.md`.

`tests/server/pi-context-edits.integration.test.ts` uses the installed Pi SDK to
append omission and string-replacement edits, then verifies that INSΠRE preserves
raw display messages across live reconciliation and reopening while Pi's model
context changes. It also covers retain-none compaction followed by new input.
No runtime adapter or UI behavior change was needed for these cases.

[GitHub Actions validation](https://github.com/XWIlluDelu/pi-inspire/actions/runs/35689791288)
on Linux / Node 22 passed the three added regressions, `npm run ci`, and
`npm run release:verify`. The job recorded the resolved SDK/RPC installation as
Pi `0.87.0` and saved the tested source candidate as
`7a3d4e1fda3a2309508fe3d494ce43aa4564fec8` before running the checks.
These results do not claim a new macOS or Windows run or exercise every user extension.

## Previous verification: Pi 0.86.0

The [0.86.0 release](https://pi.dev/news/releases/0.86.0) was reviewed against INSΠRE's
actual SDK/RPC, session projection, extension bridge, and browser fuzzy-search boundaries.

- The provider `TranscriptContext` migration, JSON-only tool arguments/results, readonly JSON
  arrays, and fail-closed `user_bash` hooks require no INSΠRE adapter: INSΠRE neither implements
  a provider stream nor registers `user_bash`, and typechecking passes against the new SDK.
  This does not establish compatibility for independently installed third-party extensions.
- Two projection/command gaps were reproduced and repaired. System prompt/tool-loadout messages
  no longer become unknown conversation rows or live overlays, including aggregate `agent_end`
  payloads and compaction checkpoints. Original per-entry message indices remain stable. `/bug`
  is classified as terminal-only, with explicit copy/open guidance and no automatic report upload.
- Exact persistence claims still include system and usage entries. Real RPC tests verify
  cache-warming and unknown-kind usage totals, read-only preview bytes, queues, compaction,
  session replacement, branch navigation, and fork. No real provider inference is needed.
- Both Pi witnesses, lockfile, README and the version-specific TUI license override now use
  `0.86.0`. The MIT text is unchanged at npm's published `gitHead`; provenance is recorded in
  `scripts/licenses/README.md`.

Verification on Linux:

- `npm run ci` passed on Node 26.5.0: format, lint, types, unused-code checks, web build,
  17 portable tests, 1,645 main tests (two platform-conditional skips), nine launcher tests
  (one platform-conditional skip), and all 44 Chromium cases.
- Node 22.19.0 typechecking and 168 targeted tests passed (one platform-conditional skip),
  including actual Pi RPC, 35-second pre-prompt compaction, worker reuse, and explicit Stop.
  The lifecycle fixture now expects Pi's new system record on disk while confirming its
  absence from the browser transcript.
- `npm run release:verify` passed production-only installation, bundled notices and fonts,
  external Pi 0.86.0 SDK/RPC startup, the installed fork worker, PTY lifecycle, and npm
  publish dry-run. No package was published and the daily Host was not restarted.
- DocDoki's private-boundary check and `git diff --check` passed. These are Linux results,
  not new macOS or Windows execution evidence.

Separate existing dependency finding: the checkout's `npm audit --omit=dev` reports one
high-severity package finding for unchanged `multer@2.2.0`, covering four advisories
including [GHSA-wc9g-mqfw-jrwm](https://github.com/advisories/GHSA-wc9g-mqfw-jrwm).
The upstream fix is in `2.3.0`; that upload-dependency upgrade remains a separate follow-up,
not a Pi compatibility failure. This verification does not claim a clean dependency audit.

## Previous verification: Pi 0.85.1

Validated on Linux with Node 22.19.0 on 2026-09-08:

- Both Pi development witnesses are pinned to `0.85.1`; README and lockfile agree. The latest-only support policy and external runtime authority are unchanged.
- A separate clean install of Pi `0.85.1` imports the public SDK without separately installing `pi-server`. The older `0.85.0` packaging workaround is not needed for this baseline.
- Pi TUI still omits its license file. Its existing MIT notice was verified against the new published `gitHead`; `scripts/licenses/README.md` records provenance. The build override remains version-specific, while release verification now reads the expected notice version from the manifest rather than duplicating the old pin.
- The pre-existing vulnerable Browserslist `4.28.6` development dependency was updated to `4.28.9` with its browser-data dependencies. Both `npm audit --include=dev` and `npm audit --omit=dev` reported zero vulnerabilities; no overrides or production Pi dependency were added.
- A clean `npm ci --include=dev --ignore-scripts` succeeded. The final `npm run ci` passed format, lint, types, unused-code checks, production web build, 17 portable tests, 1,257 main tests (two platform-conditional skips), six launcher tests (one platform-conditional skip), and 34 Chromium cases. This includes the completed tool-argument streaming changes.
- `npm run release:verify` passed production-only package installation, license/assets checks, real Pi `0.85.1` SDK/RPC startup and session-fork worker, PTY lifecycle, and npm publish dry-run. No package was published and the daily Host was not restarted.

These are local Linux results, not new macOS or Windows execution evidence.

## Sources

- `package.json` and `package-lock.json` for production and development dependency ownership;
- `server/pi-installation.ts` and `server/pi-runtime.ts` for runtime resolution;
- `scripts/verify-release-package.mjs` and installed-Pi integration tests for release evidence;
- `npm audit --omit=dev` for the shipped production tree.
