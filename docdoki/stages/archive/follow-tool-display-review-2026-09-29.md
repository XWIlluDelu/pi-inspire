---
scope:
  - src/components/{transcript-cards,transcript-rows,transcript-row-projection,ResourcePathLabel}.tsx
  - src/events.ts
  - src/tool-presentations/**
  - src/styles/{activity-cards,foundation}.css
  - tests/web/{tool-*,events,transcript-fold,welcome-new-session}.test.ts*
  - tests/browser/tool-presentations.spec.ts
---

# Tool display and streaming review

## Objective

Review native and extension tool displays in a real browser for visual clarity and correct streaming behavior, and repair confirmed problems under [[activity-presentation]], [[tool-presentations]], and [[design-system]]. Preserve Pi's execution and persistence semantics.

## Outcome

Completed. The existing compact card design remains: specialized native presentations, declarative extension mappings, and an inspectable generic fallback. The changes repair missing content and lifecycle states and improve dense content without adding extension-specific application logic.

- **Live output:** cumulative execution text now appears in a bounded preview. A progress update cannot imply completion, enter final-result copy, or revive a finished tool. Observed call completion shows Waiting to execute rather than briefly claiming no result. Argument/code and output panes follow their tail until the reader scrolls away.
- **Result preservation:** generic image-only results no longer render blank. Text, images, and structured details survive fallback rendering, including results without a matching call in loaded history. Structured details mount on demand; generic image rendering checks MIME type, data size, and base64 characters and reports rejected fields explicitly.
- **Source and search:** code declarations respect `lineNumbers: false`; six-digit gutters remain aligned across horizontal scrolling. Overlapping search context is deduplicated without losing match flags. PowerShell uses the terminal presentation alongside Bash.
- **Layout:** resource actions keep the complete path while visible labels prefer the filename and retain its suffix when even the filename cannot fit. Long queries wrap, list annotations cannot consume the filename column, and large code/log/Markdown bodies scroll within the card with keyboard access. Read cards no longer repeat file/range metadata above the same source preview.
- **Readability:** section labels, small metadata, and error/link text meet the checked contrast requirements across Amber/Jade light and dark themes.

## Evidence

- Actual installed Pi 0.87.1 tool implementations executed `read`, `write`, `edit`, `grep`, `find`, `ls`, and `bash` in a disposable directory. The captured results include authoritative edit patches, overlapping grep context, image reads, an error, and incremental Bash output. The directory was removed after capture.
- A Chromium component matrix used the real card components, stylesheet, registry, and event reducer with those native results, the current declarative search/web/context/intercom mappings, and unknown-tool fixtures. Checked 40 desktop views across all four palettes/modes and six 390px views; the final run reported no JavaScript errors, page overflow, or reported accessibility violations in its checked rules.
- `tests/browser/tool-presentations.spec.ts`: **6 passing Chromium tests** through the workbench's WebSocket/transcript path. Covers cumulative output without duplication, terminal receipts and late updates, manual disclosure, auto-follow versus manual scrolling, argument-to-queued transition, unpaired results, images, full path actions, six-digit gutters, code options, bounded Markdown, and contrast in all four narrow-screen themes.
- `tests/web`: **1,104 tests passed across 91 files**. Includes targeted event, native-card, fallback, output-preview, and fold-identity regressions.
- Typecheck, format, lint, unused-code checks, and the production web build passed.

Local screenshots and the disposable matrix are under `output/playwright/tool-review/`; `index.html` groups the screenshots for inspection. The versioned browser and unit tests retain the regressions independently of those local artifacts.

The browser checks exercise presentation, not external search/intercom services. PowerShell uses representative result fixtures; Windows process execution and non-Chromium browsers were not tested in this review. The production Host was not restarted.
