---
purpose: Native command regression setup and evidence about automatic terminal Pi handoff.
---

# Native command adaptation

[[pi-integration]] owns dispatch and execution. [Pi commands](../../docs/pi-commands.md) lists the
controls available to users.

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
