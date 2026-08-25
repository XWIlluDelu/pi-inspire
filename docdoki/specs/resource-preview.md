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
  - src/controllers/workspace-controller.ts
  - src/components/ResourcesPane.tsx
  - src/components/WorkspaceBrowser.tsx
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
  - tests/web/workspace-controller.test.ts
  - tests/web/rich-text.test.tsx
  - tests/web/store.test.ts
  - tests/browser/workbench.spec.ts
---

# Resource preview

## Goal

Make files and artifacts referenced during Pi work inspectable beside the conversation without turning the browser into an unrestricted filesystem client.

## Checks

- Files opens on a bounded Browse surface: at most five deduplicated `Recent in this chat` references from one 16-reference host page, followed by the indexed workspace tree. Workspace search replaces those sections only while a query is present. Selecting a recent, search, or tree row enters one full-pane Preview surface; Back restores Browse with its query, expansion, and scroll state intact. The compact navigation explorer shares the workspace controller's lazy directory levels, expansion, selection, and Git decoration state but intentionally omits search. Directory/search requests are accepted only while cwd, session, and browser transport generation still match; switching away caches tree/search state by cwd, while refresh invalidates and reloads the root plus expanded levels. The host still derives and caches the complete ordered conversation-reference index independently of transcript pagination, and authorization uses that complete index regardless of the five rows presented in Browse.
- Resource discovery understands Pi’s structured tool path arguments, embedded image content, CLI `<file name="…">` references, explicit local Markdown links and images, `file://` links, and credible inline local path references without treating remote web URLs as local files.
- Relative references resolve against the owning session’s project directory. A local file becomes previewable through exactly two authorities: an exact reference in the owning session’s authoritative message projection, or membership in the session workspace’s project index (the same index behind composer file search and the navigation explorer). Index authority ends at the workspace realpath boundary — an indexed symlink never opens an outside file — and ignored trees such as `node_modules` are reachable only through an explicit transcript reference.
- A bare name is shorthand, not a location claim: when no file sits where it literally points, the host recovers it through the owning workspace's project index only if exactly one indexed file carries that name, and answers with the location it actually opened. Several matches are returned as candidates for the user to choose between; a reference carrying a directory part of its own is never recovered, and index recovery never borrows a citation's authority to leave the workspace.
- Every host resource operation receives a concrete session, non-empty branch-view generation, projection revision, workspace root, and exactly one message source: either an immediate projection or a lazy loader. There is no anonymous legacy view, zero-revision default, or empty-message fallback. The host proactively probes every explicitly loaded recent row without allocating content handles, sharing one lazy transcript projection across citation checks. Probe transport stays capped at 16 references per request; each completed batch merges incrementally and is reused only within the exact `{session, branch view, projection revision, browser API/transport}` generation. A failed batch may mark only its own references `unknown`; it never overwrites prior confirmed standing. The explicit Files refresh renews the bounded recent list, probe standing, workspace index, and selected preview without explicitly requesting Git status. A failed, malformed, or incomplete batch is visibly `unknown`, remains eligible for retry, and never allows an omitted reference to be represented as verified. Before selection, rows distinguish missing, unauthorized, invalid, ambiguous, and unknown references. Successful probe/resolve results may return the canonical project-index path so conversation and workspace rows share selection and Git identity without exposing an absolute host path; a later transfer failure leaves that resolved standing intact.
- The project index never offers a tracked path whose working-tree file is gone, and a preview that finds an indexed file missing invalidates the index so the next scan stops offering it.
- The host returns an opaque authenticated resource handle after validation and never accepts that handle as authority for another unreferenced path. The handle carries the runtime's opaque branch-view generation plus a retained, never-streamed descriptor for the resolved `{device, inode}`. That anchor keeps the authorized inode allocated for the handle's bounded lifetime, so an inode cannot be recycled beneath a stale pathname. Every content request re-validates the visible session, current generation, and original citation/index/embedded authority before sending headers or bytes, opens the retained path with `O_NOFOLLOW`, and compares its opened object to the anchor; a symlink swap or inode-reused replacement is refused rather than streamed, while a legitimate in-place rewrite of the still-authorized object remains observable. An ordinary append may retain a citation handle only while its authorizing message remains on the active path.
- Images use an image preview, PDFs use the browser’s document viewer, Markdown/text/code remain readable and copyable, and supported audio or video uses browser-native controls; unsupported or missing files produce explicit metadata and error states. Text transfers are capped at 256 KiB and marked truncated against the current total reported by that content response (`Content-Range` for a range, received blob length for a full transfer); blob-backed image, PDF, audio, and video previews are capped at 32 MiB and report the limit instead of allocating larger files. Once content arrives, that same current total replaces resolve-time size metadata in the displayed descriptor; resolve size remains discovery metadata only.
- Text/code Preview shows the resolved relative path, highlighted source with stable line numbers, Copy, and an explicit line-jump control. A `:line` or `#Lline` resource suffix triggers the same bounded jump after content arrives. `Add to prompt` is available only when resolution supplied a canonical workspace path and becomes disabled once that path is already attached.
- Selecting a workspace-backed resource synchronizes its exact Git change identity. A changed file exposes File and Diff without losing the loaded file preview; Changes reuses that selection, and selecting a changed path can return to the same session-authorized working-tree file. Deleted, outside-workspace, or non-UTF-8 Git paths remain diff-only with an explicit reason.
- Git diff is a unified preview, not a merge editor. A single 40px contextual gutter shows the old line on deletion, the new line on addition, and the current line on context; `+`/`−` text, hunk headers, and row treatment provide the other reading cues. Full old/new coordinates remain in each gutter cell’s accessible label and tooltip.
- HTML stays outside the conversation DOM and previews in a sandboxed frame without scripts, same-origin privilege, forms, top-level navigation, or unrestricted subresource loading. The mock-host Chromium gate opens an actual cited local HTML fixture that declares a remote image, then rejects any external HTTP(S) request while the sandboxed frame parses it.
- External HTTP, HTTPS, and mail links preserve ordinary safe-link behavior rather than passing through the privileged local-file resolver.
- Resource selection, availability standing, and loaded-object URLs are cleared when the visible session, same-session branch-view generation, or browser transport/API identity changes, so previews cannot leak across branch or pairing ownership. Selection replacement, pane close, and either switch also abort the obsolete resolve or content request; a filesystem response closes its exact opened handle even when cancellation lands while that handle is opening.
- Indexed workspace resolution does not fetch the conversation transcript. Transcript messages load lazily only for citation or embedded-content authority. Ordinary same-branch append keeps the opaque view stable; explicit navigation or worker/projection reset changes it and invalidates outstanding conversation-derived authority.

## Non-goals

- Workspace Browse is not an editor or unrestricted filesystem client; it exposes only the bounded project index and session-authorized resources.
- Active HTML execution, arbitrary remote URL fetching, and unrestricted absolute-path browsing are not supported.
- Every path-like word in prose does not have to become a resource; structured and explicit references take priority over speculative matching.
