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

## Hidden project directories

### Behavior and reason

The New session picker previously skipped every dot-prefixed name unconditionally in `server/host-dirs.ts`, on all host platforms. That made hidden projects unreachable through browsing even though typing their absolute path already worked. Windows Hidden attributes and macOS UF_HIDDEN were not inspected.

Under [[workbench]], a local-to-the-open-picker Show hidden folders checkbox now opts into all immediate directories through the authenticated, session-independent `GET /api/host/dirs?showHidden=1`. Omission or `0` retains filtering; other values are rejected. No preference or filesystem attribute is changed. The checkbox is retained through navigation and resets on reopening. Browser paths remain verbatim Host paths, including drive and UNC forms.

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
