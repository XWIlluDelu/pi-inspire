---
scope:
  - shared/contracts.ts
  - server/preferences.ts
  - src/App.tsx
  - src/components/Settings.tsx
  - src/store.ts
  - src/styles.css
  - tests/server/preferences.test.ts
  - tests/web/app.test.tsx
---

# Settings upgrade

## Outcome

Complete. Settings uses a responsive modal with Display, Conversation, Behavior, and Updates
navigation, scroll tracking, field-owned persistence, and modal focus handling. Install, Pi links,
and Restore defaults remain footer actions.

The earlier six-category/search design was superseded by this four-category layout without search.
Current behavior, including Pi/Herdr controls and the separate restart controls, is specified in
[[interface-preferences]].

## Evidence

`src/components/Settings.tsx` defines the current groups and controls;
`tests/web/settings-navigation.test.tsx`, `tests/web/modal-focus.test.tsx`, and
`tests/server/preferences.test.ts` cover navigation, focus, and persistence.
