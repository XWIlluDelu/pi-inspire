---
purpose: The application pins and tests the latest released Pi runtime while recording, containing, and upstream-tracking advisories in Pi's shrinkwrapped dependency tree.
---

# Dependency boundaries

The application pins `@earendil-works/pi-coding-agent` exactly at the latest npm release. Every dependency update must preserve that latest-Pi compatibility boundary; an advisory in Pi's own shrinkwrapped tree is not grounds to downgrade Pi or to hold inspire behind the latest release.

Pi publishes a shrinkwrapped dependency tree. Root npm overrides do not reliably replace those nested dependencies and would misstate the supported runtime boundary, so inspire does not use an override to manufacture a clean audit. Findings in that tree remain recorded production advisories, are contained by inspire's loopback/authentication and projection boundaries where applicable, and must be tracked to an upstream Pi release that actually updates its supported tree.

## Current evidence

On 2026-08-01 the npm registry, `package.json`, the lockfile root, the installed package, and the project terminal executable all reported exactly 0.83.0. Pi declares Node `>=22.19.0`; validation used Node 26.5.0. Pi's package root and `./rpc-entry` remain the only exported integration surfaces, and its installed SDK/RPC documentation continues to place replaceable sessions on `AgentSessionRuntime` while inspire uses the isolated RPC boundary. Pi 0.83.0's release boundary adds a TypeBox 1.3.7 breaking change for extensions that used removed deprecated aliases; the installed Pi core/AI/TUI packages resolve at 0.83.0 and TypeBox resolves at 1.3.7. The upgrade retired the previously reported nested `protobufjs` 7.6.4 finding by installing 7.6.5.

The no-paid-model installed-Pi test uses an isolated local model definition only for model selection, never inference. It verifies byte-preserving read-only projection of an existing session, real RPC state, a trusted bounded `get_entries {since}` cursor, tree, model selection, command discovery, session statistics, all four dialog UI methods plus fire-and-forget UI events, extension-supplied offline compaction, configured session-directory replacement, switch, and fork. The separate real `RuntimeController` compatibility suite covers inspire's branch bridge, hooks, navigation, fork rebind, and extension-response lifecycle.

`npm audit --omit=dev` still reports one high-severity advisory, `GHSA-mh99-v99m-4gvg` (unbounded expansion/OOM), in `brace-expansion` 5.0.7 nested under Pi. Pi 0.83.0 installs the affected nested version, so this advisory is **not fixed**. Inspire records it without pretending a root override repairs Pi's supported tree and without downgrading away from latest Pi. Recheck it when Pi publishes a newer release, and keep the exact latest-version check independent from the audit result.

Sources:

- `package.json` and `package-lock.json` for the exact pin and nested versions.
- `pi --version` and `npm view @earendil-works/pi-coding-agent version` for terminal/registry compatibility.
- `npm audit --omit=dev`, focused real-RPC compatibility checks, `npm run check`, and `npm run build` for current evidence.
