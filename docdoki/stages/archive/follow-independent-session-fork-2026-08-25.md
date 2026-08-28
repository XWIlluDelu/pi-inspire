---
scope:
  - docdoki/spec_abstract.md
  - docdoki/specs/pi-integration.md
  - docdoki/specs/session-continuity.md
  - server/session-fork.ts
  - server/session-fork-worker.ts
  - server/runtime.ts
  - server/runtime-events.ts
  - server/runtime-persistence-ownership.ts
  - server/runtime-session-deletion.ts
  - server/runtime-slot.ts
  - server/runtime-worker-lifecycle.ts
  - server/runtime-worker-pool.ts
  - scripts/verify-release-package.mjs
  - tests/server/session-fork.test.ts
  - tests/server/runtime-branching.test.ts
  - tests/server/pi-branch-bridge.integration.test.ts
---

# Independent Session fork

## Objective

Fork a Session without interrupting, replacing, pausing, or writing through its existing Pi worker. A private one-shot Pi SDK process reads the validated source and stages the destination; the Host atomically publishes and reserves that destination, then opens it with an ordinary independently owned worker while the source run continues.

## Settled product contract

- The source Pi worker and active run remain attached to the source Session throughout fork. Fork does not send that worker Pi's runtime-replacing `fork` RPC and does not invoke source extension fork hooks.
- A one-shot worker loads the installed Pi SDK and `SessionManager` only. It does not construct an AgentSession, load models, tools, skills, prompts, context files, or extensions.
- The one-shot worker copies and verifies only the current-format source's exact projected committed prefix, then opens that private snapshot with SessionManager. Concurrent append-only suffixes and partial trailing writes remain solely in the source; Pi never opens or writes the real source path.
- The destination is created in a private same-directory staging container invisible to the Session catalog. The Host validates it, reserves its generated Session identity and final path, and publishes the complete file atomically without replacement.
- The selected user input remains excluded and is returned as the destination Composer draft. Labels and the canonical ancestor path follow Pi SessionManager branch semantics.
- A branch with no assistant message is materialized from the canonical entries produced by SessionManager because Pi otherwise intentionally delays creating its file. No existing Session file is manually edited.
- After publication the destination receives an ordinary independently owned Pi worker and normal destination configuration. Source Pending queues, extension UI, run state, and projection ownership remain unchanged.
- Concurrent destination creation/open/deletion remains serialized by the existing identity/path reservation authority. Once publication succeeds, a later Host failure is reported as a known committed destination and is never treated as safe to retry blindly.

## Work

- [x] Add the bounded one-shot SessionManager worker and private staging/publish boundary.
- [x] Replace same-worker runtime fork/rebinding with independent staging, reservation, publication, processless destination attachment, and ordinary destination warm-up.
- [x] Remove superseded fork response buffering, worker rebinding, destination-claim absorption, and queue/dialog restrictions that existed only because the source runtime was replaced.
- [x] Update the Session continuity and Pi integration authorities to describe the independent read-only source boundary.
- [x] Add focused worker-boundary and runtime tests, including an actively running source, atomic collision rejection, source-prefix preservation, queue/UI preservation, and known committed outcomes.

## Acceptance

- [x] Forking while the source is streaming leaves its process, run state, messages, Pending queues, and extension requests intact; later source settlement still projects normally.
- [x] The destination contains exactly Pi's branch before the selected user input, carries the source as parent, and returns that input as the draft.
- [x] The helper rejects a changed source prefix, wrong source identity, unsupported source format, invalid target, malformed output, and public-path collision without publishing a destination.
- [x] The destination becomes catalog-visible only as one complete validated JSONL file under an active reservation and cannot replace an existing path.
- [x] A first-turn/no-assistant fork remains usable and is subsequently writable by an ordinary Pi worker.
- [x] Focused type checks and server tests pass.
