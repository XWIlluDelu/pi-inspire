---
scope:
  - shared/commands.ts
  - shared/contracts.ts
  - server/runtime.ts
  - server/preferences.ts
  - server/mock.ts
  - src/composer-completion.ts
  - src/store.ts
  - src/components/Composer.tsx
  - src/components/ModelSelector.tsx
  - src/components/Settings.tsx
  - src/App.tsx
  - src/styles.css
  - tests/server/**
  - tests/web/**
---

# Daily-use accelerators

## Objective

Add composer completion, a scalable model picker, and opt-in completion attention by reusing Pi, project-index, preference, and browser authorities already present.

## Outcome

- Caret-aware `@` completion queries only the owning session’s project index, supports multiword paths and directory-sensitive local ranking, removes only the active token, restores the caret, and stages the canonical result through the existing deduplicated project-file chip contract. Search loading, empty, failure, obsolete-response, IME, pointer, and keyboard states are explicit. Its ARIA 1.1 combobox composite keeps DOM focus in the multiline textbox while the focused textbox owns list control and active-descendant relationships.
- Leading `/` completion combines Pi’s authoritative extension, prompt, and skill commands with inspire’s host-owned `/compact`, grouped by source. Pi collisions preserve first wire ownership (extension before prompt/skill in Pi’s dispatch order), after which `/compact` is explicitly overridden by the host descriptor/parser that executes it. Selection edits the draft with one argument delimiter without sending.
- Completion remains isolated by session and preserves multiline, steering/follow-up, Escape, attachment, explicit file-picker, and delivery behavior. Project-file chips are frozen during delivery and only the exact accepted delivery clears its owning partition.
- The model picker groups only Pi-provided models by canonical provider identity, searches provider/id/display fields locally, indexes active descendants by selectable options rather than headings, labels active/recent/capability state, and exposes truthful thinking compatibility. Enter, click, and Escape restore focus to the stable trigger even when selection ownership continues asynchronously; a later rejected model mutation and its error rerender leave that trigger focused. A bounded, deduplicated global MRU records successful selections only and is a secondary order within each provider; unavailable identities remain harmless preference history rather than becoming a catalog.
- Completion attention is an explicit `off | title | desktop` preference and defaults off. Agent and standalone-manual-compaction arms are owned separately: nested threshold/overflow/manual compaction cannot consume or notify ahead of its agent, while standalone compaction terminates exactly once on its own end event and cannot taint a later settle. Bootstrap/resync status never creates ownership and duplicate terminals do not qualify. Socket loss clears every arm; an authoritative snapshot retains an already-observed arm only while its matching operation remains live, and removes it when the session is absent or no longer in a matching live state. Foreground selected work is silent, while a selected session in a hidden/unfocused tab qualifies. Title attention composes with extension titles and clears on owning view/focus. Desktop permission is requested only by the Settings gesture, denied/unsupported states preserve prior intent, and OS title/body/tag use only fixed outcome copy, opaque session identity, and cwd-derived project metadata—never catalog title/first-message text. Notification clicks focus and select the owning session.

## Verified

- [x] Pure parser/ranking tests cover multiword project queries, caret-local replacement, command boundaries, source preservation, directory/basename ranking, and fuzzy descriptions.
- [x] Composer interaction tests cover keyboard/pointer selection, focused-textbox ARIA ownership inside the valid combobox composite, Pi first-dispatch collision precedence plus host `/compact` override, exact insertion/caret restoration, IME deferral, Shift+Enter and Escape isolation, loading/empty/failure states, stale-result suppression, canonical chip deduplication, and in-flight chip freezing/session ownership.
- [x] Model tests cover canonical provider grouping, fuzzy fields, provider-local MRU ordering, unavailable MRU filtering, active-descendant keyboard selection, Enter/click focus restoration across async ownership, an integrated delayed API rejection/error rerender with focus retained, successful-only persistence, and failed-selection rollback.
- [x] Attention tests cover off/title/desktop intent, granted/denied/unsupported permission states, no bootstrap inference, hidden selected behavior, foreground silence, agent versus nested/standalone compaction exact-once ownership, disconnect invalidation, idle-snapshot retirement, matching-active-snapshot retention, truthful standalone compaction failure, success/failure/abort outcomes, duplicate terminals, extension-title composition, title clearing, and notification click routing. A real SessionCatalog projection test proves an unnamed title comes from firstMessage, and the browser boundary test proves that secret never enters Notification title/body/tag.
- [x] Preference migration and bounds, runtime `/compact` routing, Settings accessibility, and the affected server/web integration surfaces are covered.
- [x] Focused suites, serialized full `npm run check -- --maxWorkers=1`, and production `npm run build` passed after the review fixes. No browser smoke is claimed for this review pass.

## Decisions

- Project files, Pi commands, and Pi models retain their existing authorities. Completion and recency are projections, not new catalogs.
- Canonical model identity is `{ provider, id }`; mutable display names and capability facts are never persisted as identity or preference truth.
- Browser notification permission remains browser-owned and is never persisted. A selected session in a hidden or unfocused document counts as unseen.
- Desktop denial does not silently rewrite intent to title mode; the Settings control explains title attention as the portable alternative.
