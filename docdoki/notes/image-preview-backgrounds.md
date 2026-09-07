---
purpose: Explain the shared image inspection background and retain bounded regression evidence.
---

# Image preview backgrounds

## Separation of responsibilities

The full-image viewer reuses the standard `.overlay` scrim and 2px backdrop blur. A scrim only suppresses surrounding UI: even a stronger blur cannot provide a stable background for transparent image pixels. The image therefore owns an independent opaque, neutral inspection background. This separation preserves overlay reuse without making image colors depend on the workspace beneath it.

`ImagePreview` shares `src/styles/image-preview.css` across staged attachments, conversation images, and the file reader. A CSS checkerboard is the default; the viewer offers White and Black alternatives for inspecting dark/light line art and alpha edges. Applying the background to the image rather than transforming the source bytes works across supported image formats, costs no alpha scan, and leaves opaque images unchanged. Background selection is local to one viewer opening and does not reset zoom or pan. The toolbar remains outside the clipped gesture surface.

The file reader still gives its media button definite flex bounds so viewBox-only SVGs cannot collapse. The contained image uses automatic intrinsic dimensions bounded by that button, keeping the checkerboard out of letterboxing. Thumbnail tiles retain their existing cropped geometry.

Contracts: [[composer]] and [[resource-preview]].

## Verification

- `tests/browser/image-preview.spec.ts` generates actual alpha/opaque PNGs in memory. Chromium pixel comparisons confirm that changing the scrim does not alter the alpha image's interior, that White/Black change its composition, and that all three backgrounds leave opaque pixels unchanged. Comparisons wait for overlay animation completion and exclude fractional outer boundary pixels that also cover the surrounding scrim.
- The same suite checks both palettes and luminosity modes, scoped Axe accessibility, shared-overlay computed styles, 320px controls, zoom/pan preservation, focus containment/restoration, all dismissal paths, reset-on-open, and Settings header/body adjacency at desktop and narrow widths.
- `tests/browser/workbench.spec.ts` checks the file reader's real viewBox-only SVG has nonzero, aspect-correct dimensions within its media button and an inspection background.
- Local verification: production build, formatting, lint, typecheck; all 624 web tests and all 25 Chromium browser tests on both Node 26 and Node 22.19.0. Desktop and 320px screenshots were also inspected with black/white line art and a half-transparent colored region.
- Browser rendering evidence is Chromium on Linux, not a Safari/Firefox or macOS/Windows claim. Generated images, screenshots, traces, and build output are not source fixtures and are not committed.
