---
purpose: Explain why model choices and defaults need one asynchronous owner, and why configuration saves must retire older discovery results.
---

# Model discovery ownership

## One response owns a preview

Model choices and native startup defaults describe the same prospective workspace. Independent
requests can finish in a different order: a late default response can overwrite a newer refreshed
model and thinking level even when neither request is individually malformed.

`Welcome` consumes both from one catalog response and uses one request generation to retire older
responses. Query identity follows the target cwd and catalog source, not every live snapshot's model
object or manual thinking change. Explicit choice, source inheritance and manual effort retain their
own selection authority; discovery does not overwrite them.

`tests/web/welcome-new-session.test.tsx` covers a delayed initial read followed by refresh, repeated
same-model snapshots, manual effort and pending-source inheritance. [[model-settings]] and
[[composer]] hold the current contracts.

## Save invalidation precedes readback

A successful configuration save changes the inputs to workspace discovery. Waiting for the active
worker's readback before invalidation leaves older cached or in-flight reads able to publish obsolete
inventory. Invalidate at the successful save boundary; the catalog generation prevents an older
completion from repopulating the cache. Readback still observes the active worker's registrations.

Implementation: `server/model-settings-routes.ts` and `server/model-metadata.ts`. The in-flight/save
regression is in `tests/server/model-settings.test.ts`.

## Inventory readiness is not transcript readiness

Extension discovery can be slow or fail while a session file remains readable. Initial transcript
opening and bootstrap do not await it. Resolve only the addressed source in the background, and keep
unresolved selection distinct from an empty virtual registry: physical reply identity cannot stand
in for a selected Router. New waits for pending source selection rather than substituting workspace
defaults.

Native SDK/RPC and GUI evidence: [[follow-native-model-workflow-2026-10-05]]. Review outcome:
[[challenge-native-capability-quality-2026-10-05]].
