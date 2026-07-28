---
purpose: Pi conversation references resolve into an authenticated, session-bound resource list and a defensive right-pane preview rather than unrestricted browser filesystem access.
covers:
  - shared/contracts.ts
  - server/resources.ts
  - server/project-files.ts
  - server/app.ts
  - server/runtime.ts
  - src/api.ts
  - src/resources.ts
  - src/components/ResourcesPane.tsx
  - src/components/RichText.tsx
  - src/components/Transcript.tsx
  - src/App.tsx
  - src/store.ts
  - src/styles.css
  - tests/server/app.test.ts
  - tests/server/resources.test.ts
  - tests/server/runtime.test.ts
  - tests/web/resources.test.ts
  - tests/web/rich-text.test.tsx
  - tests/web/store.test.ts
---

# Resource preview

## Goal

Make files and artifacts referenced during Pi work inspectable beside the conversation without turning the browser into an unrestricted filesystem client.

## Checks

- The right contextual region presents files and resources referenced by the selected session, and selecting a reference opens its preview in that region. The list is a bounded recent-first projection: it presents at most an explicit number of references and says so, rather than implying the earlier ones are gone — the transcript and the workspace explorer stay the complete routes. The bound belongs to that projection alone; authorization still reads the session's complete reference set.
- Resource discovery understands Pi’s structured tool path arguments, embedded image content, CLI `<file name="…">` references, explicit local Markdown links and images, `file://` links, and credible inline local path references without treating remote web URLs as local files.
- Relative references resolve against the owning session’s project directory. A local file becomes previewable through exactly two authorities: an exact reference in the owning session’s authoritative message projection, or membership in the session workspace’s project index (the same index behind composer file search and the navigation explorer). Index authority ends at the workspace realpath boundary — an indexed symlink never opens an outside file — and ignored trees such as `node_modules` are reachable only through an explicit transcript reference.
- A bare name is shorthand, not a location claim: when no file sits where it literally points, the host recovers it through the owning workspace's project index only if exactly one indexed file carries that name, and answers with the location it actually opened. Several matches are returned as candidates for the user to choose between; a reference carrying a directory part of its own is never recovered, and index recovery never borrows a citation's authority to leave the workspace.
- A reference the host cannot resolve is marked unavailable in the list instead of continuing to read as an ordinary file, and the mark clears if the same reference later resolves. A transfer that fails after a successful resolve is a transfer failure and leaves the reference's standing intact.
- The project index never offers a tracked path whose working-tree file is gone, and a preview that finds an indexed file missing invalidates the index so the next scan stops offering it.
- The host returns an opaque authenticated resource handle after validation and never accepts that handle as authority for another unreferenced path. Every content request re-validates that the handle’s session is still the visible one — a handle resolved in one session stops serving the moment another session is selected, including selection changes that land while an awaited message fetch is in flight.
- Images use an image preview, PDFs use the browser’s document viewer, Markdown/text/code remain readable and copyable, and supported audio or video uses browser-native controls; unsupported or missing files produce explicit metadata and error states. Text transfers are capped at 256 KiB and marked truncated; blob-backed image, PDF, audio, and video previews are capped at 32 MiB and report the limit instead of allocating larger files.
- HTML stays outside the conversation DOM and previews in a sandboxed frame without scripts, same-origin privilege, forms, top-level navigation, or unrestricted subresource loading.
- External HTTP, HTTPS, and mail links preserve ordinary safe-link behavior rather than passing through the privileged local-file resolver.
- Resource selection and loaded-object URLs are cleared when the visible session changes, so previews cannot leak across session ownership. Selection replacement, pane close, and session switch also abort the obsolete resolve or content request; a filesystem response closes its exact opened handle even when cancellation lands while that handle is opening.
- Indexed workspace resolution does not fetch the conversation transcript. Transcript messages load lazily only for citation or embedded-content authority and are reused at the same per-session message revision; any intervening message event invalidates that projection.

## Non-goals

- The first preview surface is not a full file explorer or editor.
- Active HTML execution, arbitrary remote URL fetching, and unrestricted absolute-path browsing are not supported.
- Every path-like word in prose does not have to become a resource; structured and explicit references take priority over speculative matching.
