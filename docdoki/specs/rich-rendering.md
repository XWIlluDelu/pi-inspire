---
purpose: Shared streaming Markdown, mathematics, code, tables, and links for Pi content.
covers:
  - src/components/RichText.tsx
  - src/{rich-text-parser,rich-text-parser-client,rich-text-worker}.ts
  - vite.config.ts
  - package.json
  - src/components/RichTextMath.tsx
  - src/components/ProgressiveRichText.tsx
  - src/components/Transcript.tsx
  - src/components/transcript-row-projection.tsx
  - src/components/transcript-rows.tsx
  - src/styles.css
  - src/styles/*.css
  - tests/web/rich-text.test.tsx
  - tests/web/rich-text-streaming.test.tsx
  - tests/web/rich-text-worker.test.tsx
  - tests/web/rich-text-parser-client.test.ts
  - tests/browser/{tool-presentations,filesystem-files}.spec.ts
  - tests/fixtures/rich-text-benchmark.tsx
  - scripts/benchmark-rich-text.mjs
---

# Rich rendering

## Goal

Render Pi content accurately during streaming and after completion. User messages, assistant messages,
thinking, documents, and extension Markdown share one rendering authority with deliberate variants.

### Content semantics

- Support CommonMark-style Markdown, GFM tables and task lists, links, images, inline mathematics,
  and display mathematics. Streaming keeps incomplete fences, links, tables, and math readable.
- Code blocks preserve whitespace, identify their language when available, highlight syntax, and
  copy the original source. Parsed `pre` structure determines block identity: unlabeled, indented,
  and incomplete fences retain block/copy behavior. Only inline code can become a file-reference button.
- Final rendering equals a fresh render of the complete source. Parse the whole document so later
  reference definitions, footnotes, and open fence/list/math structure can update earlier content.
- Reuse unchanged math and code subtrees without delaying source updates. Reuse stays bounded by
  mounted content; source-safety and sanitization precede math interpretation and memoization.

### Safety and navigation

- Disable raw HTML by default. Any interpreted HTML requires an explicit allowlist; reject unsafe
  URLs and active inline content. TeX rendering uses `trust:false`.
- External links open safely in a new tab. Explicit local conversation links and images open the
  session-bound resource preview. Document readers resolve file targets from the document directory,
  render independently authorized local images, and keep heading fragments within the reader under
  [[resource-preview]]. External image URLs appear as links; unrecognized conversation image paths
  remain unavailable. Arbitrary data URLs stay disabled.
- A rendering failure stays within the affected block and leaves its source readable.

## Parsing and update ownership

`rich-text-parser.ts` owns the whole-document remark/rehype pipeline: Markdown, GFM/math,
source-safety, conversion, and sanitization. Sources below 32,000 characters parse synchronously;
at or above that threshold, one shared worker returns sanitized HAST without unused source positions.
Both paths use the same DOM-independent named-entity decoder. `RichText` converts their HAST to React
on the main thread.

The parser client runs one active job overall and retains only the latest pending source per mounted
reader. A compatible completed prefix stays formatted while the appended tail appears immediately as
safe text. A replacement source displays its own text while awaiting parsing. Unmounting retires that
reader's work; the last reader terminates the worker.

Sanitized `code`/`pre` renderers pass primitive source and mode/language props to memoized leaves.
`RichTextMath` runs trust-disabled rehype-katex and HAST-to-React conversion when an expression changes;
`CodeBlock` retains highlighting through unrelated updates and clipboard feedback.

`ProgressiveRichText` owns lazy loading and readable failure fallback. Parsing and reuse belong to
`RichText`, independent of transport streaming state.

## Checks

Web tests compare streamed and fresh DOM, exercise delimiter boundaries and late references, and count
math/highlighting work for unchanged leaves. Parser-client tests cover coalescing, reader retirement,
and worker failure. Chromium flows exercise composer typing during large-response updates and scoped
document navigation. Reproducible component measurements: [[rich-rendering-reuse]].

## Boundaries

TeX document compilation and active HTML artifacts are outside the conversation renderer.
