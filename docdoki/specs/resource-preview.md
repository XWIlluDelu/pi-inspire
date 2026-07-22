---
purpose: Pi conversation references resolve into an authenticated, session-bound resource list and a defensive right-pane preview rather than unrestricted browser filesystem access.
covers:
  - shared/contracts.ts
  - server/resources.ts
  - server/app.ts
  - server/runtime.ts
  - src/resources.ts
  - src/components/ResourcesPane.tsx
  - src/components/RichText.tsx
  - src/components/Transcript.tsx
  - src/App.tsx
  - src/store.ts
  - src/styles.css
  - tests/server/resources.test.ts
  - tests/web/resources.test.ts
  - tests/web/rich-text.test.tsx
---

# Resource preview

## Goal

Make files and artifacts referenced during Pi work inspectable beside the conversation without turning the browser into an unrestricted filesystem client.

## Checks

- The right contextual region presents files and resources referenced by the selected session, and selecting a reference opens its preview in that region.
- Resource discovery understands Pi’s structured tool path arguments, embedded image content, CLI `<file name="…">` references, explicit local Markdown links and images, `file://` links, and credible inline local path references without treating remote web URLs as local files.
- Relative references resolve against the owning session’s project directory, but every local file—including a project-local file—requires an exact reference in the owning session’s authoritative message projection.
- The host returns an opaque authenticated resource handle after validation and never accepts that handle as authority for another unreferenced path.
- Images use an image preview, PDFs use the browser’s document viewer, Markdown/text/code remain readable and copyable, and supported audio or video uses browser-native controls; unsupported or missing files produce explicit metadata and error states.
- HTML stays outside the conversation DOM and previews in a sandboxed frame without scripts, same-origin privilege, forms, top-level navigation, or unrestricted subresource loading.
- External HTTP, HTTPS, and mail links preserve ordinary safe-link behavior rather than passing through the privileged local-file resolver.
- Resource selection and loaded-object URLs are cleared when the visible session changes, so previews cannot leak across session ownership.

## Non-goals

- The first preview surface is not a full file explorer or editor.
- Active HTML execution, arbitrary remote URL fetching, and unrestricted absolute-path browsing are not supported.
- Every path-like word in prose does not have to become a resource; structured and explicit references take priority over speculative matching.
