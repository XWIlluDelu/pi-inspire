---
purpose: "Pi owns branch semantics while same-file navigation and isolated fork creation retain explicit revision, writer, and publication boundaries."
covers:
  - server/runtime.ts
  - server/runtime-branch*.ts
  - server/session-{tree,projection,fork,fork-worker,export}.ts
  - server/generated-exports.ts
  - server/extensions/inspire-branch-bridge.ts
  - shared/{branch-node-actions,branch-bridge-protocol}.ts
  - src/controllers/branch-controller.ts
  - src/components/{BranchTree,EarlierBranchBanner,AppTopbar,SearchMatchText}.tsx
  - server/attachments.ts
  - shared/contracts.ts
  - src/store.ts
  - src/controllers/composer-controller.ts
  - tests/server/{runtime-branching,session-fork,session-tree,branch-bridge-extension,session-export.integration,generated-exports}.test.ts
  - tests/server/{runtime-branch-bridge,pi-branch-callback.integration}.test.ts
  - tests/web/{branch-tree,branch-store}.test.ts*
  - tests/browser/history.spec.ts
  - src/styles/{history,transcript}.css
---

# History, branches and independent copies

## Goal

Inspect Pi history without changing the active conversation merely by browsing. Deliberately
navigate, edit from, fork, or clone its native paths without inventing alternate branch semantics.
Independent copies do not replace the active source worker. Durable trust comes from
[[session-persistence]]; browser continuity comes from [[session-transport]].

## Pi-authoritative tree actions

- New sessions, naming, switching, compaction and same-file navigation use supported Pi operations;
  independent copies use `SessionManager` through the isolated boundary below. New-file
  materialization and worker admission belong to [[session-persistence]]. RPC uncertainty and
  completion-driven hooks belong to [[pi-integration]] and [[session-transport]].

  Ordinary user-input outline snippets use the shared user-content projection: readable file names
  replace transport trailers and image-dimension notes are omitted; image cues remain visible.
  Search snippets and detailed reads still expose retained source so matching paths, copying and
  editing do not depend on the shortened display.

  The branch tree is loaded through bounded projections of Pi entry identities, with older and alternate
  points still reachable and searchable. Route pages keep their containing user prompt visible when
  tool/event detail crosses a page boundary; that heading does not skip any retained activity.
  Search result snippets emphasize matches at weight 600, retaining text color, no background,
  role labels and the existing three-line clamp. History matches the whole trimmed query as a
  case-insensitive literal phrase, unlike Files' whitespace-separated terms. The shared text renderer
  preserves snippet text and accessible labels; ordinary outline entries remain unaccented.
  Turn disclosures use a quiet `Activity` caption, retain their complete accessible names and
  expanded state, and add no counts or ordinals inferred from a bounded route page.
  Route marks anchor to the first description line; current-route metadata shares that line's
  baseline. Short descriptions remain centered in their unchanged touch rows.
  No search matches use the shared pane state with a search icon and `No matching history`;
  the query remains in its input rather than being repeated in the state title.
  Complete retained text is read in bounded chunks. Native shell records expose the command, output,
  status and context inclusion as shell activity, not system bodies or storage JSON. Known Shell
  details decode the Host-generated fences into one framed Shell record with a compact header,
  separate wrapping monospaced command/output regions, and an optional truncation/full-log footer.
  The header groups identity, outcome, context inclusion and one constant Copy. Exit success/failure
  and cancellation use the existing semantic colors with a quiet tinted status marker; a dashed
  ordinary-line boundary distinguishes command from output. Stdout remains literal, without Markdown
  interpretation, syntax highlighting or terminal-insertion controls. Copy reads the complete
  retained Shell entry and removes transport fences. Read more retains the bounded entry reader; the History body
  owns scrolling rather than a nested output viewport. Once complete, the Host's separate full-output
  metadata becomes a `View full output` action for authorized file preview; its path remains in the
  tooltip and copied record. Text printed inside stdout never becomes that metadata. Ordinary
  assistant/tool content remains rich.
  Each selected non-Shell entry has one constant Copy in its detail header; Shell keeps its own
  existing header action. Copy reads all bounded chunks of the retained entry plus its structured
  images without expanding or scrolling the preview. It copies the retained record, not any
  separate full-output file or only the currently loaded excerpt. Image formats, ordering, plain-text
  alternatives and clipboard failures follow [[design-system]]. Reads bind to the same selected
  entry and transcript view throughout; leaving that entry or source cancels pending copying.
  Exact image coordinates remain Host-resolved and cancellable; saved images use the shared image viewer, with
  pointer/keyboard opening, fit/zoom, close and focus return. Retiring a read also retires its progress,
  while an older completion cannot clear a newer read's progress. Entry/image reads bind to their
  immutable entry and current transcript view, not the advancing branch revision: ordinary appends
  remain readable, while navigation and source/worker/view replacement retire the read. Same-file
  mutations still require a fresh revision. A failed image offers Retry;
  contextual Refresh retries failed selected resources. History text uses the same authorized file
  preview actions as Transcript. Structured images render separately from descriptive placeholders;
  user-written placeholder-like text remains unchanged. A failed selected detail has a local
  retry that preserves search, loaded pages and the Back anchor. Read failures wrap literal paths
  within the warning's content edges instead of clipping them or covering the preview header.
  Read-only inspection never creates
  a navigation lease.
  Deliberate switching creates a non-evictable in-memory navigation lease until the next append
  durably commits that branch. Native edit targets return their text without submitting and move
  before the selected entry, including a root user's null parent and native custom-message targets.
  Do not assume every successful target becomes the resulting leaf.

- Same-file branch navigation requires an idle, fresh, conflict-free worker with no queued input or
  pre-existing dialog. Native shell requests are rejected while navigation is pending, including while
  its extension hook awaits a dialog response. Fork addresses a retained user target by session id
  and transcript view; that input need not already be on the active path. Fork and Clone require
  materialized current-format JSONL and a conflict-free reading projection, not a matching branch
  revision or a preparatory History refresh. The Host validates the captured view and target after
  reconciliation; normal tail appends do not invalidate either. Clone explicitly captures its
  addressed endpoint when invoked rather than reading whichever leaf is latest on arrival. An explicitly empty effective path clones to a native
  header-only destination. The Host's global selection is not an admission condition: another browser
  may select a different session or deselect without disabling copies in this browser's source view. Source run
  state, writer ownership, Pending queues, and extension dialogs are not preconditions because no
  source command or replacement occurs. External-owner and terminal-handoff read-only sessions may
  be copied. The inherited project folder must be available for the independent destination.
  Browser branch-tree and branch-action requests are owned by a bounded `BranchController`; its
  current API, transport generation, selection generation, selection intent and transcript view must
  still match before it can commit a response through `AppStore`. Revisiting the same session
  cannot revive a pending Fork, Clone or Return to latest action. Preparatory History reads for
  navigation retain the original gesture's owner. Tree reads and same-session navigation
  also bind the effective leaf. Independent copies admit an exact source prefix; ordinary source
  append progress must not prevent their destination from opening after publication. A
  bootstrap or selection replacement invalidates pending tree/action requests and clears their
  actionable presentation, including the old action marker when a successful response changes the
  view. Ordinary append can invalidate the effective leaf without replacing the
  view: the still-current request must retire its loading/action marker and expose refreshable stale
  history even when its result is discarded. It cannot clear a newer request's marker.

  Extension responses use a separate process-instance-validated per-slot FIFO, so navigation hooks
  can await browser input without deadlocking the mutation FIFO and each accepted response is
  delivered exactly once. Stale revisions and ambiguous navigation bridge outcomes fail closed; an
  unverified navigation stops the worker and reconciles disk instead of retrying.

## Same-file bridge

- Same-file navigation remains on stock Pi RPC through one inspire-owned explicit extension. Each
  worker receives randomized command, status-key, and worker identities; the host accepts only one
  bounded nonce-correlated `setStatus` result, awaits both that result and prompt completion, and
  independently verifies the post-operation leaf and Pi-owned persisted effects against the native
  operation, including expected branch-summary appends and before-target/null leaves. A synchronous
  read-only `session_tree` observer captures the native anchor before callback appends; the completed
  result also carries the effective leaf. Worker entries and disk must agree on the contiguous native
  summary/label prefix and callback chain from that anchor. Valid `custom` and `custom_message`
  callbacks may become the leaf; the pre-navigation leaf is not their required parent. Intermediate
  callback appends still require same-worker entry witnesses, including while a later hook awaits
  a dialog; final acceptance retains the nonce/worker/session, handler-completion and disk fences. The internal
  command is hidden from completion and rejected at the public prompt boundary. The registered
  handler's RPC completion fences result delivery: completion without its matching result is a
  protocol failure, not a reason to wait indefinitely. Missing, duplicate, malformed, stale, or
  mismatched results are never retried after possible side effects.

## Independent Fork and Clone publication

- Fork and Clone create independent sessions, not source-runtime replacements. The host captures a
  fresh conflict-free committed projection and the selected retained endpoint, then a bounded one-shot
  process copies and verifies exactly that complete JSONL prefix into a private same-directory
  container. The process opens only the snapshot with the installed Pi SDK's `SessionManager`; it
  constructs no AgentSession or resource loader and never sends a command to, pauses, aborts,
  rebinds, or writes through the source worker. Source models, tools, extensions, queues, dialogs,
  and active work continue unchanged. Pi determines the ancestor path, labels, metadata,
  and generated destination identity. Fork excludes the selected user message and returns it as
  the destination Composer draft, including text and saved user images in their original order and
  multiplicity. The Host restages image bytes from the admitted Pi projection as independent private
  attachment copies; neither original upload handles nor original file paths are required. The
  response carries handles/metadata, not Base64 bodies. Restored images use ordinary Composer
  thumbnails, preview, removal and explicit send; image-only input remains sendable. Fork never
  sends automatically or transfers the source's unsent draft/artifacts. Message-wide attachment
  limits apply when sending, so users can trim an over-limit recovered draft. Invalid/unsupported
  or individually oversized saved images reject Fork rather than silently losing content. Failed
  publication/attachment withdraws staged copies; a browser that retires the Fork response also
  withdraws its unclaimed copies.
  Clone includes its endpoint and opens an empty destination Composer; it sends no new model prompt
  and leaves the source's draft and pending input in place.
  Neither action depends on whether the point happens to occur in the current History page.

  The helper canonicalizes the real source path as parent provenance and materializes header-only or
  otherwise deferred no-assistant output. Source appends and partial trailing writes beyond the
  admitted prefix may continue throughout fork without entering the destination. The host opens the
  private projection, reserves its id and final path, atomically publishes the complete JSONL
  without replacement, reopens it under that reservation, and attaches a processless destination
  before normal configured worker warm-up, independently of the Host's global selection. Concurrent
  open/create/delete operations share that reservation. Catalog-driven opens wait on the reservation.
  The response always identifies the destination for the requesting browser; automatic Host selection
  changes only if the source is still selected and no newer selection intent has occurred since fork
  dispatch, including while waiting for the source operation lane. Pre-publication failure removes
  staging, and post-publication failure identifies the committed destination instead of inviting a
  blind retry.

  Branch switching remains reversible and non-destructive; edit-from-here confirms only when it
  would replace a non-empty Composer draft. The action captures that draft's text/material revision;
  returned historical text may replace only that revision. Text or attachment/reference edits made
  while native navigation or summary is pending remain intact, even if their text later equals the
  confirmed draft. Native navigation still commits under its existing session/view/request fences.

## Optional branch summary

- A deliberate same-session continuation can carry Pi's summary of the branch being left, with
  optional custom instructions. Group node actions under This session and New session; user entries
  offer both Fork and Clone. A default-off Carry branch summary checkbox reveals optional
  instructions when selected. Within This session, show this configuration before Edit in this
  session / Continue here in both visual and keyboard order. Summary applies only to that action,
  not Fork/Clone in the separate New session group. Keep the bottom action dock bounded and scrollable
  independently of the reading body. Its description identifies the conversation being left. Honor
  the native skip-summary-prompt preference. Summary
  generation is never a side effect of searching or previewing History. Cancellation follows Pi's
  native outcome rather than leaving the browser at a falsely completed destination. Ordinary summary
  cancellation uses native abort and preserves the worker/extension locals when it settles; confirmed
  retirement remains the fallback for an explicitly cancelled operation that cannot settle.

## Export content and publication

- HTML preserves Pi's whole session tree. JSONL preserves the active branch's original native entries,
  embedded images and metadata, with a current native header and linear parents. Context edits affect
  model context, not exported raw history. Export never switches the source `SessionManager` or worker.
- Export captures content available at invocation, including during active work; it does not promise
  a future completed answer or lock later input. JSONL reuses the verified local prefix and reads only
  the native suffix/effective leaf when an owned worker is connected; an unmaterialized session uses
  its owning worker's entries. Otherwise JSONL serializes the verified saved entries and effective
  leaf without launching Pi, including when the workspace or external owner is unavailable. Read-only
  controls label this as saved history; native output not yet saved is outside that snapshot.
- Typed `/export` preserves Pi's one-path parsing, including quoted spaces and `~/`; `.jsonl` selects
  branch JSONL and other destinations use native HTML. It refuses the canonical source session and
  its symlink/hardlink aliases. HTML and reload use writer admission under [[session-persistence]];
  saved JSONL needs only a healthy conflict-free reading projection. Read-only menus keep Export
  available, disable Rename, and offer JSONL rather than claiming static HTML support. Fork and
  Clone use independent-copy admission, not the source writer restriction. The title menu,
  command palette, and direct current-branch action share that admission rule. Failures of a
  current-branch Clone reach the visible notification stack instead of requiring History to be
  open; node-specific History actions keep their local retry/error surface.
- Graphical Export creates a temporary native export, captures a private managed download and removes
  temporary source files on success or failure rather than leaving them in the workspace.
- Authenticated, session-owned opaque IDs serve captured snapshots, not caller-selected Host paths;
  later output changes cannot retarget them. Retain at most 16 downloads for 24 hours, remove them on
  shutdown, and require re-export after Host restart. Failed allocation remains retryable and every
  acquired source handle closes. [[composer]] owns the standalone dialog and typed receipts.

Checks: `tests/server/session-export.integration.test.ts` and `generated-exports.test.ts` cover native
content, active/empty branches, source protection and managed downloads.

## Earlier-branch presentation

- When the current view is a leased earlier branch, the center conversation surface projects a
  persistent `Continuing from earlier history` notice above the transcript with explicit return-to-latest
  and endpoint-inclusive `Clone from here` actions, independent of whether the History pane is open.
  Return to latest refreshes the runtime-owned branch projection before acting; Clone captures the
  displayed endpoint without waiting for History refresh. The notice is derived from the runtime-owned
  durable/effective leaf pair and does not introduce browser branch authority.
  Its layout follows the reading stage's width, including a narrow desktop center between side panes.
  The branch mark follows the title's first line, independently of wrapped diagnostics. Initial reading
  space and native scroll-target insets retain their existing minimum spacing and grow with the
  measured notice to keep its diagnostics clear of the initial content and aligned targets.

  The mock-host Chromium gate witnesses both actions against ordinary branch API responses and
  requires the notice to clear only after the resulting snapshot owns the durable leaf.
