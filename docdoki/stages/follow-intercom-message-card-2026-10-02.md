---
scope:
  - shared/tool-presentation-config.ts
  - src/custom-message-presentations.ts
  - src/tool-presentations/registry.ts
  - src/components/CustomMessage.tsx
  - src/styles/{transcript,activity-cards}.css
  - tests/web/custom-message*.test.{ts,tsx}
  - tests/web/fixtures/custom-message-presentation.ts
  - tests/browser/custom-message.spec.ts
  - tests/server/{app,tool-presentation-config}.test.ts
---

# Declarative custom-message reading

## Outcome

Optional version-1 `customMessages` declarations select a reading title, source and exact Markdown
body while preserving complete copy and lazy original-data Details. Incompatible shapes retain
generic rendering; refreshed bootstrap declarations update mounted cards. Contracts:
[[conversation]], [[tool-presentations]] and [[rich-rendering]].

Intercom provided the motivating structured-message example. Its sender/body selectors and
absent-provenance guard remain user-owned mappings, not shipped extension-specific behavior.
Messages with unverified external origin retain their original warning rather than losing that
qualification in a simplified header. [[custom-message-presentation]] retains the rationale.

Shared table sizing also preserves word minima and local horizontal overflow. Inherited prose
`overflow-wrap: anywhere` had split short table words; long-token wrapping outside tables is unchanged.

## Recorded verification

- Component/resolver, tool/Thinking compatibility, schema/loading, authenticated bootstrap and style
  tests cover exact bodies, complete copy, lazy inspection, shape fallback and provenance guards.
  Custom types with spaces/Unicode and existing version-1 tool declarations remain valid.
- Fresh-build Chromium checks use an isolated mock Host: keyboard disclosure/focus, 44px touch controls,
  sender wrapping, exact copy and table overflow. At 1280px, 390px and 320px in light/dark Amber/Jade,
  the card and transcript had no horizontal overflow; scoped Axe checks found no violations.
  TypeScript and focused formatting/lint passed.
- Images: `output/playwright/intercom-card-{amber,teal}-{light,dark}-{1280,390,320}.png` and
  `intercom-card-long-sender-320.png`. These establish browser presentation, not a live incoming-message
  round trip.

Presentation files reload through authenticated bootstrap without replacing Pi workers. Hosts whose
strict schema predates `customMessages` reject the new field; the guide records that compatibility
boundary. No runtime state or credential data belongs in a presentation profile.
