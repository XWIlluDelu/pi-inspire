---
scope:
  - src/components/{Transcript,transcript-cards,ImagePreview}.tsx
  - src/styles/activity-cards.css
  - src/tool-presentations/**
  - server/{session-projection,resources}.ts
  - shared/resource-references.ts
  - tests/{fixtures,web,server,browser}/**
---

# Tool-result images and full output

## Objective

Preserve native tool-result resources under [[tool-presentations]]:

- Tool images remain visible after loading saved history and open in the existing image preview.
- Truncated shell results offer a concise “View full output” action using Pi's recorded log path
  and the existing file viewer.

Keep the current reply/activity layout. User-facing labels explain the content or action, not the
transport mechanism. Codemode adaptation and its downstream presentation are deferred.

## Current state

Implemented with native offline fixtures and desktop/narrow-screen checks.

- A shared tool-image projection keeps the original message/part coordinates. Saved native,
  generic, and unpaired tool results use `PersistedImage`; live inline images use `ImagePreview`.
  Transcript supplies the session, branch view, and projection incarnation. Existing cancellation
  and object-URL cleanup remain in the shared image path.
- The native Bash/PowerShell truncation notice offers “View full output” when
  `details.fullOutputPath` is present. The action uses `FileRefButton` and the existing file viewer;
  resource authorization and reference extraction are unchanged.

## Verification

The reusable offline fixture in `tests/fixtures/tool-result-resources.mjs` runs installed native
`read` and `bash`, records their results in an isolated session, and opens `SessionProjection`.
It checks the actual paging boundary: canonical messages retain image bytes, while `latestPage`
removes them and retains the message index. Native Bash produces a 2,500-line truncated result
and its recorded full-output log. `INSPIRE_TEST_PI_COMMAND` explicitly selected installed Pi
**1.0.0**.

- `tests/web/{tool-cards,tool-card-fallbacks}.test.tsx` and
  `tests/web/tool-presentations.test.ts` passed. The saved-resource group covers native, generic,
  and unpaired image references, image-preview opening and cleanup, and the exact Bash/PowerShell
  action target. Existing inline-image and rule-selection checks remain valid.
- The focused embedded-image lifecycle checks in `tests/web/store-resources.test.ts` passed,
  covering retired projection/API requests and object-URL cleanup.
- The saved-resource test in `tests/browser/tool-presentations.spec.ts` passed in Chromium against
  a fresh web bundle. Native desktop (1440 × 1000) and generic narrow-screen (390 × 844) checks
  reload saved history, display the image, open/zoom/close the preview with keyboard focus restored,
  and open the full log. The test asserts the resolve request's actual path, session/view ownership,
  and HTTP content equal to Pi's complete recorded log. The Host projection and resource endpoints
  are real; only unrelated Runtime/catalog state is mocked. No model request is involved.
- Typechecking, unused-code analysis, focused lint/format checks, and the web build passed.
  Screenshots are under
  `output/playwright/results/tool-presentations-saved-t-6ffbc--desktop-and-narrow-screens-chromium/`.
  Isolated fixture Hosts, session roots, and native full-output logs are cleaned after the checks.

PowerShell uses the shared native shell rule and is checked with the recorded Bash result shape;
no native PowerShell execution was tested on this Linux host. The existing file viewer's text
limit and Download behavior are unchanged. Codemode adaptation remains deferred.
