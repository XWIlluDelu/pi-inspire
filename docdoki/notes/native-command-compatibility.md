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

## Why automatic native handoff remains deferred

The candidate approach was to retire the identified native Pi without interrupting its work, then
reuse ordinary viewed-session recovery. Public idle signals did not establish that safe boundary.
Isolated Linux checks on 2026-10-28 used Pi 1.3.0 and 1.4.0:

- While a native `!` shell waited on a file gate, the extension context reported idle, no pending
  messages and an empty editor. `ctx.shutdown()` exited Pi and killed that shell before completion.
- SDK `waitForIdle()` also returned with `isBashRunning === true`; `runtime.newSession()` cancelled
  the unfinished shell. Session switching disposes the old session through the same teardown path.
- `AgentSession.isIdle` covers agent activity and compaction, not Bash controllers. Extension
  contexts lack shell-running state and complete shell-lifetime events. `user_bash` is a
  short-circuiting interception chain, so adding an observer cannot reliably reconstruct them.

Other inspected paths did not provide adoption or safe release. SDK/RPC expose runtimes owned by
the caller, without attaching to an existing TUI or switching its live transport. Herdr 0.8.6
(protocol 22, Pi integration v9) exposed reported agent activity and blocked prompts, without shell
lifetime or conditional retirement. Its live server handoff preserves terminal processes during
an update; it does not transfer Pi session ownership. Owning future sessions through a custom
launcher would not adopt an already-running native process.

These observations explain the deferred decision in [[herdr-enhancement]] and [[pi-capability-gaps]].
Revisit when a public adoption or non-interrupting release interface becomes available. Process-tree
or screen guesses and replacement shell execution add a separate lifecycle mechanism instead of
establishing the missing public ownership boundary.
