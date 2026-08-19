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

Sources:

- `package.json` and `package-lock.json` for production and development dependency ownership;
- `server/pi-installation.ts` and `server/pi-runtime.ts` for runtime resolution;
- `scripts/verify-release-package.mjs` and installed-Pi integration tests for release evidence;
- `npm audit --omit=dev` for the shipped production tree.
