---
purpose: Pi conversation references resolve into an authenticated, session-bound resource list and a defensive right-pane preview rather than unrestricted browser filesystem access.
covers:
  - shared/contracts.ts
  - shared/resource-references.ts
  - server/resources.ts
  - server/image-content.ts
  - server/project-files.ts
  - server/git-inspection.ts
  - server/app.ts
  - server/runtime.ts
  - src/api.ts
  - src/resources.ts
  - src/resource-preview.ts
  - src/diff.ts
  - src/controllers/resource-controller.ts
  - src/controllers/git-controller.ts
  - src/controllers/workspace-controller.ts
  - src/components/ContextPane.tsx
  - src/components/ContextPaneState.tsx
  - src/components/context-pane-view.ts
  - src/components/ContextSplitBody.tsx
  - src/components/FilesPane.tsx
  - src/components/FilePreview.tsx
  - src/components/ChangesPane.tsx
  - src/components/WorkspaceBrowser.tsx
  - src/components/NotebookPreview.tsx
  - src/components/PaneResizeHandle.tsx
  - src/components/RichText.tsx
  - src/components/Transcript.tsx
  - src/App.tsx
  - src/store.ts
  - src/styles.css
  - src/styles/*.css
  - tests/server/app.test.ts
  - tests/server/resources.test.ts
  - tests/server/git-inspection.test.ts
  - tests/server/runtime.test.ts
  - tests/web/resources.test.ts
  - tests/web/resources-pane.test.tsx
  - tests/web/git-controller.test.ts
  - tests/web/pane-resize.test.tsx
  - tests/web/workspace-controller.test.ts
  - tests/web/rich-text.test.tsx
  - tests/web/store.test.ts
  - tests/browser/workbench.spec.ts
---

# Resource preview

## Goal

Make files and artifacts referenced during Pi work inspectable beside the conversation without turning the browser into an unrestricted filesystem client.

## Checks

- With no selected file, Files opens on a bounded Browse surface: at most five deduplicated `Recent in this chat` references from one 16-reference host page, followed by the indexed workspace tree. Recent rows stay on one compact line: a file icon anchors the filename, a CSS-ellipsized subdued parent path uses the remaining space, and Git state stays fixed at the trailing edge. Workspace search replaces those sections only while a query is present. Selecting a recent, search, or tree row replaces Browse with a stable vertical stack: the workspace tree remains above the selected file, while search and Recent yield the constrained space; the compact `← <project folder>` header returns to the complete Browse surface without discarding its query or expansion state. The actual project-folder basename, not a generic `Workspace`, labels that tree in both states. Its default fixed upper boundary matches the Browse boundary after Search plus Recent, so selection does not move the file-content boundary. Files and Changes share that upper height, divider, section/header geometry, and narrow-drawer hierarchy rather than carrying an internal resize mechanism or switching to a separate mobile component. The compact navigation explorer shares the workspace controller's lazy directory levels, expansion, selection, and Git decoration state but intentionally omits search. Opening a workspace file emits one explicit reveal request after expanding its ancestors; unrelated tree updates do not repeatedly scroll the selection. Directory/search requests are accepted only while cwd, session, and browser transport generation still match; switching away caches tree/search state by cwd, while refresh invalidates and reloads the root plus expanded levels. The host still derives and caches the complete ordered conversation-reference index independently of transcript pagination, and authorization uses that complete index regardless of the five rows presented in Browse.
- Resource discovery understands Pi’s structured tool path arguments, embedded image content, CLI `<file name="…">` references, explicit local Markdown links and images, `file://` links, common source/configuration extensions and extensionless project filenames, and credible inline local path references without treating remote web URLs as local files.
- Relative references resolve against the owning session’s project directory. A local file becomes previewable through exactly two authorities: an exact reference in the owning session’s authoritative message projection, or membership in the session workspace’s project index (the same index behind composer file search and the navigation explorer). Index authority ends at the workspace realpath boundary — an indexed symlink never opens an outside file — and ignored trees such as `node_modules` are reachable only through an explicit transcript reference.
- A bare name is shorthand, not a location claim: when no file sits where it literally points, the host recovers it through the owning workspace's project index only if exactly one indexed file carries that name, and answers with the location it actually opened. Several matches are returned as candidates for the user to choose between; a reference carrying a directory part of its own is never recovered, and index recovery never borrows a citation's authority to leave the workspace.
- Every host resource operation receives a concrete session, non-empty branch-view generation, projection revision, workspace root, and exactly one message source: either an immediate projection or a lazy loader. There is no anonymous legacy view, zero-revision default, or empty-message fallback. The host proactively probes every explicitly loaded recent row without allocating content handles, sharing one lazy transcript projection across citation checks. Probe transport stays capped at 16 references per request; each completed batch merges incrementally and is reused only within the exact `{session, branch view, projection revision, browser API/transport}` generation. A failed batch may mark only its own references `unknown`; it never overwrites prior confirmed standing. The explicit Files refresh renews the bounded recent list, probe standing, workspace index, and selected preview without explicitly requesting Git status. Ordinary transcript appends revalidate Recent only while Browse is visible and keep its previous page and standing until current results arrive; a visible Preview neither loads hidden Recent rows nor remounts its reader. A failed, malformed, or incomplete batch is visibly `unknown`, remains eligible for retry, and never allows an omitted reference to be represented as verified. Before selection, rows distinguish missing, unauthorized, invalid, ambiguous, and unknown references. Successful probe/resolve results may return the canonical project-index path so conversation and workspace rows share selection and Git identity without exposing an absolute host path; a later transfer failure leaves that resolved standing intact.
- The project index never offers a tracked path whose working-tree file is gone, and a preview that finds an indexed file missing invalidates the index so the next scan stops offering it.
- The host returns an opaque authenticated resource handle after validation and never accepts that handle as authority for another unreferenced path. The handle carries the runtime's opaque branch-view generation plus a retained, never-streamed descriptor for the resolved `{device, inode}`. The Host opens the lexical path selected by the reference and uses Linux's descriptor-to-path witness to prove that it resolves to the authorized canonical target; an already-canonical final component additionally uses `O_NOFOLLOW`. That anchor keeps the authorized inode allocated for the handle's bounded lifetime, so an inode cannot be recycled beneath a stale pathname. Every content request re-validates the visible session, current generation, and original citation/index/embedded authority before sending headers or bytes, repeats the descriptor witness, and compares its opened object to the anchor; a final-component or ancestor exchange is refused rather than streamed, while a legitimate in-place rewrite of the still-authorized object remains observable. An ordinary append may retain a citation handle only while its authorizing message remains on the active path. Embedded image authority additionally requires a supported image MIME type, bounded decoded size, and canonical Base64 on the exact projection read that supplies its bytes.
- HTML, Markdown, SVG, and Jupyter Notebook files default to Preview and expose Source as the reciprocal secondary view. Notebook Preview is a static reading surface for Markdown and code cells, execution counts, text/error outputs, and embedded images; it never executes notebook code. Plain text, code, JSON, and YAML are Source-only; images, PDF, audio, and video are Preview-only; unsupported binaries present file information. Host-owned Preview, Source, and Changes content use one luminosity-aware neutral canvas across Amber and Jade so product theme does not tint the inspected content; authored artifact backgrounds and semantic source/Diff colors remain intact. The fixed view-action slot remains visible but disabled when the reciprocal mode does not exist, so switching files does not move the header. Text transfers are capped at 256 KiB and place a truncation marker at the actual Source boundary; truncated Markdown and HTML also mark the rendered Preview so partial content cannot be mistaken for the complete file. Blob-backed image, PDF, audio, and video previews are capped at 32 MiB and report the limit instead of allocating larger files. Once content arrives, its current total replaces resolve-time size metadata in the descriptor; resolve size remains discovery metadata only.
- The selected-file header remains fixed above scrolling content. Its path is the Copy path action, Download is a same-origin attachment link that streams from the authenticated resource route without first allocating the complete file in browser memory, and the reciprocal Preview/Source action occupies the stable trailing slot. Source uses highlighted text with stable line numbers; a `:line` or `#Lline` suffix establishes the bounded source position after content arrives. Files does not duplicate Changes with a Diff mode or spend header space on Copy all, Go to line, persistent file size, or an Add to prompt action.
- Switching to Changes preserves the canonical selected workspace file whether or not Git reports it as changed. The upper region keeps the repository identity and compact staged/working/conflict counts above grouped changed paths. The lower region always presents Source: an unchanged selected file shows `+0 −0` with disabled navigation, while a changed file presents the selected comparison’s complete source with additions and deletions inline, exact counts, and non-wrapping previous/next change navigation. Working comparisons present working-tree source, staged comparisons present index source, and both retain explicit Git identity. Background status polling preserves the selected diff and reader position while that exact path and side remain present; explicit inspection refreshes the diff, while a vanished selection clears it. Deleted, untracked, binary, submodule, conflict, outside-workspace, and non-UTF-8 states expose only the content and navigation their real Git state supports rather than inventing source lines.
- HTML stays outside the conversation DOM, and both HTML and PDF frames use an empty sandbox capability set: no scripts, same-origin privilege, forms, or top-level navigation. HTML also has no unrestricted subresource loading. The mock-host Chromium gate opens an actual cited local HTML fixture that declares a remote image, then rejects any external HTTP(S) request while the sandboxed frame parses it.
- External HTTP, HTTPS, and mail links preserve ordinary safe-link behavior rather than passing through the privileged local-file resolver.
- Resource selection, availability standing, and loaded-object URLs are cleared when the visible session, same-session branch-view generation, or browser transport/API identity changes, so previews cannot leak across branch or pairing ownership. Selection replacement, pane close, and either switch also abort the obsolete resolve or content request; a filesystem response closes its exact opened handle even when cancellation lands while that handle is opening.
- Indexed workspace resolution does not fetch the conversation transcript. Transcript messages load lazily only for citation or embedded-content authority. Ordinary same-branch append keeps the opaque view stable; explicit navigation or worker/projection reset changes it and invalidates outstanding conversation-derived authority.

## Non-goals

- Workspace Browse is not an editor or unrestricted filesystem client; it exposes only the bounded project index and session-authorized resources.
- Active HTML execution, arbitrary remote URL fetching, and unrestricted absolute-path browsing are not supported.
- Every path-like word in prose does not have to become a resource; structured and explicit references take priority over speculative matching.
