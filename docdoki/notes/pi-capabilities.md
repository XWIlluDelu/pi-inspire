---
purpose: The user's installed Pi supplies the runtime, event, resource, and session APIs needed by Inspire; this note records the integration boundaries and non-obvious compatibility traps.
---

# Pi capabilities and boundaries

## Supported foundation

Pi’s public SDK explicitly supports custom web, desktop, and mobile interfaces. Inspire resolves the installed `pi` executable and uses that one package root for both SDK calls and RPC workers; the recorded Pi version is diagnostic metadata rather than a separate compatibility policy. `AgentSession` owns prompts, queues, messages, model state, compaction, abort, and typed events. `AgentSessionRuntime` owns new, switch, fork, clone, and import flows and is the same replacement layer used by Pi’s built-in modes. The normal `agentDir` and working directory locate global and project settings, credentials, models, extensions, skills, prompts, context files, and sessions.

RPC is a practical initial process boundary. It exposes commands, responses, streaming message and tool events, session switching and branching, and `get_entries` with stable entry cursors. A local host must still provide the browser-facing transport and security boundary because Pi RPC itself is stdin/stdout JSONL, not a network service.

Sources:

- [SDK purpose and session API](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/sdk.md#L3-L177)
- [Resource and agent-directory ownership](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/sdk.md#L329-L367)
- [RPC transport](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/rpc.md#L1-L38)
- [Durable entry cursor](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/rpc.md#L664-L697)

## Session ownership

Pi sessions are append-only JSONL trees with stable entry identifiers and parent links. Pi’s session manager loads an in-memory snapshot and persists with direct append or whole-file rewrite operations; it does not hold a lifetime session lock or perform optimistic revision checks. Two independent Pi processes therefore should not write one session concurrently. This is a general Pi operating rule, not a GUI-specific deficiency. Inspire should prevent accidental conflicts and otherwise stay out of the user’s way.

Sources:

- [Session format](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/session-format.md#L1-L9)
- [Session loading and persistence](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/session-manager.ts#L826-L971)

## Settings and credentials

Global and project settings merge with project precedence. Settings and credential writes use file locks, but a running process retains an in-memory snapshot until explicit reload or restart. Credentials remain in the trusted host; only non-secret status belongs in browser state.

Sources:

- [Settings precedence](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/settings.md#L1-L8)
- [Settings locking](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/settings-manager.ts#L198-L260)
- [Credential permissions and locking](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/core/auth-storage.ts#L35-L132)

## Extension presentation

Functional extensions continue to contribute tools, commands, events, and persistent session entries. Terminal-specific presentation is not portable by itself: RPC supports dialogs and simple notifications or string widgets, while custom TUI components, footers, headers, editors, and theme controls are unsupported or degraded. inspire needs generic web fallbacks plus targeted web-native presentations for high-value interactions such as questionnaires and subagent status.

Sources:

- [RPC extension UI boundary](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/docs/rpc.md#L1057-L1078)
- [RPC UI implementation](https://github.com/earendil-works/pi/blob/8dc78834cde4e329284cf505f9e3f99763df5529/packages/coding-agent/src/modes/rpc/rpc-mode.ts#L120-L300)
