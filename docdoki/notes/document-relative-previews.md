---
purpose: Document-scoped resource resolution, authorization, image ownership, and navigation.
---

# Document-relative previews

## Directory and authority

`DocumentPreview` supplies the opened descriptor to the shared sanitized `RichText` pipeline. Document
links and images resolve from that file's actual directory; conversation references use the session
cwd and explicit preview controls.

`documentResourceReference` separates URL escaping from literal workspace paths and prefixes
project-relative targets with `./`. A missing sibling must remain missing rather than opening an
unrelated same-basename file elsewhere.

Linked files need independent authorization through workspace realpath containment or an exact
transcript citation, as defined in [[resource-preview]]. Reading the parent document and Git index
membership grant no additional access. [[filesystem-git-separation]] explains discovery and authority.
`ResourceController.loadDocumentImage` uses the authenticated resolver/content route without changing
the selected file or availability state.

## Images and navigation

`DocumentImageResources` owns per-document deduplication, transfer scheduling, retained blobs, abort,
and URL revocation. Limits live in [[resource-preview]]. Resolve/content completions must still belong
to the selected document, session, branch view, and transport. Failures retain the authored description.

Notebook cell attachments decode bounded canonical raster bundles within that cell; they do not enable
arbitrary Markdown data URLs. Conversation images outside recognized local references retain their
description, while remote and protocol-relative images appear as explicit links. HTML previews keep
their isolated sandbox; Notebook cells remain static.

`github-slugger` assigns heading IDs before sanitization. Scoped fragment navigation uses the
sanitizer's `user-content-` prefix and waits for deferred rendering and image layout. Wheel, touch,
pointer, or keyboard interaction cancels pending automatic positioning, preserving the reader's choice.

## Verification

- `tests/web/document-resources.test.ts`, `document-preview.test.tsx`, and
  `document-image-controller.test.ts` cover directory/encoding rules, headings, Notebook attachments,
  transfer failures, StrictMode cleanup, cancellation, stale identities, deduplication, and budgets.
- `tests/server/resources.test.ts` and Windows-path tests cover independent authorization, contained
  ignored files, outside targets, and literal document-relative resolution.
- Chromium file-preview flows render local PNG/SVG and Notebook images from authenticated blobs,
  share duplicate image URLs, preserve missing-image errors, and block remote autoloading. Same-file
  headings stay within the reader; cross-document fragments apply after images establish layout.
  Desktop and 390px checks cover aspect ratio and reader overflow; newer large-document checks are
  recorded in [[follow-core-review-repairs-2026-09-30]].
- Reusable synthetic inputs are under `tests/browser/fixtures/file-previews/`; browser flows live in
  `tests/browser/{workbench,filesystem-files}.spec.ts`.
