---
scope:
  - server/{model-catalog*,model-metadata*,model-settings*,pi-runtime,runtime*,session-model-selection,session-projection,app,index}.ts
  - shared/{contracts,model-settings}.ts
  - src/App.tsx
  - src/{api,app-state,store}.ts
  - src/components/{Welcome,ModelList,ModelSelector}.tsx
  - src/controllers/runtime-event-controller.ts
  - tests/{server,web,browser}/**/*model*
  - docdoki/specs/model-settings.md
---

# Native model workflow — completed 2026-10-05

## Outcome

The independently reviewed proposal is implemented in [[model-settings]] and [[composer]].
The GUI defects recorded in [[follow-pi-native-capability-review-2026-10-02]] are repaired without
modifying Pi or requiring an unreleased interface. Static `models.json` editing remains unchanged.

- Owned Pi worker state supplies selected model and effective thinking. A Router remains selected
  after physical responses; reply identity and native context/usage remain physical.
- Readonly branches follow native selection recovery using current virtual registrations.
  Initial transcript display does not await extension discovery. Pending/unavailable selection is
  distinct from an empty registry, not guessed from a physical reply.
- New distinguishes explicit choice, inherited selection and workspace default. Explicit/inherited
  choices retain their model and effort; defaults omit the model and untouched thinking arguments
  so Pi resolves them. Manual effort remains user-owned. New awaits pending source selection
  instead of silently applying workspace defaults.
- Cwd-scoped metadata queries include global and already-trusted project Provider, NativeProvider
  and VirtualModel registrations. They honor saved/inherited trust and native global rules, do not
  approve projects, and report skipped project resources separately.
- A short-lived child binds registrations through an in-memory public SDK session, then resolves
  defaults on the same runtime/settings without reloading factories. There is no session JSONL,
  session-start hook, agent loop or model request. The parent retires its process tree and awaits
  close. Explicit refresh/config/auth changes invalidate cached metadata.
- Bootstrap returns cached inventory rather than awaiting extension factories. Model
  discovery errors remain local to model queries and do not prevent pairing or retained reading.
- Virtual choices receive a compact **Router** marker. There is no routing editor, permanent
  routing diagram or new token/cost/context display.

Ordinary native continuation, Fork and Clone already retained routing. The repair changes their
GUI previews, not that execution behavior. Native `navigateTree` updates context/tools without
restoring historical model/effort; snapshots follow actual worker state, not the durable target's
settings. Same-model live snapshots no longer restart New's pending catalog query.

## Verification

- Installed Pi 1.0 SDK/HTTP/RPC fixtures cover all three registration forms, trusted/untrusted
  defaults, alternating physical responders and their 16k/64k context windows, effective thinking,
  navigation, readonly recovery, removed virtual definitions, and Fork/Clone continuation.
- Scoped model/runtime/projection/Welcome checks passed. The final asynchronous boundary checks
  passed four targeted cases: deferred readonly access, failing metadata with healthy retained
  content, bootstrap/global discovery separation, and pending-source New inheritance.
- Four Chromium flows passed at desktop 1280px and touch 390px. Open-dropdown screenshots confirm
  the inline Router marker and viewport containment. Native execution is verified by actual Pi
  fixtures; browser fixtures verify GUI ownership and interaction.
- Type checks, web/release builds, compiled metadata execution, format, changed-file lint and Knip
  passed. Process-tree success/failure evidence is Linux-only; other platforms use the existing
  retirement helper without a claim of execution evidence here.
- Single-run deterministic trusted queries took 488 ms from source and 332 ms compiled, including
  child retirement; cached reads took under 0.01 ms. These are fixture query timings, not browser
  or general extension latency guarantees. User-configured factories can have their own effects.

The subsequent review [[challenge-native-capability-quality-2026-10-05]] removed the competing
default-preview request, verified late responses/save invalidation, and aligned asynchronous fixtures.
[[model-discovery-ownership]] retains the request and cache ownership rationale.

Detailed native proof, query measurements, logs and screenshots are retained locally under
`~/.cache/inspire-model-workflow/reports/`. No live credentials were edited, no paid model request
was sent, and the running Host was not restarted.
