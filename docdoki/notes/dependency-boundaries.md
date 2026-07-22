---
purpose: The local release deliberately pins the tested Pi runtime version; two upstream shrinkwrapped advisories cannot be repaired independently at the application lockfile boundary.
---

# Dependency boundaries

The application pins `@earendil-works/pi-coding-agent` 0.80.10 to match the Pi environment against which session and RPC compatibility were verified. The package publishes its own shrinkwrapped dependency tree, so root npm overrides do not replace its nested `brace-expansion` 5.0.6 or `protobufjs` 7.6.4 packages.

`npm audit --omit=dev` reports [GHSA-3jxr-9vmj-r5cp](https://github.com/advisories/GHSA-3jxr-9vmj-r5cp) for pathological brace expansion and [GHSA-j3f2-48v5-ccww](https://github.com/advisories/GHSA-j3f2-48v5-ccww) for pathological protobuf option parsing. Neither parser is exposed as an unauthenticated browser operation by inspire, but the findings should be retired by upgrading the pinned Pi package after compatibility with the user’s terminal installation is verified rather than by carrying a misleading application override.

Sources:

- `package.json` and `package-lock.json` for the pinned and nested versions.
- `npm audit --omit=dev --json` run from the project root on 2026-07-22.
