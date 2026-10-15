---
purpose: Preserve native command ownership and operation semantics when adapting Pi to a GUI.
---

# Native command adaptation

The user-facing inventory is [Pi commands](../../docs/pi-commands.md).
[[pi-integration]] owns dispatch; [[composer]] owns preparation and feedback;
[[pi-capability-gaps]] records unavailable public interfaces.

## Dispatch and discovery

Pi RPC enumerates resource commands, not interactive built-ins. Reserve the installed built-in
vocabulary before choosing an extension, prompt or skill with the same name, matching Pi's
interactive client. Preserve the first native wire owner among resource collisions and keep
namespaced extension commands available. Names are case-sensitive.

A first message cannot invoke session-dependent commands. Hiding those commands must not expose
colliding resources instead. Refresh discovery after reload and recheck ownership at dispatch so
stale completion cannot route to the wrong command.

## Execution boundaries

Command acknowledgement, execution completion and persistence are separate observations.
Compaction, hooks and authentication may outlast ordinary reads; a generic response timeout
cannot define their execution result. Standalone compaction Stop preserves the worker when native
abort cooperates, while an unresponsive hook uses confirmed retirement.

Direct `!`/`!!` input uses Pi's native Bash operation and policy. It is not a project-terminal
command. Shell-only Stop uses `abort_bash`; model Stop retains priority when both activities run.

Original-image recovery needs queue admission, consumption and persisted-entry identity; a text
queue alone cannot establish image ownership. See [[composer]] and [[session-persistence]].

## Native regression setup

Use isolated agent directories, settings and credentials with deterministic local providers.
The pinned development Pi or `INSPIRE_TEST_PI_COMMAND` supplies the runtime. Exercise accepted,
rejected, delayed and cancelled outcomes through public RPC, including hooks that keep work pending.
Component fixtures cover presentation and focus; native fixtures establish runtime semantics.
