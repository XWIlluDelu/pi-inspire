# Pi dependency boundaries

## Dependency boundaries

The user's separately installed `pi` is the sole production runtime authority. INSΠRE resolves that executable, imports the public SDK from its package root, and starts RPC workers from the same root. Pi's version is diagnostic metadata, not an INSΠRE admission rule.

`@earendil-works/pi-coding-agent` remains exactly pinned in `devDependencies` as a reproducible TypeScript and integration-test witness. Updating that witness follows the latest published Pi so CI exercises current public APIs, but the checkout copy is neither packaged nor used as a production fallback. `@earendil-works/pi-tui` remains an exact development dependency for the browser's deliberately imported fuzzy-search implementation.

The npm release therefore has two independent checks:

- a production-only install contains no Pi package and has a clean `npm audit --omit=dev` result;
- release verification supplies one external Pi package explicitly and proves the installed host uses it for both SDK access and a real RPC worker.

Pi's own shrinkwrapped dependency tree belongs to the external Pi installation rather than INSΠRE's production dependency graph. INSΠRE does not override, downgrade, or silently substitute that tree.

### Current baseline: Pi 0.86.0

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

### Sources

- `package.json` and `package-lock.json` for production and development dependency ownership;
- `server/pi-installation.ts` and `server/pi-runtime.ts` for runtime resolution;
- `scripts/verify-release-package.mjs` and installed-Pi integration tests for release evidence;
- `npm audit --omit=dev` for the shipped production tree.

## Pi capabilities and boundaries

### Supported foundation

Pi’s public SDK explicitly supports custom web, desktop, and mobile interfaces. Inspire resolves the installed `pi` executable and uses that one package root for both SDK calls and RPC workers; the recorded Pi version is diagnostic metadata rather than a separate compatibility policy. `AgentSession` owns prompts, queues, messages, model state, compaction, abort, and typed events. `AgentSessionRuntime` owns new, switch, fork, clone, and import flows and is the same replacement layer used by Pi’s built-in modes. The normal `agentDir` and working directory locate global and project settings, credentials, models, extensions, skills, prompts, context files, and sessions.

RPC is a practical initial process boundary. It exposes commands, responses, streaming message and tool events, session switching and branching, and `get_entries` with stable entry cursors. A local host must still provide the browser-facing transport and security boundary because Pi RPC itself is stdin/stdout JSONL, not a network service.

Sources:

- [SDK purpose and session API](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/sdk.md#L3-L177)
- [Resource and agent-directory ownership](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/sdk.md#L329-L367)
- [RPC transport](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/rpc.md#L1-L38)
- [Durable entry cursor](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/rpc.md#L664-L697)

### Session ownership

Pi sessions are append-only JSONL trees with stable entry identifiers and parent links. Pi’s session manager loads an in-memory snapshot and persists with direct append or whole-file rewrite operations; it does not hold a lifetime session lock or perform optimistic revision checks. Two independent Pi processes therefore should not write one session concurrently. This is a general Pi operating rule, not a GUI-specific deficiency. Inspire should prevent accidental conflicts and otherwise stay out of the user’s way.

Sources:

- [Session format](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/session-format.md#L1-L9)
- [Session loading and persistence](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/session-manager.ts#L826-L971)

### Settings and credentials

Global and project settings merge with project precedence. Settings and credential writes use file locks, but a running process retains an in-memory snapshot until explicit reload or restart. Credentials remain in the trusted host; only non-secret status belongs in browser state.

Sources:

- [Settings precedence](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/settings.md#L1-L8)
- [Settings locking](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/settings-manager.ts#L198-L260)
- [Credential permissions and locking](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/auth-storage.ts#L35-L132)

### Extension presentation

Functional extensions continue to contribute tools, commands, events, and persistent session entries. Terminal-specific presentation is not portable by itself: RPC supports dialogs and simple notifications or string widgets, while custom TUI components, footers, headers, editors, and theme controls are unsupported or degraded. inspire needs generic web fallbacks plus targeted web-native presentations for high-value interactions such as questionnaires and subagent status.

Sources:

- [RPC extension UI boundary](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/rpc.md#L1057-L1078)
- [RPC UI implementation](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L120-L300)
