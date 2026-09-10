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

Discovery caching does not grant read authority. [[state-ownership]] explains
session addressing and pinned-object reads; [[workbench-implementation]] applies the same independent
authorization to document images. Current contracts: [[resource-preview]], [[composer]], [[conversation]].

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

## Streaming tool argument projection

### Identity and incremental ownership

Pi JSON/RPC >=0.84.3 supplies tool identity/name at `toolcall_start` (upstream PR #7953;
verified against installed Pi 0.85.1 `docs/rpc.md` and `dist/modes/json-event.js`). That permits a named
card before arguments complete; older identity-less starts retain end-only behavior. Contracts:
[[activity-presentation]], [[session-transport]] and [[conversation]].

`server/tool-argument-stream.ts` parses once into a worker/message-owned preview. Sensitive keyed
values are redacted before transport; cumulative raw argument JSON is not retained. Immutable path
updates in `shared/tool-argument-updates.ts` preserve call identity across both projections, and
prototype-shaped keys remain inert own properties. Final tool data replaces the preview once.

`server/runtime-stream-budget.ts` accounts for exact append JSON growth, including escaping and split
surrogates, without serializing the cumulative assistant on every fragment. Structural changes still
require full validation. If the item budget removes other argument paths, a character count cannot
prove the reduced tree: publish a complete checkpoint, not merely the latest path patch.

Same-tool fragments coalesce within the existing transport window. `sourceEventCount` preserves
revision continuity across batches; background viewers receive no argument bodies. Joining snapshots
can still serialize cumulative replacements, so established-viewer measurements do not describe that
handshake. Display truncation and partial-path resource/copy rules remain in the contracts.

### Incomplete edit items are valid generation shapes

A normal next replacement begins as `{}` or oldText-only. Requiring both strings for every item made
that prefix invalidate the entire diff, hiding previously complete rows. This was shape validation,
not missing red/green CSS.

The native edit rule accepts absent preview fields only with Host-owned preview metadata; wrong types
and malformed authoritative calls still use their generic presentation. A missing side contributes
no rows rather than a fabricated empty-string edit. Rendering derives from the current call, not a
cached last-good diff, so a fresh observer sees the same prefix. Numbered headings remain stable, and
no completed replacement count is claimed during generation.

Source: `src/tool-presentations/pi-native.ts` and `tests/web/streaming-edit-cards.test.tsx`. Six initial
regressions failed before repair. Cases cover field order, next-item growth, legacy replacements,
interruption, fresh observers, DOM identity and final result adoption. Character-by-character browser
fixtures exercised the parser → shared updates → registry → ToolCard path at desktop/narrow sizes;
they did not execute a live model or edit a real file.
