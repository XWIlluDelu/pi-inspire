---
purpose: Declarative presentations project tool and Thinking activity and select custom-message reading content while retaining generic inspection.
covers:
  - shared/tool-presentation-config.ts
  - shared/tool-activity.ts
  - server/tool-presentation-config.ts
  - server/{runtime-events,session-projection}.ts
  - src/tool-presentations/**
  - src/custom-message-presentations.ts
  - src/components/CustomMessage.tsx
  - src/components/{Transcript,transcript-cards,ChildCalls,CodeModeResult,ImagePreview}.tsx
  - src/components/ResourcePathLabel.tsx
  - src/child-call-summary.ts
  - tests/web/child-call-summary.test.ts
  - src/styles/activity-cards.css
  - tests/browser/{tool-presentations,custom-message}.spec.ts
  - tests/server/app.test.ts
  - tests/server/tool-presentation-config.test.ts
  - tests/web/{tool-cards,tool-card-fallbacks,streaming-edit-cards,child-calls,codemode-result}.test.tsx
  - tests/server/pi-child-calls.integration.test.ts
  - tests/fixtures/pi-child-calls-extension.ts
  - tests/fixtures/tool-result-resources.{mjs,d.mts}
  - tests/web/thinking-presentations.test.tsx
  - tests/web/tool-presentations.test.ts
  - tests/web/custom-message*.test.{ts,tsx}
---

# Configurable presentations

## Goal

Make common activity legible through typed data projections, with generic inspection when a rule
cannot interpret the content. [[activity-presentation]] owns tool/Thinking card identity, disclosure,
lifecycle, status, copy actions, and streaming behavior. Those rules replace only the summary and
expanded body. [[conversation]] owns independently readable custom messages.

## Rule selection

- Namespaced rule definitions are separate from exact tool-name mappings. User mappings take
  precedence over shipped mappings; shipped `inspire.*` definitions are reserved.
- Select one mapping. A missing, failing, or shape-incompatible selected rule returns directly to
  generic rendering rather than trying another semantic rule.
- Thinking has one optional direct declaration. It may select only display-cleaned `thinking.text`;
  tool rules select tool data. A failed Thinking summary restores the native presentation; a failed
  lazy body retains its configured summary and uses native rich text.
- Rules read Host-projected arguments, results, and tool names. Built-in rules can also use lifecycle
  metadata. Declarations cannot execute code, inject HTML/CSS, read files, access the network, or
  identify the extension behind a tool name. Pi TUI renderers are not Web renderer plugins.

## Content and cost

- Blocks support properties, text, sanitized Markdown, code, terminal output, unified diff,
  replacement, list, grouped search, image, and notice.
- Bodies mount lazily. Declarative summaries cannot select `result.text` or JSON-format objects.
  Text and structured previews are bounded; code initially shows at most 400 lines. Unified edit
  patches retain every projected line.
- Copy serializes on demand from the Host-projected call/result or complete display-cleaned Thinking
  text, independently of display truncation. Argument previews retain their partial labels and
  resource-action restrictions from [[activity-presentation]].
- Long bodies scroll inside the card and support keyboard access. `lineNumbers: false` hides the
  gutter; numbered rows share a scroll plane so the gutter remains aligned during horizontal scroll.
- Resource actions retain the complete reference for preview and accessibility. A fitting path stays
  complete. Overflow uses middle truncation, prioritizing the filename tail and filling remaining
  width with leading context. Expanded block labels stay on one line beside the available path width.

## Native presentations

| Tool                 | Content                                                                                         |
| -------------------- | ----------------------------------------------------------------------------------------------- |
| `read`               | File/range summary and source or image preview, without repeating that metadata above the body. |
| `write`              | Requested file content.                                                                         |
| `edit`               | Requested replacements while pending/failed; Pi's persisted `details.patch` after success.      |
| `bash`, `powershell` | Command and terminal output.                                                                    |
| `grep`               | Grouped matches and context.                                                                    |
| `find`, `ls`         | File/directory lists.                                                                           |
| `codemode`           | Native child-call progress and final result, with script inspection as a secondary disclosure.  |

Search context with the same line number and text is merged while retaining match flags. Match and
diff row tints span the complete shared horizontal scroll width. Unified-diff recognition requires
patch structure rather than recoloring ordinary prose starting with `+` or `-`. Native truncation
and result-limit metadata appears as a separate notice. When Pi records a full shell-output file,
that notice offers “View full output” through the existing session-authorized file viewer.

Streaming/interrupted edit previews accept incomplete fields and newly started array items without
discarding earlier typed replacements. Missing old/new sides render no rows; an explicit empty string
is a received side. Field order does not determine compatibility. Complete calls and wrong field
types remain strict. A successful edit requires the authoritative patch; the browser does not reread
the workspace or calculate an applied diff.

## Codemode and nested calls

Codemode and ordinary nested tools share a compact child-call view inside the parent card. Existing
card/activity preferences still choose initial disclosure; no separate density setting is added.

- The display title is `CodeMode`; the native tool name remains `codemode`. Its compact header
  keeps recorded call/failure counts and available runner duration visible while open or collapsed,
  without inferring script intent or changing the parent outcome. User-selected presentation rules
  retain their own summaries.
- Calls lists appear directly whenever the parent card is open, without a second list-level
  disclosure or a call-count threshold. CodeMode lists grow with their content and use the conversation
  scroller rather than a height-limited inner viewport; individual argument/output viewports remain bounded.
  Ordinary nested calls retain their bounded list viewport. CodeMode has no repeated visible Calls heading; its call/failure counts remain in the compact card header.
  Ordinary nested tools retain their heading.
  Individual rows still disclose parameters, errors and duration.
- Open CodeMode cards retain Calls → Output → Script throughout execution and saved-history reading.
  Calls use an unboxed list without a visible section heading; Output uses the same section heading and inset surface as native
  tool output. Script stays collapsed below, without a repeated language heading. Focus and reading
  position survive settlement; finishing does not reorder the areas. Ordinary nested tools retain
  their result-first settled presentation unless their calls are being read.
- CodeMode renders output blocks in their original order in one reading view, separated by whitespace,
  without mode tabs, interactive JSON trees, collection paging or a panel and heading per block.
  JSON keeps every key, scalar type, numeric literal and object/array hierarchy; multiline strings
  show decoded newlines. Never assign output to calls or infer metadata from property names.
- A recognized standalone first-part runner banner contributes duration to the card header instead
  of the output body. Other text stays literal. Received output remains available in a height-bounded,
  keyboard-scrollable viewport; images retain their existing preview and original persisted indices.
- The single header copy follows the shared tool-block contract: tool name, arguments/Script, original
  result text (including the runner banner) and recorded result details. Result-only imports copy their
  result record without inventing a Script. There is no duplicate output-copy or Result details
  inspector. Recorded full-output files remain available through the existing authorized viewer.
- Rows show native status, tool/model identity and a useful path/query/parameter summary. Available
  arguments, errors and useful duration details open through keyboard/touch-capable disclosure.
  Parameter previews are not labelled complete. Truncated JSON previews may contribute complete
  top-level fields, never partial strings or nested lookalikes. Omit unusable summaries instead of
  displaying broken JSON; retain the original preview in row details. Paths preserve their leaf name
  when shortened visually. Keep order and row identity stable; bounded call projections are distinct
  from the CodeMode viewport's unconstrained height.
- Select native sources rather than merging unrelated schemas: Codemode `details.calls` for its tool
  and model calls; parented execution events for generic live calls; top-level result-message
  `nestedCalls` for generic history. A parent has one displayed call list.
- Keep parent and child outcomes distinct. Do not infer that a failed child was intentionally handled
  merely because the parent completed successfully. Missing child results do not hide parent output.
- Keep output in its tool presentation, reusing existing text, image, authorized file and full-output
  readers. Classification-specific presentation requires an actual structured data contract.
- No dedicated cost display, completion percentage, local stop/retry control or arbitrary-JSON-to-table
  conversion is added. Script and recorded call details remain available on demand; generic fallback
  tools retain their raw inspection.

Decided on 2026-10-05; implementation evidence: [[follow-codemode-mcp-adaptation-2026-10-05]].

## Generic results

Native and generic tool images remain visible when loaded from saved history. Persisted images resolve
through their message/part references; both inline and persisted images open the existing image preview.

Unknown tools and incompatible rules retain arguments, text, supported images, and structured
details. Details serialize only when opened. A result whose call is outside loaded history retains
its content without fabricated arguments. Invalid image MIME types, excessive data, or invalid base64
characters produce a visible notice rather than an empty result.

## Custom-message reading projections

Optional `customMessages` maps exact Pi `customType` strings (including spaces and Unicode, bounded
to 128 characters) directly to a source label, ordered title
field candidates, an exact Markdown body field, and optional absent-field guards. Selectors read only
`content` or nested `details` keys. A missing/blank title candidate advances; non-string selected
values, missing bodies, present guarded fields, and non-string original content restore the generic
message. Present null/false guard values are not absence.

These reading projections preserve Pi content and remain independent of activity-card lifecycle.
The original type, content, and structured details
remain in lazy Details and complete copy; text/image/unknown-block content retains generic rendering.
Extension-specific mappings and trust guards belong to user profiles, not shipped renderer logic.

## Configuration

The Host reads and validates the selected file on every authenticated bootstrap, leaving the file
unchanged. Invalid configuration warns the browser and activates only shipped rules. Source checkouts
use ignored `.inspire/tool-presentations.json`; packages use the platform configuration directory.
`INSPIRE_TOOL_PRESENTATIONS_PATH` overrides either. Locations, schema fields, working examples, and
versioned personal profiles are documented in [Custom tool presentations](../../docs/tool-presentations.md).

Personal profiles share the product codebase and may live in a separate configuration repository.
An empty version-1 profile selects shipped rules and generic cards; it does not disable extensions.
Runtime state and credentials stay outside presentation configuration.

## Checks

Schema and resolver tests cover invalid configuration, mapping precedence, shape failures,
Thinking fallback, exact custom-message bodies, and provenance guards. Card tests cover native
content, progressive edit shapes, generic results, copy/resource ownership, and display bounds.
Saved-image paging and recorded full-output targets are checked with native offline fixtures;
[[follow-tool-result-resources-2026-10-03]] records their unit and browser evidence.
Earlier presentation browser evidence is in [[follow-tool-display-review-2026-09-29]].
Custom-message schema, bootstrap and browser checks are recorded in
[[follow-intercom-message-card-2026-10-02]].
