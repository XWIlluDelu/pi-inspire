---
purpose: Explain document-scoped Markdown resources, related Notebook repairs, and their verification boundary.
---

# Document-relative previews

## Failure and repair

`FilePreview` and `NotebookPreview` reused the conversation renderer without a document context. Local Markdown images therefore became file-reference buttons, relative links opened from the session cwd, and Notebook Markdown cell attachments had no resolver. Heading fragments also followed browser navigation instead of the document reader.

`DocumentPreview` now supplies the opened descriptor and a mounted-document image owner to the same sanitized `RichText` pipeline. Links and images use the document's resolved directory; conversation references keep their explicit-open behavior. `github-slugger` generates document heading identities before sanitization, and scoped fragment navigation uses the sanitizer's `user-content-` prefix. Incoming fragments wait for the deferred renderer and image layout: an initial document may be too short to scroll before its images arrive. Wheel, touch, pointer or keyboard interaction cancels this delayed automatic positioning rather than reclaiming the reader. `NotebookPreview` decodes cell-local raster attachment bundles without making `data:` URLs generally acceptable in Markdown.

`documentResourceReference` keeps URL escaping separate from literal workspace paths and prefixes project-relative locations with `./`. That prefix is intentional: a missing sibling image must not silently open an unrelated same-basename file elsewhere. `ResourceController.loadDocumentImage` uses the existing authenticated resolver and content route without changing selected-file or availability state. A document reference is not a new source of filesystem authority.

`DocumentImageResources` owns deduplication, four-way transfer scheduling, a 64-reference/64-MiB retained-image budget, abort and URL revocation. The ordinary 32-MiB per-image cap remains. Late resolve/content results must still belong to the selected document, session, branch view, and browser transport. UI failures retain the authored description and never fall back to a raw URL.

The review also removed the generic `<img src>` fallback for unrecognized conversation paths and classified protocol-relative images as explicit external links. Raw HTML in Markdown, remote image autoloading, and arbitrary subresources in sandboxed HTML remain intentionally unsupported; they were not weakened to make previews look complete.

## Evidence

- Node **22.19.0**: full working-tree Vitest run excluding the separately scoped launcher suite — **153 files passed, 1,549 tests passed, 2 skipped**. Before commit, an isolated export of the staged tree (without the unrelated restart changes) also passed typecheck and the targeted resource/rendering/Host set: **9 files, 205 tests**.
- New tests: `tests/web/document-resources.test.ts`, `document-preview.test.tsx`, and `document-image-controller.test.ts`. They cover directory/encoding semantics, extensionless links, linked images, Unicode/duplicate headings, Notebook Markdown outputs and attachment scope, blocked remote/raw/data content, decode/transfer failures, StrictMode, cancellation, stale identities, deduplication and budgets.
- `tests/server/resources.test.ts` confirms independent image authorization, ignored/outside refusal and no unrelated basename recovery. Existing Host resource and Windows-path tests also passed.
- Typecheck, lint, unused-code checks and the production web build passed.
- Chromium against `scripts/start-browser-test-host.mjs`: actual indexed PNG and viewBox-only SVG files rendered from authenticated blobs. Duplicate references shared a URL. Notebook file/output images and cell-local raster attachments decoded. A missing image showed an explicit failure; remote and protocol-relative fixtures caused no external HTTP(S) requests. Same-document anchors scrolled the reader without changing the browser location. Markdown → Notebook navigation used the sibling file; Notebook → Markdown `#results` navigation was rechecked after fixing the image-layout race (128px reader scroll, heading within 1px of the reader top).
- Desktop **1440×1000** and narrow **390×844**, including system-dark mode: images decoded, preserved aspect ratio and stayed within the reader without page-level horizontal overflow. Screenshots: `output/playwright/document-images-{desktop,notebook,narrow,narrow-dark,markdown-narrow-dark}.png`. Reusable synthetic inputs live under `tests/browser/fixtures/file-previews/document-images.*` and `training curve.png`.

## Limits

The browser checks used isolated synthetic fixtures, not real Pi conversation content or the user's report. This work does not establish arbitrary image-format support, cross-browser parity, or access to images excluded by workspace/transcript authority. It does not change the HTML iframe sandbox or execute Notebook code. Unrelated in-progress restart controls were preserved.
