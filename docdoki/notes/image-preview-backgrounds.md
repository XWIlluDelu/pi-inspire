---
purpose: Explain the shared image inspection background and retain bounded regression evidence.
---

# Image preview backgrounds

## Separation of responsibilities

The full-image viewer reuses the standard `.overlay` scrim and 2px backdrop blur. A scrim only suppresses surrounding UI: even a stronger blur cannot provide a stable background for transparent image pixels. The image therefore owns an independent opaque, neutral inspection background. This separation preserves overlay reuse without making image colors depend on the workspace beneath it.

`ImagePreview` shares `src/styles/image-preview.css` across staged attachments, conversation images, and the file reader. A CSS checkerboard is the default; the viewer offers White and Black alternatives for inspecting dark/light line art and alpha edges. Applying the background to the image rather than transforming the source bytes works across supported image formats, costs no alpha scan, and leaves opaque images unchanged. Background selection is local to one viewer opening and does not reset zoom or pan. Controls remain outside the clipped gesture surface. The viewer now hugs the fitted image instead of centering it inside a fixed-height stage below a detached toolbar: a 44px close row aligns to the group's right edge above the image, and the 50px background selector centers below it, each with a 12px gap. The two rows balance the image within 3px of the viewport center when safe areas are symmetric. Intrinsic image fitting reserves both rows, gaps, and safe-area gutters, so short landscape screens do not clip the controls. Control surfaces, text, hover, selection, and focus use theme tokens; the checkerboard and White/Black inspection colors deliberately remain stable across themes.

The file reader still gives its media button definite flex bounds so viewBox-only SVGs cannot collapse. The contained image uses automatic intrinsic dimensions bounded by that button, keeping the checkerboard out of letterboxing. Thumbnail tiles retain their existing cropped geometry.

Contracts: [[composer]] and [[resource-preview]].

## Verification

- `tests/browser/image-preview.spec.ts` generates actual alpha/opaque PNGs in memory. Chromium pixel comparisons confirm that changing the scrim does not alter the alpha image's interior, that White/Black change its composition, and that all three backgrounds leave opaque pixels unchanged. Comparisons wait for overlay animation completion and exclude fractional outer boundary pixels that also cover the surrounding scrim.
- The same suite checks both palettes and luminosity modes, scoped Axe accessibility, shared-overlay computed styles, 320px controls, zoom/pan preservation, focus containment/restoration, all dismissal paths, reset-on-open, and Settings header/body adjacency at desktop and narrow widths.
- `tests/browser/workbench.spec.ts` checks the file reader's real viewBox-only SVG has nonzero, aspect-correct dimensions within its media button and an inspection background.
- Original background implementation verification: production build, formatting, lint, typecheck; all 624 web tests and all 25 Chromium browser tests on both Node 26 and Node 22.19.0. Desktop and 320px screenshots were also inspected with black/white line art and a half-transparent colored region.
- Centered-layout follow-up: production web build and typecheck passed on Node 26; 13 scoped Chromium tests passed (the 12-test image suite plus the file-workbench regression). Added geometry checks cover a 2560×1300 viewport with a screenshot-shaped image, 320px phone, portrait image, 740×360 landscape, and a 64px image; controls remain 12px from the image and its center stays within 4px of the viewport center. Theme-token assertions and scoped Axe cover Amber/Jade light/dark. Desktop, dark, phone, portrait, and landscape screenshots were visually inspected. This follow-up did not rerun the full repository suite or Node 22.
- Browser rendering evidence is Chromium on Linux, not a Safari/Firefox or macOS/Windows claim. Generated images, screenshots, traces, and build output are not source fixtures and are not committed.
