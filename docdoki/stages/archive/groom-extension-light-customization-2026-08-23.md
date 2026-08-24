---
scope:
  - README.md
  - package.json
  - shared/contracts.ts
  - server/runtime.ts
  - server/runtime-slot.ts
  - server/runtime-worker-lifecycle.ts
  - src/App.tsx
  - src/events.ts
  - src/store.ts
  - src/styles.css
  - src/components/AppTopbar.tsx
  - src/components/ExtensionDisplays.tsx
  - src/components/Transcript.tsx
  - src/components/transcript-rows.tsx
  - tests/server/pi-compat.integration.test.ts
  - tests/server/runtime.test.ts
  - tests/web/app.test.tsx
  - tests/web/events.test.ts
  - tests/web/store.test.ts
  - tests/web/transcript-inspection.test.tsx
  - docs/extensions.md
  - docs/tool-presentations.md
  - docdoki/spec_abstract.md
  - docdoki/specs/pi-integration.md
---

# Extension light customization

## Objective

Give users with existing Pi Extensions a bounded, coherent way to adapt useful capabilities into INSΠRE without turning the product into a second agent runtime or an arbitrary frontend plugin host.

## Outcome

- INSΠRE now projects Pi's official string widget state above and below the Composer with bounded, copyable, responsive cards; TUI component factories remain unsupported rather than being guessed into Web UI.
- The Host mirrors bounded keyed Extension statuses so reconnect restores current values and worker replacement or failure clears stale values; the desktop top bar presents them in deterministic order.
- Extension-derived transcript batching and string widgets share one ANSI-safe text presentation primitive instead of duplicating terminal cleanup and raw-text card rendering.
- The public Extension guide provides the compatibility matrix, placement and visual rules, upgrade boundary, and worked Todo, usage, and custom-tool adaptations needed for coherent source-level DIY work.
- The existing Command Palette, generic status/activity surfaces, extension UI dialogs, and declarative Tool Presentation configuration remain the preferred no-code or low-code paths; no frontend plugin manifest, event bridge, fixed Extensions pane, or arbitrary React/CSS injection API was introduced.
- Pi compatibility, worker lifecycle, browser projection, store reset, and responsive rendering have focused coverage; the full project check and desktop/mobile browser inspection pass.
