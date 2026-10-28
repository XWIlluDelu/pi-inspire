---
purpose: Session-authorized files, documents, media, and Git changes are inspectable beside the conversation.
covers:
  - shared/{contracts,resource-references}.ts
  - server/{resources,resource-http,html-preview,image-content,project-files,git-inspection,git-runner,app,runtime,runtime-reads,mock}.ts
  - shared/html-preview.ts
  - src/{api,resources,resource-preview,document-resources,diff,source-diff,file-icons,syntax-highlighting,store,pdf-renderer}.ts
  - scripts/vite-pdf-assets.ts
  - server/static-asset-cache.mjs
  - src/controllers/{resource,git,workspace}-controller.ts
  - src/components/{ContextPane,ContextPaneState,ContextSplitBody,FilesPane,FilePreview,PdfPreview,DocumentPreview,ChangesPane,WorkspaceBrowser,ResourcePathLabel,SearchMatchText,NotebookPreview,PaneResizeHandle,RichText,Transcript}.tsx
  - src/components/context-pane-view.ts
  - src/App.tsx
  - src/styles.css
  - src/styles/*.css
  - tests/server/{app-resources,app-auth,resources,resources-windows-paths,resource-reference-identity,runtime-reads,git-inspection,git-configuration,runtime-selection}.test.ts
  - tests/web/{resources,document-resources,document-image-controller,resource-read-recovery,git-controller,workspace-controller,store-resources}.test.ts
  - tests/web/{document-preview,pdf-preview,file-preview,resources-pane,search-match-text,changes-pane,pane-resize,rich-text}.test.tsx
  - tests/web/{source-diff,file-icons,syntax-highlighting}.test.ts
  - tests/server/html-preview.test.ts
  - tests/browser/{filesystem-files,document-images,pdf-preview,html-preview,resource-reading}.spec.ts
---

# Resource preview

## Goal

Inspect project files and conversation artifacts beside the chat. Files owns read-only discovery and
preview; Changes owns Git comparisons. [[composer]] owns file attachment and the full-image viewer.

## Browse and search

The Files tool tab shows up to five deduplicated **Recent in this chat** references from
one 16-reference Host page, followed by the workspace filesystem tree. Search replaces both sections
while a query is present. Recent rows use an icon, filename, subdued parent path, and fixed trailing
Git state on one line. File icons, filename/parent labels and match emphasis follow [[design-system]].
Search stacks the filename above its parent directory; both the row and caption retain full-path
hover titles, and the row's accessible name and open target keep that exact path. Workspace search
has one explicit clear/loading control. Matching uses Host lowercase, whitespace-separated substring
terms on the full path, projected into filename and parent fields, including path-spanning terms,
without changing titles or bidi isolation.

Selecting a recent, search, or tree entry opens or selects a filename tab beside the fixed tool tabs.
Its reader uses the complete content area on desktop and narrow screens; Files has no index/detail
stack. Returning to the Files tab restores its query, expansions and scroll. File/tool tabs share
one narrow browser-history level, while Changes retains its separate detail level under
[[workspace-layout]]. The browser uses `--bg-context`; the selected file's path/actions bar and
reader use `--bg-surface`, without an extra shadow or raised frame.

The Files tree uses the project basename as its heading. Opening a workspace file expands its
ancestors and emits one reveal request; unrelated updates do not scroll it. Leaf rows reserve the
folder disclosure slot, aligning sibling file/folder icons and names. Recent and flat search results
retain their existing alignment.

Filesystem membership is independent of Git. Browse includes ignored non-hidden files and empty
directories. **Show hidden files** defaults off and covers dot names plus native filesystem hidden
attributes. Visibility changes retire requests without closing a selected preview. Directory/search
responses require the same cwd, session, visibility, and browser transport generation. Cwd-local
state is cached across switching; Refresh revalidates the root, expanded levels and current query
without first discarding their confirmed contents. A visibility change retires the previous projection.
Transient directory/search failures recover automatically in a bounded owner-scoped window. Pending
rereads and persistent refresh errors leave existing rows usable, rather than replacing them with
loading/unavailable states. Success clears the corresponding error. A different query clears the old
query's results; switching workspace or transport cancels pending waits and stale responses. Returning
to a workspace revalidates failed visible directories and its failed/pending search without another
recovery gesture.

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
extensions, and extensionless project filenames. Native Windows drives, UNC paths and either
home/relative separator spelling are recognized without relying on a known filename extension.
Locations accept `:line[:column]`, `#Lline` and MSVC `(line[,column])` suffixes. Quoting, a whole path
line or a diagnostic location can delimit spaces in paths; ambiguous prose cannot authorize a
shorter prefix. Explicit reference surfaces own their contents, rather than yielding overlapping
partial citations. Remote URLs remain external, including paths inside their query strings.

- Structured tool/file-context fields are literal native filesystem text, even if they look like a
  URL or end with a line-number suffix. The input adapter escapes URI/diagnostic metacharacters before
  indexing and transport. Native paths in prose/code may carry explicit diagnostic locations; actual
  Markdown, OSC 8 and file/VS Code URLs retain their link syntax. Protocol references are link-form,
  decoded once only after parsing that syntax. Original native labels and exact `workspacePath` values
  never pass through the URL decoder. URI escaping has its own transport allowance without enlarging
  the native path limit.
- Index identity retains representation, escaping and URL authority. A literal `%20` filename and a
  URL naming a space file remain separate, including outside-workspace citation authority; resolution
  never chooses whichever interpretation happens to exist. Literal `#`, `?`, `%` and diagnostic-looking
  filename bytes retain their file target. Host-returned references normalize only native separators
  for document-relative URL joining, not the browser platform's filesystem conventions.
- Conversation-relative references resolve against the session project directory. Document links,
  inline paths, and images resolve against the opened document's actual directory, including after
  basename recovery. URL decoding is separate from literal workspace path handling.
- A local regular file needs either an exact reference in the authoritative session projection or
  containment within the session workspace's current realpath boundary. Outside-workspace symlink
  targets need their own exact transcript reference. Git state, hidden visibility, discovery results,
  and the five visible Recent rows do not grant or revoke access.
- Filesystem containment follows actual directory semantics, not an OS-wide case-folding assumption.
  On POSIX and Windows, case/Unicode-normalization similarity only identifies possible aliases;
  nonidentical prefixes need a current directory-identity proof. Distinct roots and unknown identities
  grant no workspace authority. This boundary also confines interactive HTML asset capabilities and
  project-file attachments. Ordinary canonical prefixes do not require per-file ancestor filesystem
  walks.
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
The Host opens the reference's lexical path and checks its resolved path and opened-file identity
against the canonical target. It also uses `O_NOFOLLOW` for an already-canonical final component.

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
failed or incomplete batch leaves confirmed standing intact and marks only previously unconfirmed
references unknown. Unknown is not an unavailable-file warning and does not prevent an authorized
open attempt. Failed batches retry automatically in a bounded owner-scoped window.

Successful probe/resolve may return a canonical workspace-relative path for shared file/Git selection
without exposing an absolute Host path. A later transfer failure retains that resolved standing.
Preview resolution and content transfers recover transient failures with bounded, cancellable backoff
under the original selection and authority. A same-authority refresh retains loaded content and its
object URL until replacement succeeds. Persistent transient failure identifies the retained content
as stale; a successful refresh removes that feedback. Confirmed missing or revoked access replaces
the old preview with its actual failure, rather than retaining it as usable. Authority replacement
never inherits old content. Refresh retires interactive HTML immediately, even while static content
remains visible; recovery does not restart execution.

Explicit Refresh renews Recent and probes in Files, or the selected preview in a file tab, alongside
workspace discovery without requesting Git status. Compatible transcript appends refresh Recent only
while Browse is visible and retain previous rows until success; a visible preview keeps its reader
mounted and does not load hidden Recent.
Transient Recent reads recover automatically without replacing retained rows with retry controls.
An initial read remains loading during recovery; after persistent failure its local empty surface
says Recent is unavailable rather than claiming there are no references. The existing Files Refresh
remains the explicit refresh action. Pane close or owner changes cancel pending recovery.

Selection replacement, pane close, session/view change, or API/transport replacement retires affected
requests and object URLs. Cancellation closes the exact opened file even if it arrives during open.

Ordinary prompt confirmation and compatible transcript appends leave the current preview mounted.
Within the same session and workspace, a changed branch view or replaced projection retains a visible
Files selection while resolving and loading it again under the new authority. A recovered workspace
path remains the exact target, rather than repeating a bare-name search. Failed reauthorization stays
in the selected-file detail with its error; it does not navigate to Browse. Session/workspace changes
and positional `pi-embedded://` references still clear selection, because rewritten coordinates may
identify a different image. Reauthorization does not reopen a preview the user has already left for
Browse or another context mode, and interactive HTML never inherits its retired execution lease.

## Readers

| File type | Default and available views |
| --- | --- |
| HTML, Markdown, SVG, Jupyter Notebook | Preview; Source is the reciprocal view. |
| Plain text, code, JSON, YAML | Source only. |
| Image, PDF, audio, video | Preview only. |
| Unsupported binary | File information. |

Native text formats include PowerShell/CMD scripts, installed POSIX shell profiles, Objective-C,
MSBuild/project files and text property lists. Binary `bplist00` property lists stay binary; their
bounded signature is read only through the already-authorized descriptor. Text/Markdown, HTML,
notebook and SVG Source decode UTF-8 by default and honor UTF-8/UTF-16LE/UTF-16BE BOMs. A capped
transfer withholds an incomplete trailing code point; its existing truncation marker remains.
Encoding is not guessed from locale, extension or file existence. HTML reconstructed for static
preview declares UTF-8 explicitly. Downloads retain complete original bytes, including BOM and
line endings.

The selected-file header stays above scrolling content. Its path copies the path; Download mints a
15-second single-use origin/session/resource transfer ticket through authenticated fetch, then uses
the browser's native download to stream complete raw bytes. Consumption rechecks current session/view
authority and file membership; the URL carries no master/API bearer. The anchor sends only origin
referrer information so native WebKit can prove same-origin when it omits Origin/Fetch Metadata.
Explicit conflicting origin evidence still rejects, and lack of all proof never authorizes the ticket.
Pending issuance is retired
when selection, session, view or transport changes. Downloads do not inherit preview byte limits or
buffer arbitrary files in JavaScript. Dual-view files retain one reciprocal view action
in a fixed trailing slot. Files with no alternative view omit that action. Source uses highlighting and line numbers; `:line` and `#Lline`
open Source at that position, including for files that normally open in Preview. Refreshing the
same selected file retains its chosen view and Source reading offsets while replacing the content.
While the contextual pane remains open, switching file/tool tabs restores each file's selected view
and Source/rendered scroll offsets.
Closing its tab, or changing session, workspace or transport, discards that retained reading context.
This does not retain iframe-internal interaction or media playback state. HTML execution
leases remain separate and are still retired on refresh or leaving the file tab. Files does not
duplicate Changes with a Diff mode or add file-editing controls. Files Source and Changes share an unframed, full-width source canvas below the fixed header, without
outer card padding; inner text spacing remains. Their line-number gutters stay visible during
horizontal scrolling. Changes line numbers and change marks share the source line baseline despite
smaller gutter numerals; blank/context rows retain the same gutter alignment. Rendered
document/media previews and loading/error states retain their padding.
Source, Markdown code blocks and
Notebook cells highlight recognized languages up to 64 Ki characters per leaf; larger leaves retain
text and copying without highlighting. Markdown Preview and Notebook prose follow Content text size;
resource headers and controls keep their independent UI sizing.

Host-owned reading canvases follow the palette-independent neutral roles in [[design-system]],
preserving authored backgrounds and semantic source/diff colors. Images use a neutral checkerboard
behind their pixels; full-viewer background options follow [[composer]]. The bounded media button
respects intrinsic aspect ratio, including viewBox-only SVGs, without tinting letterboxing.

Text transfer is capped at 256 KiB, with a marker at the Source cutoff and in truncated Markdown/HTML
Preview. Image, PDF, audio, and video blobs are capped at 32 MiB. Loaded content size replaces the
resolve-time size estimate. Preview transfers bound headers and body to 120 seconds plus allowance
at 128 KiB/s of the requested byte limit. Expiry ends the read and shows a preview error; selection
replacement cancels observation even if the transport ignores abort.

### Documents and local images

Notebook Preview statically renders Markdown cells, highlighted code, execution counts, text/error
output, and images. Execution prompts share the first code/text-output baseline, including at different
reading sizes; image and rich-document output keep their top-aligned layout. Highlighting prefers
`language_info.name`, then `kernelspec.language`, then recognized `kernelspec.name` identifiers (including versioned Python/Julia, IR, Deno/TypeScript,
JavaScript/Node.js, Bash, Ruby and common compiled-language kernels). Unknown names stay plain text;
Julia is registered alongside the common syntax grammars. Kernel display names are not language authority;
error traces retain line breaks and omit ANSI escapes. Markdown cells leave the prompt gutter empty
while retaining the common cell-body alignment. Notebook output thumbnails load lazily; readers opened
at a fragment retain eager image layout for reliable anchor positioning. Gallery inspection loads the
selected full image eagerly. Notebook code is not executed. Markdown raw HTML is disabled.

Local document images load inline through independently authorized resource requests and document-owned
blob URLs. Reading a document does not authorize linked files. Each mounted document deduplicates at
most 64 image references, runs four transfers concurrently, retains at most 64 MiB of image blobs,
and keeps the 32 MiB per-image cap. Loading, transfer/authorization/limit errors, and decode failures
retain the image description. Replacement, Source switching, close, or session/view/transport change
retires transfers and URLs; compatible appends do not.

Local Markdown figures, Notebook attachments, Markdown-output figures and raster outputs open the
shared image inspector and participate in their document gallery ([[composer]]). Authored image
links retain link navigation rather than nesting inspection buttons inside anchors; their loaded
images remain reachable through gallery navigation. Inspection never adds image transfers or
extends document/source ownership.

Notebook `attachment:` images use only that cell's bounded canonical Base64 raster MIME bundles.
External and protocol-relative images are explicit links; unsupported protocols and unrecognized
conversation image paths do not trigger automatic requests.

Local heading fragments scroll within the document; cross-document fragments apply after renderer
and image layout. Reader interaction cancels pending automatic positioning.

### HTML, PDF, and media

HTML defaults to static rendering outside the conversation DOM in an empty-sandbox iframe.
Scripts, forms, top navigation and external subresources are blocked until the user chooses
**Enable interaction** in the file header. That click authorizes execution without a second dialog:
users decide which files they trust. Interactive mode permits JavaScript, page-internal interaction,
animation, and normal HTTP(S) resource loading, including external scripts, styles, images and
network requests. Browser CORS, mixed-content rules and any policy authored by the document still
apply. It is not restricted to self-contained HTML.

**Stop interaction** destroys the running frame and returns to static Preview. Source, another file
or tool tab, file replacement/refresh, pane close, session/view or browser-transport replacement also retire
execution and its capability. Returning to Preview does not auto-run the page. A compatible transcript
append does not reset it. The action shows a busy indicator while authorization is pending and
remains unpressed until authorization succeeds. Loading can be stopped; a late start response releases its own capability
rather than activating the current selection. A failed start retains the static preview and offers
the same explicit action again. Truncated HTML has no execution action.

The Host serves interactive documents from a separate preview route with its own CSP and
`sandbox allow-scripts`; the iframe independently uses the same sandbox. Neither grants
`allow-same-origin`, popup, top-navigation, form or download privileges. Main-application CSP and
API origin checks are unchanged. The opaque-origin document cannot read Inspire's DOM, origin
storage or browser pairing key, and receives no Host credentials or internal control bridge. HTTP(S)
and WebSocket networking is allowed, not represented as offline execution.

An authenticated start creates a revocable random capability for the exact loaded HTML snapshot.
The capability URL, not browser pairing, authorizes document and asset requests. Every request
rechecks the original resource's current session/view authority and anchored file identity.
Relative assets stream with correct MIME, byte ranges and credential-free CORS for opaque-origin
module/font/fetch requests. Local scope is the canonical workspace for a contained document, or
the containing directory for an explicitly cited external document; traversal and escaping
symlinks are refused. Site-root URLs such as `/assets/app.js` still address the Inspire origin,
not a project application server. This reader does not run a project's dev server or server-side
code. The Host retains at most 32 live capabilities; stopping releases the corresponding capability.
The loaded HTML retains the 256 KiB text-preview bound; assets stream rather than being bundled
into the page or copied into browser-owned blobs.

PDF uses a lazy, local PDF.js worker to render one page at a time, with selectable text, page
navigation, zoom, and fit-to-width. Zoom and resize preserve the reading position. It renders static
page content; document scripts, interactive links/forms, and embedded media are inactive. Malformed
or password-protected files show a readable error while retaining Download.

A Chromium 153 check found that its native viewer blocked rendering in an empty sandbox,
but executed PDF OpenAction JavaScript without that sandbox despite `script-src 'none'`.
The reader therefore uses static PDF.js rather than an embedded native viewer.

The page backing canvas is capped at four million pixels, 8192 pixels per dimension, and a device
pixel ratio of two. Closing or replacing the reader cancels rendering and destroys its worker.
PDF.js fonts, CMaps, and JavaScript image decoders are shipped locally and retained with their build
generation.

Audio and video use native playback controls. The page media policy allows same-origin and blob
sources for the authorized preview.

## Git Changes

Read-only inspection retains a closed set of data configuration: line-ending and filesystem
settings, ignore/attribute rules, and protected directory trust. Native scope precedence includes
repository, worktree and submodule-local overrides. Data is snapshotted once per operation; if a
submodule needs a different conditional global-data context, inspection reports that context as
unsupported rather than misreporting its working state.

Inspection does not execute hooks, external diff/textconv or clean/process filters, nor fetch
missing objects automatically. A comparison that needs an external conversion fails visibly rather
than comparing unconverted bytes as a normal diff. Machine patch output is independent of color
and display settings that alter patch grammar. This read-only interface is not a sandbox for a
repository whose configuration is being maliciously replaced during inspection.

A failed refresh retains the previous result with one visible stale-result notice, including clean
and non-repository results. Initial failure does not claim a Git result.

Switching to Changes preserves the canonical selected workspace file whether or not it appears in
Git status. The upper region shows repository identity, staged/working/conflict counts, and grouped
paths. The lower region shows Source with the selected comparison's inline additions/deletions,
counts, and non-wrapping previous/next change controls. The current change uses an edge marker
without replacing the addition/deletion background colors. The old/new line numbers and change sign
share a sticky gutter with an opaque matching row tint, keeping code from showing beneath it;
the active edge marker stays visible during horizontal scrolling. Changed-file rows use the shared
file icons from [[design-system]] alongside their Git decoration.

Source comparisons reuse the Source highlighting palette and 64 Ki-character bound per revision.
Highlight old and new source independently with full Git context, then render balanced token spans
in the existing rows. Deletions use the old revision and its original filename for renames; additions
and shared context use the selected new revision. Unknown languages and oversized revisions remain
escaped plain text. Highlighting does not change source text, selection/copying or row/navigation
geometry.

A newly encountered text diff positions its first change inside the source viewport without
scrolling the outer page or changing focus. Within the mounted context pane, vertical/horizontal
reading offsets and manually navigated change selection survive file/side changes, tab switches
and diff reloads. Memory is scoped by transport, session, workspace, path identity and side; it is
not persisted across app reloads.

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
and checks that static rendering sends no external HTTP(S) request. Interactive HTML API/component
and desktop/narrow browser checks cover explicit start/stop, loaded-version execution, local modules,
fetch and ranged media, external resources, opaque-origin isolation, revocation, stale starts,
branch/file changes, and local scope. PDF checks cover painted pixels,
selectable text, page/zoom state across layout changes, worker disposal, and inactive document actions.
[[workbench-implementation]] explains reference resolution and filesystem/Git separation.
