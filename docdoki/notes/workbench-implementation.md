---
purpose: Implementation reasons behind document readers, streamed tool content and browser presentation.
---

# Workbench implementation notes

## References and filesystem discovery

Document links, inline paths and images resolve from the directory of the opened file, including a
file found through basename recovery. Conversation references instead resolve from the session cwd.
Keeping the base explicit prevents navigation from silently changing meaning between readers.

Filesystem membership and Git observations are independent. Git output cannot establish whether an
unlisted file is clean, ignored, absent or merely outside a bounded scan. Directory reads report their
own completeness; Git contributes decoration and comparisons. See [[resource-preview]].

Hidden visibility combines dot names with platform metadata. Windows `Hidden` and macOS
`UF_HIDDEN` queries use bounded argument arrays and literal paths, separate from Git. If metadata is
unavailable, discovery reports incomplete visibility. Authorization still depends on the session and realpath boundary, not visibility.

## Rendering without changing execution

Display labels and rendering strategy are separate: a card may say MCP while its underlying
`codemode` call keeps the Codemode tree renderer. Presentation projections retain the recorded tool
name, arguments and result for raw inspection and resource extraction.

The Intercom reading projection selects structured body text instead of parsing a generated
Markdown wrapper. Its absent-provenance guard preserves the original cross-machine origin warning.
Unrecognized custom-message shapes retain generic inspection. See [[tool-presentations]] and
[[conversation]].

Pi supplies a call's identity and name before its arguments finish. The Host parses the incremental
arguments once into a worker/message-owned preview, redacts sensitive keyed values before transport
and retains no cumulative raw argument JSON. Immutable path updates preserve call identity across
Host and browser projections. If a budget removes other paths, send a complete checkpoint rather
than only the newest patch. Partial paths cannot authorize resource actions; final data replaces
the preview in the same call. See [[activity-presentation]] and [[session-transport]].

## Reader and image geometry

Inline document images are requested lazily with bounded concurrency. Requests belong to the current
session, branch view, open file and transport generation; stale completion cannot populate a new
reader. RichText reuses unchanged math/code leaves and parses large sources in a shared worker.
Measurement guidance is in [[performance]].

Image frames use a shared theme-aware background and one geometry owner. If zoom/pan moves the
image into a separate contain-sized layer, the clipping frame still paints the background. Controls
stay in an adjacent toolbar rather than covering the image or resize handles. The source document
retains its own colors; application chrome follows the active theme.

## Browser-owned chrome

The PWA icon is neutral because installed icons have no portable CSS-theme binding. Ordinary tabs
and standalone fallback use neutral light/dark `theme-color` hints. Only an active Window Controls
Overlay follows the palette's outer frame color. The overlay uses browser-reported titlebar geometry;
CSS emulation cannot establish activation. See `src/visual-preferences.ts` and [[design-system]].

The settings wordmark's stitch animation is static geometry: thread and needle follow the current
tool/thinking identity roles, with reduced-motion and keyboard behavior shared across palettes.
[[design-system]] owns the visual rules, including theme-specific exceptions.
