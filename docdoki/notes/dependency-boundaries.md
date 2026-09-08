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

## Verified baseline: Pi 0.85.1

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
