---
scope:
  - package.json
  - package-lock.json
  - shared/contracts.ts
  - server/runtime.ts
  - src/events.ts
  - src/store.ts
  - src/components/RichText.tsx
  - src/components/Transcript.tsx
  - src/components/ExtensionUiDialog.tsx
  - src/App.tsx
  - src/styles.css
  - tests/server/runtime.test.ts
  - tests/web/**
---

# Conversation inspection

## Objective

Improve mathematical source interoperability, settled-transcript search, pending-queue visibility, and generic extension rendering without creating a second conversation authority.

## Outcome

- Token-aware Markdown parsing supports `$…$`, `$$…$$`, `\\(…\\)`, and `\\[…\\]` while preserving code, escapes, valid multiline displays, and exact source for every incomplete streaming opener. Recovery examines parser nodes and source-position slices rather than preprocessing text with a global regex.
- Transcript selection copy follows KaTeX's source-annotation path. It preserves selected HTML and surrounding text while projecting canonical `$…$`/`$$…$$` plain text; formula identity comes from the original DOM wrapper so partial display selections remain display math.
- Case-insensitive literal search covers settled conversation text with All, User, and Model scopes; wraps navigation; addresses virtual rows; excludes live/tool/thinking content; resets its query per session; and holds a selected match against geometric latest-follow until explicit clear or jump-latest intent.
- Runtime snapshots and browser state retain the exact ordered steering and follow-up arrays. Pending rows remain separate from Pi history, preserve within-queue order, invent no cross-queue chronology, and clear on settle or worker replacement.
- Generic attributable extension surfaces retain bounded/redacted display payloads. Unknown response-bearing methods enter the dialog fallback rather than disappearing.
- Extension dialogs are an ordered id-keyed queue. The oldest is modal; concurrent requests survive responses to earlier requests. Browser responses are deduplicated, host responses are revalidated inside the mutation gate, and bounded Pi timeouts are mirrored by host expiry timers. Expiry and every worker-ending lifecycle remove requests and timers, preventing stale reconnect snapshots and worker eviction while blocked.
- `@earendil-works/pi-coding-agent` remains exactly pinned to the latest 0.83.0 boundary. Its inherited nested `brace-expansion` advisory remains recorded and upstream-tracked; it was not claimed fixed and did not cause a downgrade.

## Verified

- [x] Parser tests cover all four valid delimiter forms, same-line and multiline displays, incomplete `$`, leading/incomplete `$$`, `\\(`, `\\[`, multiline incomplete flow, escapes, inline code, fenced code, and sanitizer containment.
- [x] DOM clipboard tests cover partial inline/display selection, multiple formulas, surrounding text, canonical plain text, and preserved HTML; real Chromium selection copy was verified against the production mock build.
- [x] Search tests cover All/User/Model scoping, floating-control structure, settled/live boundaries, wrap navigation, virtual row addressing, older-page prepend anchoring, near-bottom scroll, and a following live append.
- [x] Runtime and reducer/store tests cover exact queue snapshots, reconnect restoration, settle/replacement clearing, concurrent dialog ordering, timeout expiry/removal, unsupported interactive fallback, response races, and reconnect presentation.
- [x] Generic extension payload projection is redacted, payload-bounded, display-count-bounded, reconnectable, and inspectable.
- [x] Focused tests, full `npm run check`, production `npm run build`, latest-Pi exact-version comparison, `npm audit --omit=dev`, `git diff --check`, and no-staged-files inspection were run after the final edits.

## Decisions

- Pi text remains the sole stored conversation authority; parser recovery and clipboard canonicalization are presentation projections only.
- Search state and dialog in-flight state are browser-local presentation controls, while live dialog/queue truth remains in the owning runtime slot and its snapshot.
- Queue rows and extension surfaces are transient runtime projection, not synthetic `ChatMessage` records.
- Inherited advisories in Pi's supported shrinkwrapped tree remain truthful residual risk and never justify an unsupported override or a downgrade from latest Pi.
