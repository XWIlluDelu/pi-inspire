---
purpose: Session-authorized files, documents, media, and Git changes are inspectable beside the conversation.
covers:
  - shared/{contracts,resource-references}.ts
  - server/{resources,image-content,project-files,git-inspection,app,runtime,runtime-reads,mock}.ts
  - src/{api,resources,resource-preview,document-resources,diff,store,pdf-renderer}.ts
  - scripts/vite-pdf-assets.ts
  - server/static-asset-cache.mjs
  - src/controllers/{resource,git,workspace}-controller.ts
  - src/components/{ContextPane,ContextPaneState,ContextSplitBody,FilesPane,FilePreview,PdfPreview,DocumentPreview,ChangesPane,WorkspaceBrowser,NotebookPreview,PaneResizeHandle,RichText,Transcript}.tsx
  - src/components/context-pane-view.ts
  - src/App.tsx
  - src/styles.css
  - src/styles/*.css
  - tests/server/{app,resources,resources-windows-paths,runtime-reads,git-inspection,runtime}.test.ts
  - tests/web/{resources,document-resources,document-image-controller,git-controller,workspace-controller,store-resources}.test.ts
  - tests/web/{document-preview,pdf-preview,resources-pane,pane-resize,rich-text}.test.tsx
  - tests/browser/workbench.spec.ts
---

# Resource preview

## Goal

Inspect project files and conversation artifacts beside the chat. Files owns read-only discovery and
preview; Changes owns Git comparisons. [[composer]] owns file attachment and the full-image viewer.

## Browse and search

With no file selected, Files shows up to five deduplicated **Recent in this chat** references from
one 16-reference Host page, followed by the workspace filesystem tree. Search replaces both sections
while a query is present. Recent rows use an icon, filename, subdued parent path, and fixed trailing
Git state on one line.

Selecting a recent, search, or tree entry opens a fixed index/detail stack: the workspace tree stays
above the preview, while Search and Recent yield space. **← project-folder** returns to Browse with
its query, expansions, and scroll retained. The default upper boundary matches Browse after Search
and Recent, keeping the file-content boundary stable. Files and Changes share that height, divider,
headers, and narrow drawer layout, with no internal splitter.

The lower-left explorer shares the same lazy tree, expansion, selection, hidden visibility, and Git
decoration state, but omits search. Both trees use the project basename as their heading. Opening a
workspace file expands its ancestors and emits one reveal request; unrelated updates do not scroll it.

Filesystem membership is independent of Git. Browse includes ignored non-hidden files and empty
directories. **Show hidden files** defaults off and covers dot names plus native filesystem hidden
attributes. Visibility changes retire requests without closing a selected preview. Directory/search
responses require the same cwd, session, visibility, and browser transport generation. Cwd-local
state is cached across switching; Refresh reloads the root and expanded levels.

| Discovery bound | Limit |
| --- | --- |
| One directory | 10,000 inspected entries |
| Breadth-first search | 20,000 files, 10,000 directories, five-second cooperative walk budget |
| Shared search/basename cache | Five seconds; at most eight canonical-root/hidden-mode scopes |

Capped scans, unreadable entries, and non-UTF-8 names report incomplete results. Regular files,
directories, and contained links are supported; broken/outside links and special nodes are not
traversed. Missing files invalidate cached search results. Git discovery cannot invent a deleted file.

## Reference resolution and authorization

Recognized references include structured tool paths, embedded images, CLI `<file name="…">` context,
local Markdown links/images, `file://` and `vscode://file/` URLs, credible inline paths, common source
extensions, and extensionless project filenames. Windows drives, URL-encoded spaces, and line/column
suffixes are supported. HTTP, HTTPS, and mail links use ordinary external-link handling.

- Conversation-relative references resolve against the session project directory. Document links,
  inline paths, and images resolve against the opened document's actual directory, including after
  basename recovery. URL decoding is separate from literal workspace path handling.
- A local regular file needs either an exact reference in the authoritative session projection or
  containment within the session workspace's current realpath boundary. Outside-workspace symlink
  targets need their own exact transcript reference. Git state, hidden visibility, discovery results,
  and the five visible Recent rows do not grant or revoke access.
- If a bare filename is absent at its literal location, a complete bounded workspace scan may
  recover exactly one match. Several matches become user-selectable candidates; incomplete scans
  report unknown. Qualified paths and document-relative links do not use this recovery, and a
  citation cannot authorize recovery outside the workspace.
- Each operation requires the session, non-empty branch-view generation, projection revision,
  canonical workspace, and exactly one immediate or lazy message source. Contained workspace reads
  do not load the transcript; citation and embedded-image authorization load it on demand.

The Host derives a complete ordered reference index independently of transcript pagination. Lazy
message reads recheck their slot, view, and revision after reconciliation. Resources address that
session slot, never the Host's last global selection, so one browser cannot retarget another's reads.

### File handles and content

Validation returns an opaque authenticated handle bound to the branch view and an open descriptor
for the resolved device/inode. The descriptor anchors the object for the handle's bounded lifetime.
The Host opens the reference's lexical path, uses Linux descriptor-to-path evidence to check the
canonical target, and uses `O_NOFOLLOW` for an already-canonical final component.

Before sending content headers or bytes, every request revalidates session/view, citation or current
workspace containment, regular-file status, and opened-object identity. A path or ancestor exchange
is rejected; a legitimate in-place rewrite of the same authorized file remains readable. Handles
cannot authorize another path. Embedded image reads additionally validate supported MIME, decoded
size, and canonical Base64 on the projection supplying the bytes.

Same-branch append keeps the view stable and retains a citation handle only while its message stays
on the active path. Explicit branch navigation or worker/projection reset changes the view. Cache
refresh, Git ignore changes, and hidden visibility are independent of this authority.

## Availability and request ownership

Recent references are probed in batches of at most 16 without allocating content handles, sharing one
lazy transcript read. Each batch merges within its exact session/view/revision/API/transport
generation. Rows distinguish missing, unauthorized, invalid, ambiguous, and unknown references. A
failed or incomplete batch marks only its own unconfirmed references unknown and leaves them retryable.

Successful probe/resolve may return a canonical workspace-relative path for shared file/Git selection
without exposing an absolute Host path. A later transfer failure retains that resolved standing.

Explicit Files Refresh renews Recent, probes, discovery, and the selected preview without requesting
Git status. Compatible transcript appends refresh Recent only while Browse is visible and retain the
previous rows until success; a visible preview keeps its reader mounted and does not load hidden Recent.

Selection replacement, pane close, session/view change, or API/transport replacement retires affected
requests and object URLs. Cancellation closes the exact opened file even if it arrives during open.

## Readers

| File type | Default and available views |
| --- | --- |
| HTML, Markdown, SVG, Jupyter Notebook | Preview; Source is the reciprocal view. |
| Plain text, code, JSON, YAML | Source only. |
| Image, PDF, audio, video | Preview only. |
| Unsupported binary | File information. |

The selected-file header stays above scrolling content. Its path copies the path, Download streams
through the authenticated attachment route, and the reciprocal view action keeps a fixed trailing
slot, disabled when unavailable. Source uses highlighting and line numbers; `:line` and `#Lline`
open Source at that position, including for files that normally open in Preview. Files does not
duplicate Changes with a Diff mode or add file-editing controls.

Host-owned Preview, Source, and Changes use a luminosity-aware neutral canvas across Amber and Jade.
Authored backgrounds and semantic source/diff colors remain intact. Images use a neutral checkerboard
behind their pixels; full-viewer background options follow [[composer]]. The bounded media button
respects intrinsic aspect ratio, including viewBox-only SVGs, without tinting letterboxing.

Text transfer is capped at 256 KiB, with a marker at the Source cutoff and in truncated Markdown/HTML
Preview. Image, PDF, audio, and video blobs are capped at 32 MiB. Loaded content size replaces the
resolve-time size estimate.

### Documents and local images

Notebook Preview statically renders Markdown cells, highlighted code, execution counts, text/error
output, and images. Highlighting uses notebook language metadata, with common kernel-name recovery;
error traces retain line breaks and omit ANSI escapes. Notebook code is not executed. Markdown raw
HTML is disabled.

Local document images load inline through independently authorized resource requests and document-owned
blob URLs. Reading a document does not authorize linked files. Each mounted document deduplicates at
most 64 image references, runs four transfers concurrently, retains at most 64 MiB of image blobs,
and keeps the 32 MiB per-image cap. Loading, transfer/authorization/limit errors, and decode failures
retain the image description. Replacement, Source switching, close, or session/view/transport change
retires transfers and URLs; compatible appends do not.

Notebook `attachment:` images use only that cell's bounded canonical Base64 raster MIME bundles.
External and protocol-relative images are explicit links; unsupported protocols and unrecognized
conversation image paths do not trigger automatic requests.

Local heading fragments scroll within the document; cross-document fragments apply after renderer
and image layout. Reader interaction cancels pending automatic positioning.

### HTML, PDF, and media

HTML stays outside the conversation DOM in an empty-sandbox iframe. Scripts, forms, top navigation,
and external subresources are blocked.

PDF uses a lazy, local PDF.js worker to render one page at a time, with selectable text, page
navigation, zoom, and fit-to-width. Zoom and resize preserve the reading position. It renders static
page content; document scripts, interactive links/forms, and embedded media are inactive. Malformed
or password-protected files show a readable error while retaining Download.

Chromium's native viewer blocked rendering in an empty sandbox, but executed PDF OpenAction JavaScript
without it despite `script-src 'none'`. This is why the reader uses static PDF.js rather than an embed;
[[follow-interface-review-2026-09-29]] records the Chromium 153 check.

The page backing canvas is capped at four million pixels, 8192 pixels per dimension, and a device
pixel ratio of two. Closing or replacing the reader cancels rendering and destroys its worker.
PDF.js fonts, CMaps, and JavaScript image decoders are shipped locally and retained with their build
generation.

Audio and video use native playback controls. The page media policy allows same-origin and blob
sources for the authorized preview.

## Git Changes

Switching to Changes preserves the canonical selected workspace file whether or not it appears in
Git status. The upper region shows repository identity, staged/working/conflict counts, and grouped
paths. The lower region shows Source with the selected comparison's inline additions/deletions,
counts, and non-wrapping previous/next change controls.

- Working comparisons use working-tree source; staged comparisons use index source. An empty
  comparison reports no diff rather than substituting disk content for index source.
- Without an authoritative comparison, counts are `—` and navigation is disabled. Absence from a
  bounded status result cannot distinguish clean, ignored, omitted, non-repository, or unavailable
  states; only a concrete diff establishes zero counts.
- Deleted, untracked, binary, submodule, conflict, outside-workspace, and non-UTF-8 states expose the
  content their Git state supports. Rename comparisons use the selected side's old and new paths.
  A pure rename is not a whole-file addition.
- Polling retains the selected path/side and reader position while that comparison remains present;
  explicit inspection refreshes the diff, and a vanished selection clears it. Git selection intent
  owns the pane, so a delayed Files response cannot replace a newer Git choice.
- Unified-diff file headers are recognized outside hunk bodies. Hunk lines with repeated `+` or `-`
  remain edits with correct line numbers.

## Checks

Resource, workspace, and Git tests cover authority, limits, filesystem changes, cancellation, and
selection races. The workbench browser test also opens a cited HTML fixture containing a remote image
and checks that parsing it sends no external HTTP(S) request. PDF checks cover painted pixels,
selectable text, page/zoom state across layout changes, worker disposal, and inactive document actions.
Document behavior is covered by [[document-relative-previews]] and [[follow-interface-review-2026-09-29]];
filesystem/Git separation is in [[filesystem-git-separation]].
