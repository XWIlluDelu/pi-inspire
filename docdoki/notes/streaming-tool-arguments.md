---
kind: implementation-evidence
updated: 2026-09-09
---

# Streaming tool argument cards

## Outcome

Pi JSON/RPC >=0.84.3 supplies tool identity/name at `toolcall_start` (upstream
PR #7953; verified installed Pi 0.85.1 `docs/rpc.md` and `dist/modes/json-event.js`).
INSΠRE now creates that named card immediately, streams a bounded argument preview,
and preserves the same call identity through execution and authoritative results.
Older identity-less starts retain end-only behavior.

Contracts: [[../specs/activity-presentation]], [[../specs/session-transport]],
[[../specs/conversation]].

## Implementation boundaries

- `server/tool-argument-stream.ts`: one-pass, worker/message-owned JSON preview
  parser. Escapes, nested objects/arrays, and complete primitives are supported;
  sensitive keyed values are discarded/redacted before any transport update.
  The parser retains no cumulative raw argument JSON.
- `shared/tool-argument-updates.ts` and `shared/assistant-stream.ts`: immutable
  path updates and call identity/preview metadata shared by both projections.
  Prototype-shaped keys remain inert own properties. Interruption metadata is
  derived from failed/aborted assistant outcomes, including persisted projection.
- `server/runtime-events.ts`: raw Pi arguments become bounded Host-authored
  updates, not browser-visible raw JSON. Final ToolCall data is projected once
  into a complete replacement instead of duplicated in a raw delta envelope.
- `server/runtime-stream-budget.ts`: append-only body updates account for exact
  JSON growth, including escaping, split surrogates and revision/preview metadata,
  without serializing cumulative assistant messages. Structural and final updates
  retain full validation. Item-budget reduction marks the projected message and
  publishes a bounded replacement: a character count cannot witness other
  argument paths being removed from the tree.
- `server/tool-argument-batches.ts`, `server/runtime-event-sockets.ts`, and browser
  event/connection reducers: adjacent same-tool fragments coalesce within the
  existing 16ms window. `sourceEventCount` preserves revision continuity and the
  2,048-source-event batch limit. Background sessions receive no argument bodies.
- Existing cards/registry remain authoritative for presentation. Write bodies use
  the native Content block immediately; other tools show their named shell, then
  typed content when their partial shape is compatible. States distinguish
  generating arguments, waiting to execute, running, and actual outcomes.
  Partial/interrupted paths cannot open resources; copies explicitly say preview.
  Collapsed cards do not build code bodies or eagerly serialize clipboard data.

## Bounds and limitations

The display parser permits 32,000 decoded string characters per tool, eight path
segments, 256 nodes, 256-character keys, and 256,000 inspected source characters.
Limit/malformed-prefix handling freezes an explicitly truncated preview; later
fragments generate no repeated updates. Code/replacement preview DOM is capped at
400 lines during generation/interruption. These are display limits, not file-size
or execution limits. The completed call and persisted message still obey the
pre-existing Host transcript projection bounds (not unlimited full-file copies).

New clients consume normalized patches, not public Pi raw argument JSON. Existing
text/thinking transport and complete joining-socket replacements remain in place.
A joining socket can still incur cumulative replacement serialization during its
bounded snapshot handshake; the measured linear wire result below concerns
established detail viewers. Host activation requires a restart and browser refresh;
this task did not restart the user's live Host or interrupt active Pi work.

## Evidence

- Parser tests cover arbitrary fragment boundaries, partial strings, escaped keys,
  Unicode/split surrogate escapes, nested edit arrays, numbers/booleans/null,
  redacted scalar/container values, prototype keys, malformed source and limits.
- Runtime tests verify early shells, snapshot/shared-reducer equivalence,
  interleaved extension messages and multiple calls, canonical end replacement,
  late-fragment suppression, failure/persistence adoption, and exact byte budgets.
  The final item-budget regression requires a complete checkpoint instead of a
  pre-clipping argument patch. With the added failed-tool persistence case,
  Node 22 runtime-stream-budget/runtime-projection/session-projection passed
  **105/105** against the concurrent Pi 0.85.1 update
  (`/tmp/inspire-tool-stream-budget-final.log`).
- Browser reducer tests verify coalesced revision spans, snapshot continuation,
  duplicate/wrong-identity/gap rejection, and interruption.
- Actual authenticated WebSocket test: a **157,814-byte** serialized write call,
  capped at **32,000 preview characters**, yielded **18 batches / 39,191 bytes**
  of additional JSON before optional compression. Repeated cumulative projection
  of those same updates would have encoded **4,487,639 bytes**. No message/tool
  bodies reached the simultaneous background viewer. Final authoritative events
  are outside this incremental-byte measurement. Batch counts can vary with
  scheduling; assertions require bounded total bytes, not an exact count.
- Host-only serialization work: 1,000 and 2,000 eight-character body fragments
  serialized 10,000 and 20,000 fragment bytes respectively, with **zero** cumulative
  assistant-message serializations during the append hot path.
- Node **22.23.2** full repository check passed before the concurrent Pi baseline
  upgrade. Final frozen-source Pi **0.85.1** `npm run ci` then passed under Node
  **22.19.0**: formatting/lint/types/Knip/build, 17 portable tests, 1,257 Vitest
  tests, six launcher tests, and 34 Chromium tests (three existing skips across
  Vitest/launcher). Final integration was run by the baseline-update session;
  its log `/tmp/inspire-pi-0851-final-ci.log` was inspected at closeout. Stage:
  [[follow-streaming-tool-arguments-2026-09-08]].
- Chromium repository suite: **34/34 passed**. In addition, Playwright CLI on the
  built mock Host injected normalized receipt fixtures through the real browser
  connection handler: early write shell, in-place code growth, waiting → running →
  success without duplicate cards, non-actionable partial paths, explicitly
  labelled clipboard preview, 400-line cap and interrupted `Not executed` state.
  Reviewed 1280px light and 390px dark screenshots with no card overflow. These
  browser fixtures did **not** invoke a live model or write a real file.

Local browser artifacts: `output/playwright/tool-stream-{shell,content-light,
content-narrow-dark,finished-narrow,interrupted-narrow}.png`. Full check and browser
logs: `/tmp/inspire-tool-stream-check.log` and
`/tmp/inspire-tool-stream-browser-suite.log` (local, not committed evidence).

## Follow-up: edit diff fallback during generation

The reported loss of red/green edit formatting was a shape-validation bug, not
missing CSS. `editReplacements` required every array item to contain both strings;
the parser's normal next-item `{}` or oldText-only prefix invalidated the entire
presentation. The completed prefix returned to diff view only after newText began.
Truncation/interruption at that boundary could leave the raw view indefinitely.

The native edit rule now distinguishes absent preview fields from wrong types.
It accepts incomplete array items and legacy single replacements only when the
call has Host-owned preview metadata. Missing old/new sides have no diff rows,
not fabricated empty-string changes. Numbered preview headings remain stable as
items arrive, and no final replacement count is claimed during generation.
Rendering is a pure projection of the current call, not a cached last-good view:
fresh observers reproduce the same content, and malformed authoritative calls
still fall back. Resource/copy gating, 400-line preview bounds, selected-rule
ownership and successful `details.patch` authority are unchanged.

Verification (2026-09-09):

- The initial regression run reproduced six failing cases on the prior renderer.
  `tests/web/streaming-edit-cards.test.tsx` now covers 22 cases: new array items,
  missing/empty sides, different field orders, legacy calls, DOM identity,
  interruption/truncation, fresh-observer reconstruction, wrong types, strict
  completed calls, and successful/error/incompatible result adoption.
- Node **22.19.0**: formatting, lint, typecheck, Knip and frontend build passed;
  full working-tree Vitest (excluding the separately scoped launcher suite)
  passed **154 files / 1,571 tests**, with **2 skipped**. That run also included
  the then-uncommitted restart controls. Log:
  `/tmp/inspire-edit-stream-check.log`.
- Playwright CLI exercised the actual parser → shared immutable updates → native
  registry → ToolCard path in an isolated static Vite fixture, with no Host proxy
  or real sessions. Every character was rendered and asserted to remain typed;
  starting the next replacement retained earlier DOM rows. 1280px light and 390px
  dark views retained red/green tint, full scroll-width row backgrounds, no page
  overflow, and distinct generating/interrupted/waiting/applied states.
  Screenshots: `output/playwright/edit-stream-{desktop-light,narrow-dark,
  interrupted-dark,applied-dark}.png`. The fixture's only console error was its
  missing favicon. These checks do not claim a live model or real file edit.

This follow-up changes only frontend presentation; the frontend was rebuilt and
no live Host restart is required for this fix (refresh the browser).
