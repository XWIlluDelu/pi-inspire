---
purpose: Pi conversation references resolve into an authenticated, session-bound resource list and a defensive right-pane preview rather than unrestricted browser filesystem access.
covers:
  - shared/contracts.ts
  - shared/resource-references.ts
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
  - tests/web/resources-pane.test.tsx
  - tests/web/rich-text.test.tsx
  - tests/web/store.test.ts
---

# Resource preview

## Goal

Make files and artifacts referenced during Pi work inspectable beside the conversation without turning the browser into an unrestricted filesystem client.

## Checks

- The right contextual region presents files and resources referenced by the selected session, and selecting a reference opens its preview in that region. The list is recent-first: it presents the most recent references and, when earlier ones exist, a trailing disclosure row ("Earlier files (N)" with a flipping chevron) expands the full set in place inside the list's existing bounded scroll region — the affordance itself carries the "this is partial" semantics, no explanatory note. The host derives that complete list from the selected branch projection independently of transcript pagination; the browser merges the current page ahead of it so live references appear immediately, and accepts a response only while session, branch view, and transcript revision still match. The bound belongs to presentation alone; authorization continues to read the complete branch reference set.
- Resource discovery understands Pi’s structured tool path arguments, embedded image content, CLI `<file name="…">` references, explicit local Markdown links and images, `file://` links, and credible inline local path references without treating remote web URLs as local files.
- Relative references resolve against the owning session’s project directory. A local file becomes previewable through exactly two authorities: an exact reference in the owning session’s authoritative message projection, or membership in the session workspace’s project index (the same index behind composer file search and the navigation explorer). Index authority ends at the workspace realpath boundary — an indexed symlink never opens an outside file — and ignored trees such as `node_modules` are reachable only through an explicit transcript reference.
- A bare name is shorthand, not a location claim: when no file sits where it literally points, the host recovers it through the owning workspace's project index only if exactly one indexed file carries that name, and answers with the location it actually opened. Several matches are returned as candidates for the user to choose between; a reference carrying a directory part of its own is never recovered, and index recovery never borrows a citation's authority to leave the workspace.
- The host proactively probes the bounded visible resource list without allocating content handles, sharing one lazy transcript projection across citation checks. Before selection, rows distinguish a missing path, a reference outside current session authority, invalid syntax, and an ambiguous bare name that needs a location choice. A path copied from another machine is observable only as missing here — the host does not pretend to know its origin. A later successful resolve clears the mark; a transfer that fails after a successful resolve is a transfer failure and leaves the reference's standing intact.
- The project index never offers a tracked path whose working-tree file is gone, and a preview that finds an indexed file missing invalidates the index so the next scan stops offering it.
- The host returns an opaque authenticated resource handle after validation and never accepts that handle as authority for another unreferenced path. The handle carries the runtime's opaque branch-view generation. Every content request re-validates the visible session, current generation, and the original citation/index/embedded authority before sending headers or bytes; an ordinary append may retain a citation handle only while its authorizing message remains on the active path.
- Images use an image preview, PDFs use the browser’s document viewer, Markdown/text/code remain readable and copyable, and supported audio or video uses browser-native controls; unsupported or missing files produce explicit metadata and error states. Text transfers are capped at 256 KiB and marked truncated against the current total reported by that content response (`Content-Range` for a range, received blob length for a full transfer); blob-backed image, PDF, audio, and video previews are capped at 32 MiB and report the limit instead of allocating larger files. Once content arrives, that same current total replaces resolve-time size metadata in the displayed descriptor; resolve size remains discovery metadata only.
- HTML stays outside the conversation DOM and previews in a sandboxed frame without scripts, same-origin privilege, forms, top-level navigation, or unrestricted subresource loading.
- External HTTP, HTTPS, and mail links preserve ordinary safe-link behavior rather than passing through the privileged local-file resolver.
- Resource selection and loaded-object URLs are cleared when the visible session or same-session branch-view generation changes, so previews cannot leak across branch ownership. Selection replacement, pane close, and either switch also abort the obsolete resolve or content request; a filesystem response closes its exact opened handle even when cancellation lands while that handle is opening.
- Indexed workspace resolution does not fetch the conversation transcript. Transcript messages load lazily only for citation or embedded-content authority. Ordinary same-branch append keeps the opaque view stable; explicit navigation or worker/projection reset changes it and invalidates outstanding conversation-derived authority.

## Non-goals

- The first preview surface is not a full file explorer or editor.
- Active HTML execution, arbitrary remote URL fetching, and unrestricted absolute-path browsing are not supported.
- Every path-like word in prose does not have to become a resource; structured and explicit references take priority over speculative matching.
