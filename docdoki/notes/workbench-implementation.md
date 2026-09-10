# Workbench implementation notes

## Custom message presentation

### Decision

The user approved a neutral, information-blue message surface for displayed Pi custom messages while explicitly retaining the existing PI error surface. The current contract is in [[conversation]] and [[design-system]]. A custom message supplies extension-authored context, without the call/result lifecycle of a tool. Its optional `details` is separate from its Markdown `content`; no details entry is synthesized when that field is absent or null.

The previous tool-style card, custom activity tiles, and automatic tool-density lifecycle were removed. Tool calls and Thinking keep their existing presentation. Custom messages stay outside activity folds even when tool visibility is Hidden. The change does not alter Pi delivery or model-context conversion.

### Projection boundary

- `CustomMessage.tsx` renders Markdown and text/image blocks, preserves inspectable fallback data, and lazily mounts expanded Details.
- `transcript-row-projection.tsx` places custom messages in chronological independent rows. Host-paired entry identities retain the row across live-to-durable timestamp adoption and history prepends; host reconciliation remains unchanged.
- `server/session-projection.ts` treats displayed custom messages as visible boundaries in older-history and user-turn navigation. Merely changing the browser renderer would otherwise leave older custom content hidden in deferred activity ranges. Hidden context-only messages remain invisible.
- Settled custom content participates in All search, but not User or Model scopes. Source/type labels do not claim user or Pi authorship.

## Document-relative previews

 follow-up: [[workbench-implementation]] supersedes the ignored-file refusal in this original verification record. Document images/links still require independent authorization, now from workspace realpath containment or an exact citation, not Git index membership. Outside-target, view/object, remote-load and sandbox checks remain.

### Failure and repair

`FilePreview` and `NotebookPreview` reused the conversation renderer without a document context. Local Markdown images therefore became file-reference buttons, relative links opened from the session cwd, and Notebook Markdown cell attachments had no resolver. Heading fragments also followed browser navigation instead of the document reader.

`DocumentPreview` now supplies the opened descriptor and a mounted-document image owner to the same sanitized `RichText` pipeline. Links and images use the document's resolved directory; conversation references keep their explicit-open behavior. `github-slugger` generates document heading identities before sanitization, and scoped fragment navigation uses the sanitizer's `user-content-` prefix. Incoming fragments wait for the deferred renderer and image layout: an initial document may be too short to scroll before its images arrive. Wheel, touch, pointer or keyboard interaction cancels this delayed automatic positioning rather than reclaiming the reader. `NotebookPreview` decodes cell-local raster attachment bundles without making `data:` URLs generally acceptable in Markdown.

`documentResourceReference` keeps URL escaping separate from literal workspace paths and prefixes project-relative locations with `./`. That prefix is intentional: a missing sibling image must not silently open an unrelated same-basename file elsewhere. `ResourceController.loadDocumentImage` uses the existing authenticated resolver and content route without changing selected-file or availability state. A document reference is not a new source of filesystem authority.

`DocumentImageResources` owns deduplication, four-way transfer scheduling, a 64-reference/64-MiB retained-image budget, abort and URL revocation. The ordinary 32-MiB per-image cap remains. Late resolve/content results must still belong to the selected document, session, branch view, and browser transport. UI failures retain the authored description and never fall back to a raw URL.

The review also removed the generic `<img src>` fallback for unrecognized conversation paths and classified protocol-relative images as explicit external links. Raw HTML in Markdown, remote image autoloading, and arbitrary subresources in sandboxed HTML remain intentionally unsupported; they were not weakened to make previews look complete.

### Limits

The browser checks used isolated synthetic fixtures, not real Pi conversation content or the user's report. This work does not establish arbitrary image-format support, cross-browser parity, or access to images excluded by workspace/transcript authority. It does not change the HTML iframe sandbox or execute Notebook code. Unrelated in-progress restart controls were preserved.

## Filesystem and Git separation

### Decision and repair

The user rejected Git tracking/ignore rules as file-visibility rules: Files represents the project filesystem; Changes represents Git. Hidden visibility covers dot names and native Windows/macOS hidden attributes, not `node_modules`, `dist`, Git ignored files, or tracking state. Visibility, discovery completeness, and permission are independent.

- `server/project-files.ts` no longer invokes Git. Tree levels enumerate real directories on demand, including empty directories, with at most 10,000 inspected entries per response. Search uses bounded breadth-first discovery (20,000 files, 10,000 queued directories, a five-second cooperative walk budget). Directory identity is checked before/after enumeration; contained directory links are navigable and canonical identities stop cycles. Unrepresentable POSIX filenames cannot alias real replacement-character names. Incomplete/capped/unreadable discovery is explicit.
- The directory tree, search, established composer picker/`@`, and prospective New session search expose filesystem-only hidden visibility. An established workspace shares its cwd-scoped toggle across Files and composer entry points. Visibility changes retire old directory/search work while preserving the query, expansion and selected preview. New session owns its prospective-workspace toggle separately. The completion toolbar stays outside the ARIA listbox and preserves text/caret focus.
- `server/resources.ts` authorizes contained regular files independently of discovery and Git. Exact transcript references remain a separate authority outside the workspace. Content requests still check the addressed session/view, current canonical workspace, lexical/canonical target witness and pinned object. Missing paths invalidate discovery caches, not permissions. Changing ignore rules or hiding a file cannot revoke an otherwise valid handle. Contained reads do not load conversation content.
- `server/attachments.ts` and the existing delivery/history revalidation retain canonical-root, regular-file and selected-target checks without index membership. Hidden/ignored files can be sent and recalled; retargeting a selected symlink still fails. JSON-encoded prompt references retain their injection boundary.
- Document-local links/images, downloads and terminal file links inherit the independent resource authority. Local images in ignored generated-output directories can load; remote/protocol-relative images, outside targets without citations, sandbox content and transfer limits remain unchanged.
- Changes no longer infers `+0 −0` from an absent status entry. Only a concrete diff supplies line counts; missing/unavailable/incomplete/not-a-repository observations show unavailable counts and disable navigation. An empty selected Git comparison does not substitute working-tree bytes for staged source.

The earlier preview-index authority and five-second ignore-revocation tradeoff in [[state-ownership]], and the ignored-image refusal recorded in [[workbench-implementation]], are superseded. Their session/object and document safety boundaries remain. Current contracts: [[resource-preview]], [[composer]], [[conversation]].

### Limits

- This is read-only bounded discovery, not an unrestricted file manager or a complete eager filesystem index. Special nodes and broken/outside symlink targets are not offered or traversed. A truncated scan is not proof of absence or basename uniqueness; exact qualified file reads do not depend on the scan.
- Search caches have a five-second freshness window, at most eight canonical-root/visibility scopes, and shared in-flight scans. The scan time budget is cooperative between directory reads, not a hard deadline on an individual filesystem/native-attribute operation. Explicit refresh invalidates discovery globally within that small cache.
- Native Windows/macOS attributes reuse the existing bounded platform helper. Their adapter behavior is covered synthetically here; this Linux run does not establish native Windows/macOS end-to-end performance or behavior.
- Deployment/service restart is not part of this repair. Running Hosts must load the updated backend before the new Files semantics are available.

## Hidden project directories

### Behavior and reason

The New session picker previously skipped every dot-prefixed name unconditionally in `server/host-dirs.ts`, on all host platforms. That made hidden projects unreachable through browsing even though typing their absolute path already worked. Windows Hidden attributes and macOS UF_HIDDEN were not inspected.

Under [[workbench]], a local-to-the-open-picker Show hidden folders eye-icon toggle immediately after the heading opts into all immediate directories through the authenticated, session-independent `GET /api/host/dirs?showHidden=1`. It replaces the separate checkbox row at the user's request, uses a stable accessible label and `aria-pressed`, and changes its icon and action tooltip with visibility. Omission or `0` retains filtering; other values are rejected. No preference or filesystem attribute is changed. The toggle is retained through navigation and resets on reopening. Browser paths remain verbatim Host paths, including drive and UNC forms.

### Native inspection boundary

`server/host-hidden-dirs.ts` handles attributes Node's Dirent/Stats do not expose:

- Linux and other POSIX hosts need no subprocess for the common dot-name rule.
- Windows runs one bounded Windows PowerShell command per directory level. `Get-ChildItem -LiteralPath … -Force -Hidden` returns names as an explicit UTF-8 JSON array, including zero/singleton cases. The path travels through an environment value, never script interpolation, and no shell/profile runs.
- macOS runs `/usr/bin/find` with `-mindepth 1 -maxdepth 1 -flags +hidden -print0`. NUL delimiters preserve spaces and newlines; the scan never descends into children. The [macOS find manual](https://keith.github.io/xcode-man-pages/find.1.html) defines these primaries; [chflags](https://keith.github.io/xcode-man-pages/chflags.1.html) defines `hidden` as hiding an item from the GUI.

Native queries have a ten-second timeout and 8 MiB output bound. Failures remain visible rather than silently changing the filter. Explicit show-hidden listing bypasses native inspection, so unavailable tooling does not make all browsing impossible. These flags supplement dot-name filtering; the picker does not emulate every file manager's private visibility metadata.

## Image preview backgrounds

### Separation of responsibilities

The full-image viewer reuses the standard `.overlay` scrim and 2px backdrop blur. A scrim only suppresses surrounding UI: even a stronger blur cannot provide a stable background for transparent image pixels. The image therefore owns an independent opaque, neutral inspection background. This separation preserves overlay reuse without making image colors depend on the workspace beneath it.

`ImagePreview` shares `src/styles/image-preview.css` across staged attachments, conversation images, and the file reader. A CSS checkerboard is the default; the viewer offers White and Black alternatives for inspecting dark/light line art and alpha edges. Applying the background to the image rather than transforming the source bytes works across supported image formats, costs no alpha scan, and leaves opaque images unchanged. Background selection is local to one viewer opening and does not reset zoom or pan. Controls remain outside the clipped gesture surface. The viewer now hugs the fitted image instead of centering it inside a fixed-height stage below a detached toolbar: a 44px close row aligns to the group's right edge above the image, and the 50px background selector centers below it, each with a 12px gap. The two rows balance the image within 3px of the viewport center when safe areas are symmetric. Intrinsic image fitting reserves both rows, gaps, and safe-area gutters, so short landscape screens do not clip the controls. Control surfaces, text, hover, selection, and focus use theme tokens; the checkerboard and White/Black inspection colors deliberately remain stable across themes.

The file reader still gives its media button definite flex bounds so viewBox-only SVGs cannot collapse. The contained image uses automatic intrinsic dimensions bounded by that button, keeping the checkerboard out of letterboxing. Thumbnail tiles retain their existing cropped geometry.

Contracts: [[composer]] and [[resource-preview]].

## Neutral PWA chrome

### Decision and implementation

The previous HTML and manifest fixed title-bar hints to Amber orange even when the application used Jade. Under [[design-system]], window chrome now uses the same neutral light/dark pair for both palettes. `public/theme-init.js` sets the page metadata before CSS/React paint from the existing validated visual cache; `applyBrowserTheme` in `src/visual-preferences.ts` applies the Host-authoritative resolved theme and system-theme updates. Tests keep the two small pre-bootstrap/runtime mappings aligned. Manifest theme and launch background use the neutral light fallback.

Installed icons keep the Open Reticle geometry and carbon tile but replace orange details with silver; the brackets stay white. `npm run icons:build` (`scripts/render-app-icons.mjs`) regenerates all four PNGs from the two SVG masters through the project's Playwright Chromium, without another image dependency. Ordinary icons keep transparent rounded corners; maskable and Apple touch icons remain full-bleed. Manifest and touch-icon URLs advance to `v=4`; app identity, start URL, scope, and manifest location remain stable. Existing service-worker network-only handling for manifest/launcher assets remains unchanged. In-app identity and the tab favicon are not changed.

### Browser boundary

[MDN's PWA color guide](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Customize_your_app_colors) describes page `theme-color` overriding the manifest fallback in supporting browsers. It is a browser hint, not CSS ownership of OS window borders. Installed icons are manifest/OS assets rather than live theme components; [Chrome's manifest update guide](https://web.dev/articles/manifest-updates) documents browser-controlled delayed update behavior. Versioned URLs do not promise immediate replacement of already installed launcher icons. Platform/browser differences remain; restarting the installed app or reinstalling may be necessary to see a cached icon change.

## Streaming tool argument cards

### Outcome

Pi JSON/RPC >=0.84.3 supplies tool identity/name at `toolcall_start` (upstream
PR #7953; verified installed Pi 0.85.1 `docs/rpc.md` and `dist/modes/json-event.js`).
INSΠRE now creates that named card immediately, streams a bounded argument preview,
and preserves the same call identity through execution and authoritative results.
Older identity-less starts retain end-only behavior.

Contracts: [[../specs/activity-presentation]], [[../specs/session-transport]],
[[../specs/conversation]].

### Implementation boundaries

- `server/tool-argument-stream.ts`: one-pass, worker/message-owned JSON preview
  parser. Escapes, nested objects/arrays, and complete primitives are supported;
  sensitive keyed values are discarded/redacted before any transport update.
  The parser retains no cumulative raw argument JSON.
- `shared/tool-argument-updates.ts` and `shared/assistant-stream.ts`: immutable
  path updates and call identity/preview metadata shared by both projections.
  Prototype-shaped keys remain inert own properties. Interruption metadata is
  derived from failed/aborted assistant outcomes, including persisted projection.
- `server/runtime-events.ts`: raw Pi arguments become bounded Host-authored
  updates, not browser-visible raw JSON. Final ToolCall data is projected once
  into a complete replacement instead of duplicated in a raw delta envelope.
- `server/runtime-stream-budget.ts`: append-only body updates account for exact
  JSON growth, including escaping, split surrogates and revision/preview metadata,
  without serializing cumulative assistant messages. Structural and final updates
  retain full validation. Item-budget reduction marks the projected message and
  publishes a bounded replacement: a character count cannot witness other
  argument paths being removed from the tree.
- `server/tool-argument-batches.ts`, `server/runtime-event-sockets.ts`, and browser
  event/connection reducers: adjacent same-tool fragments coalesce within the
  existing 16ms window. `sourceEventCount` preserves revision continuity and the
  2,048-source-event batch limit. Background sessions receive no argument bodies.
- Existing cards/registry remain authoritative for presentation. Write bodies use
  the native Content block immediately; other tools show their named shell, then
  typed content when their partial shape is compatible. States distinguish
  generating arguments, waiting to execute, running, and actual outcomes.
  Partial/interrupted paths cannot open resources; copies explicitly say preview.
  Collapsed cards do not build code bodies or eagerly serialize clipboard data.

### Bounds and limitations

The display parser permits 32,000 decoded string characters per tool, eight path
segments, 256 nodes, 256-character keys, and 256,000 inspected source characters.
Limit/malformed-prefix handling freezes an explicitly truncated preview; later
fragments generate no repeated updates. Code/replacement preview DOM is capped at
400 lines during generation/interruption. These are display limits, not file-size
or execution limits. The completed call and persisted message still obey the
pre-existing Host transcript projection bounds (not unlimited full-file copies).

New clients consume normalized patches, not public Pi raw argument JSON. Existing
text/thinking transport and complete joining-socket replacements remain in place.
A joining socket can still incur cumulative replacement serialization during its
bounded snapshot handshake; the measured linear wire result below concerns
established detail viewers. Host activation requires a restart and browser refresh;
this task did not restart the user's live Host or interrupt active Pi work.

### Follow-up: edit diff fallback during generation

The reported loss of red/green edit formatting was a shape-validation bug, not
missing CSS. `editReplacements` required every array item to contain both strings;
the parser's normal next-item `{}` or oldText-only prefix invalidated the entire
presentation. The completed prefix returned to diff view only after newText began.
Truncation/interruption at that boundary could leave the raw view indefinitely.

The native edit rule now distinguishes absent preview fields from wrong types.
It accepts incomplete array items and legacy single replacements only when the
call has Host-owned preview metadata. Missing old/new sides have no diff rows,
not fabricated empty-string changes. Numbered preview headings remain stable as
items arrive, and no final replacement count is claimed during generation.
Rendering is a pure projection of the current call, not a cached last-good view:
fresh observers reproduce the same content, and malformed authoritative calls
still fall back. Resource/copy gating, 400-line preview bounds, selected-rule
ownership and successful `details.patch` authority are unchanged.

- The initial regression run reproduced six failing cases on the prior renderer.
  `tests/web/streaming-edit-cards.test.tsx` now covers 22 cases: new array items,
  missing/empty sides, different field orders, legacy calls, DOM identity,
  interruption/truncation, fresh-observer reconstruction, wrong types, strict
  completed calls, and successful/error/incompatible result adoption.
- Node **22.19.0**: formatting, lint, typecheck, Knip and frontend build passed;
  full working-tree Vitest (excluding the separately scoped launcher suite)
  passed **154 files / 1,571 tests**, with **2 skipped**. That run also included
  the then-uncommitted restart controls. Log:
  `/tmp/inspire-edit-stream-check.log`.
- Playwright CLI exercised the actual parser → shared immutable updates → native
  registry → ToolCard path in an isolated static Vite fixture, with no Host proxy
  or real sessions. Every character was rendered and asserted to remain typed;
  starting the next replacement retained earlier DOM rows. 1280px light and 390px
  dark views retained red/green tint, full scroll-width row backgrounds, no page
  overflow, and distinct generating/interrupted/waiting/applied states.
  Screenshots: `output/playwright/edit-stream-{desktop-light,narrow-dark,
  interrupted-dark,applied-dark}.png`. The fixture's only console error was its
  missing favicon. These checks do not claim a live model or real file edit.

This follow-up changes only frontend presentation; the frontend was rebuilt and
no live Host restart is required for this fix (refresh the browser).
