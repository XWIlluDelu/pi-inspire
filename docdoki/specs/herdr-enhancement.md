---
purpose: An optional Herdr module adds managed workspace and agent-environment capabilities while Inspire remains the same graphical home for Pi.
progress: done
covers:
  - server/herdr-*.ts
  - server/pi-rpc*.ts
  - server/index.ts
  - server/preferences.ts
  - shared/contracts.ts
  - shared/herdr.ts
  - server/local-json-line.ts
  - src/components/*Settings*.tsx
  - tests/web/herdr-settings.test.tsx
  - tests/server/herdr-*.test.ts
  - tests/server/pi-rpc*.test.ts
---

# Herdr enhancement

## Goal

- Users create and use Pi sessions in Inspire. Enabling Herdr does not require opening another application, selecting another kind of conversation, or learning process ownership or terminal protocols.
- A disabled installation remains complete and does not need Herdr. Enabled installations automatically place Inspire's Pi workers in explicitly managed Herdr panes, with the genuine environment available to Pi and the user's existing tools/extensions. Latent capability is sufficient: no new model tool, injected prompt, visible agent feature, or separate workflow is required.
- There is one conversation implementation, one Pi command/event protocol, and one session-operation authority. Herdr must not introduce a second conversation database, prompt scheduler, or writer for a session.
- The module adds capabilities without redefining existing sending, stopping, configuration, restart, pairing, or ordinary project-terminal behavior.

## Responsibility boundary

Inspire retains session identity, writer admission, GUI operation receipts, projection, and browser presentation. Pi remains the sole agent and canonical session writer; Pi and user configuration own tools, prompts, extensions, and any collaboration behavior. Herdr supplies process placement, project workspaces, panes, and their native environment. The agent boundary is defined in [[pi-integration]].

Both backends run the installed Pi in RPC mode with genuine stdin/stdout pipes. The direct backend remains the default. The Herdr backend runs a small Inspire-owned bridge in a real Herdr pane; a private local connection transports the original RPC bytes between that bridge and the existing Host protocol implementation. Terminal screen frames and simulated keystrokes are not the RPC transport.

The bridge owns transport and child-process cleanup only. It does not implement session commands, duplicate the Host's queues, or provide another agent runtime. A native Pi TUI in the same process, live TUI/GUI sharing, and adopting an arbitrary already-running TUI are not prerequisites for this enhancement.

## Checks

### Placement and environment

- Creation uses explicit returned workspace/tab/pane identities and does not depend on the globally focused pane or a fabricated caller pane. Background creation does not steal user focus.
- Related Inspire workers are organized by project. The module stops and closes only resources it owns; it never restarts a shared Herdr server or closes unrelated panes/workspaces.
- Launch uses Herdr's `layout.apply` argv entry, not text typed into an interactive shell. Herdr control requests each use a new connection; socket incarnation checks before and after connection bind that request before any mutation. Public pane IDs are not durable ownership across daemon restarts.
- A worker receives Inspire's resolved user execution environment and the same installed Pi/configuration authority as the direct backend, plus the real environment of its newly created Herdr pane. Parent worker identities and another pane's location must not be copied.
- User-configured tools and extensions may use that genuine Herdr context. Inspire neither injects a collaboration tool nor decorates inter-session prompts, and does not substitute its own agent workflow when an external extension lacks RPC support.

### Transport and lifecycle

- The local endpoint and any launch material are private to the current user and authenticated per launch. No provider credentials or launch capabilities enter browser state, command text, public diagnostics, or terminal history.
- RPC bytes remain ordered and bounded by the existing protocol limits. Transport honors backpressure; terminal output is not parsed to reconstruct JSON records.
- Each worker runs inside one standard systemd user scope, preserving the pane's environment and RPC pipes. Pi's independently grouped Bash processes inherit that scope. Its boot/path/device/inode identity is retained before the launch grant; termination uses the opened cgroup directory and waits for `populated=0`, including after Pi or bridge death. Cooperative SIGTERM remains first for ordinary stop; forced cleanup uses the kernel's recursive `cgroup.kill`, not a racy scan of detached descendants.
- A lost bridge/socket is not proof that Pi exited. Replacement and recovery writes remain fenced until the module proves the old worker scope is empty and completes its process-tree termination responsibility. Runtime retains that actual-stop barrier for explicit stop, unexpected exit, and idle reclamation; a rejected stop does not release it. Failed new-session setup retains its provisional reservation until exit is confirmed, including when the worker has not yet reported its native file.
- Ownership is established before permission to start Pi. Interrupted startup and a previous Host crash must not leave an untracked worker that a later Host can accidentally duplicate. Retained launch ownership is process metadata, not a second session store.
- Host shutdown/restart still ends Inspire-owned Pi workers. Herdr does not make old Pi runtimes survive configuration updates. Ordinary project terminals and unrelated Herdr work remain outside that scope; [[host-lifecycle]] continues to define restart behavior.
- A shared Herdr server started from a Linux Host service belongs to a separate systemd user unit, not the Host's cgroup. Startup does not silently fall back to a child that the next Host restart would kill.
- Recovery checks retained worker leases even when enhancement is now disabled. Boot and process birth identity bind cleanup; a live previous Host is not adopted or terminated. A new writer is admitted only after the previous owned scope is confirmed empty. A same-boot legacy granted lease without scope evidence cannot be released as though detached tools were verified; its ownership remains blocked.
- An enabled but unavailable backend reports a concrete failure; it does not silently create another worker using a different backend or repeat an uncertain launch.
- Once Pi's stop is verified, a definite `pane_not_found` retires local cleanup ownership. A cached `workspace_not_found` response invalidates that topology and permits one fresh allocation; connection failures and uncertain layout results never authorize that retry. Cleanup of older panes cannot discard a newer workspace.

### Product integration

- One default-off Host setting selects the enhancement. Its effective state and any pending application or failure are truthful; changing a setting does not silently migrate live work.
- Existing conversation, attachment, branch, extension UI, Pending, Stop, and background-session surfaces are reused. Backend-specific checks stay at the module boundary, not spread through those components.
- Viewing an external live Pi record is not permission to start a second writer. Before starting an existing Pi file on this backend, check the current Herdr snapshot for its exact native Pi path/id or another Inspire RPC worker's session-id token, then check that pane's current foreground process group for a live Pi process. Historical metadata alone is not a live writer. Native TUI interoperability beyond this module must preserve the same ownership boundary rather than be advertised as an attached GUI worker.
- Inspire's RPC worker reports status under its own `inspire-rpc` agent/source and its exact Pi session id through a display-only Herdr metadata token. It never reports as Herdr's resumable native Pi TUI. Transport retirement is not proof that the writer exited; its metadata remains until process-group termination and owned-pane closure.
- Runtime supplies a process-bound projection of canonical session identity, run state, and `needsInput`. The adapter maps pending user input to `blocked`, active/queued work to `working`, and other states to `idle`; it does not infer a second state machine from raw Pi events. Repeated unchanged status and token events do not trigger Herdr API reports.

## Initial platform scope

The enhanced worker backend requires Linux, `/proc` process-birth evidence, a working
systemd user manager, and writable cgroup v2 scopes with `cgroup.kill` support. Availability
reports a concrete missing prerequisite; there is no process-group-only fallback.
Other platforms keep the direct backend; they are not advertised as supporting enhanced workers.
Disabling enhancement requires no Herdr process/API calls during ordinary startup or worker use;
an explicit Settings availability query may probe installation status.

## Verification

Exercise the same real-Pi RPC behavior through both transports, without paid inference: startup/state, canonical session persistence, event delivery, cancellation, and shutdown. Cover malformed/closed transport, launch failure, Host disappearance, and real exit fencing with isolated processes. Verify explicit pane selection, no-focus creation, and cleanup using a disposable Herdr server, never the user's active workspaces.

Keep the direct path independent, the byte-forwarding path small, and status reporting coalesced. Avoid duplicate agent/session state, speculative orchestration, and generic fallback layers. Measure bridge overhead separately from model execution and report the tested scope. Check the disabled path for absence of Herdr process/API calls, and keep ordinary terminal/restart regression evidence. External-writer inspection recognizes identified Herdr-native Pi TUI panes and reported sibling Inspire workers; it cannot prove the absence of arbitrary outside Pi writers without first-party identity metadata, nor eliminate the race where another application starts writing after inspection.

## Sources

The user authorized a switchable, transparent Herdr enhancement on 2026-09-25. The RPC-bridge module is an implementation decision for that goal, not a requirement for dual TUI/GUI use or cross-Host process survival. Initial implementation and verification: [[follow-herdr-enhancement-2026-09-25]]. Reviewed failure-path repairs: [[follow-herdr-review-boundaries-2026-09-25]]. Herdr's [socket API](https://herdr.dev/docs/socket-api/) supplies the argv layout and metadata interfaces; the initial real integration target is Herdr 0.9.1 / protocol 22.
