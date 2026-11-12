---
purpose: Implementation reasons behind document readers, streamed tool content and browser presentation.
---

# Workbench implementation notes

## References and filesystem discovery

Document references resolve from the opened file's directory, including after basename recovery.
Conversation references resolve from the session cwd. Git output cannot establish why a file is
unlisted, so directory reads report their own completeness. Native hidden-attribute queries pass
literal paths as arguments. [[resource-preview]] defines discovery and authorization.

## Rendering without changing execution

Display labels and rendering strategy are separate: a card may say MCP while its underlying
`codemode` call keeps the Codemode tree renderer. Presentation projections retain the recorded tool
name, arguments and result for raw inspection and resource extraction.

A configured custom message reads the structured body directly. The provenance check preserves the
cross-machine origin warning. See [[tool-presentations]] and [[conversation]].

When a tool preview budget removes paths, send a complete checkpoint so the browser also removes
them. Partial paths carry no resource authority. [[session-transport]] defines parser ownership,
redaction and limits, and [[activity-presentation]] defines the card lifecycle.

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

The PWA icon is neutral because installed icons have no portable CSS-theme binding.
[[design-system]] defines the `theme-color` and Window Controls Overlay behavior.

`useModalFocus` publishes visible backdrop depth separately from keyboard ownership: a suspended
Settings shell keeps its focus-restoration owner without adding a second scrim. The titlebar layers
the same palette scrim without changing hit targets; `applyBrowserTheme` composites an opaque native
chrome hint. Modal/first-paint tests and isolated Chrome checks cover nesting, close restoration and
command-palette parity; the titlebar browser suite substitutes only Overlay media/geometry, not native
activation or OS controls.

The settings wordmark's stitch animation is static geometry: thread and needle follow the current
tool/thinking identity roles, with reduced-motion and keyboard behavior shared across palettes.
[[design-system]] owns the visual rules, including theme-specific exceptions.
