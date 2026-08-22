---
type: stage
status: complete
owners:
  - human
  - agent
artifacts:
  - docdoki/specs/conversation.md
created: 2026-08-22
updated: 2026-08-22
---

# Challenge: lazy response-fold pagination

## Outcome

Older transcript pagination advances by visible User/Response boundaries without transferring every intervening activity-only message to the browser. The Host returns opaque deferred-range descriptors inside the ordinary signed view cursor contract, and a fold materializes its range through a separate bounded endpoint only when the user opens it or explicitly chooses the Expanded default.

## Standing decisions

- The latest bounded page remains complete so active tool pairing and live projection do not acquire a second partial-message protocol. Deferred older paging is an explicit browser opt-in, so a previous browser bundle surviving a Host restart continues to receive complete legacy pages.
- Older pages retain whole visible persisted messages; contiguous activity-only persisted messages become one view-bound range descriptor. Activity that shares a persisted assistant message with response text remains in that bounded visible message.
- Dynamic historical folds stay collapsed and do not fetch deferred ranges. A live Dynamic fold may expose a local Load action; manual expansion and the Expanded default materialize all idle ranges in that semantic fold.
- Materialization is atomic across bounded continuation pages. Loading, failure, and retry remain inside the expanded fold; a projection conflict resyncs rather than applying partial data.
- Successfully materialized children enter the canonical message projection, retain their existing card behavior and state across collapse, and do not create a parallel activity renderer.
- Fold identity and manual state belong to the current session/branch view and survive pagination, virtual unmounting, Tool Call/Result repair, and deferred-range replacement. They reset on a different branch view or projection incarnation.
- A response-bearing assistant message keeps its one Assistant round marker with its first response passage, outside any leading activity fold; tool-only messages keep the marker with their first activity.
- Both disclosure and asynchronous materialization preserve the selected fold anchor when it is still in the viewport. Search and latest-follow state reset with the branch view.

## Verification

- Server projection tests cover visible-boundary paging, leading/interstitial/trailing activity ranges, bounded multi-page materialization, cursor purpose and view validation, and oversized-message identity/classification.
- Store and transcript tests cover atomic insertion, lazy Dynamic behavior, explicit loading and retry, stable fold identity/manual state, Tool Call/Result adoption, virtual remounting, and branch-view reset.
- Viewport tests cover disclosure/materialization anchoring and follow-state isolation across branch views.
- The complete 837-test suite, type checking, formatting, linting, unused-code analysis, production build, and 12 real-browser workbench scenarios passed; focused desktop and 390px checks showed consistent response attribution, no overflow, and no browser warnings.
