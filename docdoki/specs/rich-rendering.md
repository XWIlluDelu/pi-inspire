---
purpose: One defensive rendering pipeline turns Pi text into stable Markdown, mathematical notation, code, tables, and links during and after streaming.
covers:
  - src/components/RichText.tsx
  - src/components/RichTextMath.tsx
  - src/components/ProgressiveRichText.tsx
  - src/components/Transcript.tsx
  - src/components/transcript-row-projection.tsx
  - src/components/transcript-rows.tsx
  - src/styles.css
  - src/styles/*.css
  - tests/web/rich-text.test.tsx
  - tests/web/rich-text-streaming.test.tsx
  - tests/fixtures/rich-text-benchmark.tsx
  - scripts/benchmark-rich-text.mjs
---

# Rich rendering

## Goal

Render technical and scientific answers accurately enough that the GUI materially improves on terminal presentation.

## Checks

- Settled assistant text supports CommonMark-style Markdown, GitHub-flavored tables and task lists, fenced code, links, images, inline mathematics, and display mathematics.
- Mathematical notation renders ordinary inline expressions such as `$E=mc^2$` and `$\pi r^2$`, plus display expressions, without exposing trusted TeX commands.
- Code blocks preserve whitespace, identify their language when available, highlight syntax, and remain copyable as source text. Block identity comes from the parsed `pre` structure, not a language label: unlabeled fences, indented code, and incomplete fences retain block/copy behavior. Only inline code can become a file-reference button.
- Streaming output keeps incomplete fences, links, tables, inline mathematics, and display mathematics readable until they become complete constructs.
- Final rendering after message completion is equivalent to rendering the complete source once. Streaming must preserve whole-document reference and footnote resolution and open fence/list/math structure; source must not be independently parsed in blank-line fragments.
- Reuse unchanged expensive math and code subtrees during streaming without delaying source updates. Keep reuse state bounded by currently mounted content, not accumulated source versions. Run source-safety and sanitization before interpreting math markers; memoization must not bypass these boundaries.
- Raw HTML is disabled or sanitized under an explicit allowlist; unsafe URLs and active inline content are rejected.
- External web links retain safe new-tab behavior. In conversation content, explicit local file links and images delegate to the session-bound resource preview instead of navigating the browser to an unusable host-relative URL. Document readers supply a scoped resource context to this same pipeline: independently authorized local images render inline, file targets resolve from the document directory, and heading fragments stay within that reader, as specified in [[resource-preview]]. Neither remote/protocol-relative images nor unrecognized image paths load automatically; raw HTML and arbitrary data URLs remain disabled.
- Rendering failure is contained to the affected block and leaves its source readable.
- User messages, assistant messages, thinking, and extension-provided Markdown use deliberate variants of the same rendering authority rather than unrelated parsers.

## Rendering work ownership

ReactMarkdown remains the single whole-document Markdown parser. Its GFM/math,
source-safety, and sanitization passes run for each changed source. The sanitized
`code`/`pre` renderers pass primitive source and mode/language props to memoized
leaves. `RichTextMath` runs the existing trust-disabled rehype-katex transformer
and its HAST-to-React conversion only when an expression changes; `CodeBlock`
reuses highlighting, including across clipboard-feedback updates. React owns
leaf lifetimes. There is no stream-history cache or second Markdown parser.

`ProgressiveRichText` owns lazy loading and readable failure fallback, not
throttling. Reuse applies equally to transcript, document, thinking, and extension
variants without requiring streaming state from transport or store.

Work-counter, semantic-equivalence, and local browser measurement details:
[[rich-rendering-reuse]].

## Non-goals

- Arbitrary TeX document compilation is outside the conversation renderer.
- Active HTML artifacts are not rendered in the conversation DOM.
