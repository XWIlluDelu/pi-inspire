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
  - src/resource-preview.ts
  - src/controllers/resource-controller.ts
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

- The right contextual region presents files and resources referenced by the selected session, and selecting a reference opens its preview in that region. The list is recent-first: it presents the eight most recent references, then `Earlier files (N)` enters continuous history by requesting one cursor-bound 64-row page. Further pages load one at a time only as the same bounded scroll region nears its end; one request may be in flight, a failed page leaves confirmed rows in place with one cursor-specific retry, and a `Recent files` collapse cancels the request. The browser virtualizes a large loaded prefix instead of mounting one row per historical reference, and never drains the complete cursor from one disclosure. The host derives an ordered reference index from the selected branch projection independently of transcript pagination, caches that index by `{session, branch view, projection revision}`, and shares it across list, probe, resolve, and revalidation. The browser merges the current page ahead of the index so live references appear immediately, and accepts every response or cursor only while session, branch view, transcript revision, and the captured browser API/transport generation still match. Authorization continues to use the complete index regardless of which rows the browser has loaded.
- Resource discovery understands Pi’s structured tool path arguments, embedded image content, CLI `<file name="…">` references, explicit local Markdown links and images, `file://` links, and credible inline local path references without treating remote web URLs as local files.
- Relative references resolve against the owning session’s project directory. A local file becomes previewable through exactly two authorities: an exact reference in the owning session’s authoritative message projection, or membership in the session workspace’s project index (the same index behind composer file search and the navigation explorer). Index authority ends at the workspace realpath boundary — an indexed symlink never opens an outside file — and ignored trees such as `node_modules` are reachable only through an explicit transcript reference.
- A bare name is shorthand, not a location claim: when no file sits where it literally points, the host recovers it through the owning workspace's project index only if exactly one indexed file carries that name, and answers with the location it actually opened. Several matches are returned as candidates for the user to choose between; a reference carrying a directory part of its own is never recovered, and index recovery never borrows a citation's authority to leave the workspace.
- The host proactively probes every explicitly loaded resource row without allocating content handles, sharing one lazy transcript projection across citation checks. Probe transport stays capped at 16 references per request; each completed batch merges incrementally and is reused only within the exact `{session, branch view, projection revision, browser API/transport}` generation, while later history pages probe only their newly loaded references. A later failed batch may mark only its own references `unknown`; it never overwrites a prior batch's confirmed standing or marks that standing retryable. The Files refresh labels itself as file refresh rather than Git refresh and renews the bounded resource-list/probe generation without invoking Git status. Every response carries and is checked against that same revision, and pane reopen or the explicit Files refresh invalidates the generation so same-revision filesystem changes can be observed. A failed, malformed, or incomplete batch is visibly `unknown`, remains eligible for an explicit retry, and never allows an omitted reference to be represented as verified. Before selection, rows distinguish a missing path, a reference outside current session authority, invalid syntax, an ambiguous bare name that needs a location choice, and an unknown probe standing. A path copied from another machine is observable only as missing here — the host does not pretend to know its origin. A later successful resolve clears the mark; a transfer that fails after a successful resolve is a transfer failure and leaves the reference's standing intact.
- The project index never offers a tracked path whose working-tree file is gone, and a preview that finds an indexed file missing invalidates the index so the next scan stops offering it.
- The host returns an opaque authenticated resource handle after validation and never accepts that handle as authority for another unreferenced path. The handle carries the runtime's opaque branch-view generation plus a retained, never-streamed descriptor for the resolved `{device, inode}`. That anchor keeps the authorized inode allocated for the handle's bounded lifetime, so an inode cannot be recycled beneath a stale pathname. Every content request re-validates the visible session, current generation, and original citation/index/embedded authority before sending headers or bytes, opens the retained path with `O_NOFOLLOW`, and compares its opened object to the anchor; a symlink swap or inode-reused replacement is refused rather than streamed, while a legitimate in-place rewrite of the still-authorized object remains observable. An ordinary append may retain a citation handle only while its authorizing message remains on the active path.
- Images use an image preview, PDFs use the browser’s document viewer, Markdown/text/code remain readable and copyable, and supported audio or video uses browser-native controls; unsupported or missing files produce explicit metadata and error states. Text transfers are capped at 256 KiB and marked truncated against the current total reported by that content response (`Content-Range` for a range, received blob length for a full transfer); blob-backed image, PDF, audio, and video previews are capped at 32 MiB and report the limit instead of allocating larger files. Once content arrives, that same current total replaces resolve-time size metadata in the displayed descriptor; resolve size remains discovery metadata only.
- HTML stays outside the conversation DOM and previews in a sandboxed frame without scripts, same-origin privilege, forms, top-level navigation, or unrestricted subresource loading.
- External HTTP, HTTPS, and mail links preserve ordinary safe-link behavior rather than passing through the privileged local-file resolver.
- Resource selection, availability standing, and loaded-object URLs are cleared when the visible session, same-session branch-view generation, or browser transport/API identity changes, so previews cannot leak across branch or pairing ownership. Selection replacement, pane close, and either switch also abort the obsolete resolve or content request; a filesystem response closes its exact opened handle even when cancellation lands while that handle is opening.
- Indexed workspace resolution does not fetch the conversation transcript. Transcript messages load lazily only for citation or embedded-content authority. Ordinary same-branch append keeps the opaque view stable; explicit navigation or worker/projection reset changes it and invalidates outstanding conversation-derived authority.

## Non-goals

- The first preview surface is not a full file explorer or editor.
- Active HTML execution, arbitrary remote URL fetching, and unrestricted absolute-path browsing are not supported.
- Every path-like word in prose does not have to become a resource; structured and explicit references take priority over speculative matching.
