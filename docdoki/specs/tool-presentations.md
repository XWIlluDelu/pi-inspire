---
purpose: Declarative presentations project tool and Thinking activity and select custom-message reading content while retaining generic inspection.
covers:
  - shared/tool-presentation-config.ts
  - src/presentation-adapters.ts
  - src/components/{ComposerThinkingControl,StatusChoice,PresentationAdapterSettings,Dropdown,ExtensionDisplays}.tsx
  - src/styles/status-choice.css
  - shared/tool-activity.ts
  - server/tool-presentation-config.ts
  - server/{runtime-events,session-projection}.ts
  - src/tool-presentations/**
  - src/custom-message-presentations.ts
  - src/components/CustomMessage.tsx
  - src/components/{Transcript,transcript-cards,ChildCalls,CodeModeResult,ImagePreview}.tsx
  - src/components/ResourcePathLabel.tsx
  - src/child-call-summary.ts
  - tests/web/status-choice.test.tsx
  - src/styles/activity-cards.css
  - tests/browser/{tool-presentations,custom-message}.spec.ts
  - tests/server/{app,app-events}.test.ts
  - tests/server/tool-presentation-config.test.ts
  - tests/web/{tool-cards,tool-output-preview,child-calls,codemode-result}.test.tsx
  - tests/server/pi-child-calls.integration.test.ts
  - tests/fixtures/pi-child-calls-extension.ts
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
  generic rendering without trying another semantic rule.
- Thinking has one optional direct declaration. It may select only display-cleaned `thinking.text`;
  tool rules select tool data. A failed Thinking summary restores the native presentation; a failed
  lazy body keeps its configured summary and uses native rich text.
- Rules read Host-projected arguments, results, and tool names. Built-in rules can also use lifecycle
  metadata. Declarations cannot execute code, inject HTML/CSS, read files, access the network, or
  identify the extension behind a tool name. Pi TUI renderers are not Web renderer plugins.

## Content and cost

- Blocks support properties, text, sanitized Markdown, code, terminal output, unified diff,
  replacement, list, grouped search, image, and notice.
- Bodies mount lazily. Declarative summaries cannot select `result.text` or JSON-format objects.
  Text and structured previews are bounded; code initially shows at most 400 lines. Unified edit
  patches keep every projected line.
- Copy serializes on demand from the Host-projected call/result or complete display-cleaned Thinking
  text, independently of display truncation. Argument previews keep their partial labels and
  resource-action restrictions from [[activity-presentation]].
- Long bodies scroll inside the card and support keyboard access. `lineNumbers: false` hides the
  gutter; numbered rows share a scroll plane so the gutter remains aligned during horizontal scroll.
- Resource actions keep the complete reference for preview and accessibility. A fitting path stays
  complete. Overflow uses middle truncation, prioritizing the filename tail and filling remaining
  width with leading context. The final path separator stays visible beside the filename when its
  parent is elided. Expanded block labels stay on one line beside the available path width.

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

Search context with the same line number and text is merged, keeping match flags. Match and diff row
tints span the complete shared horizontal scroll width. Unified-diff recognition requires patch
structure; ordinary prose starting with `+` or `-` is not recolored. Native truncation
and result-limit metadata appears as a separate notice. When Pi records a full shell-output file,
that notice offers “View full output” through the existing session-authorized file viewer.
Notices read as compact output footnotes, with centered text/actions, a short semantic side rule
and wrapping when needed. Inline actions use the compact output sizing in [[design-system]].

Streaming/interrupted edit previews accept incomplete fields and newly started array items without
discarding earlier typed replacements. Missing old/new sides render no rows; an explicit empty string
is a received side. Field order does not determine compatibility. Complete calls and wrong field
types remain strict. A successful edit requires the authoritative patch; the browser does not reread
the workspace or calculate an applied diff.

## Codemode and nested calls

CodeMode and ordinary nested tools show child-call rows when the parent card opens.

- The display title is `CodeMode`; the native tool name remains `codemode`. Its compact header
  keeps recorded call/failure counts and available runner duration visible while open or collapsed,
  without inferring script intent or changing the parent outcome. User-selected presentation rules
  keep their own summaries.
- Open CodeMode cards keep Calls → Output → Script through execution and history. The calls list
  opens with its parent and grows in the conversation scroller. Counts live in the header. Output
  uses the native tool output inset, and Script starts collapsed with a single heading.
  Focus and reading position survive settlement. Ordinary nested tools use a bounded calls list
  with its own heading and show settled results first unless the calls are being read.
- Full-row disclosures expose parameters, errors and duration. Hover and press use local text
  feedback without a box. Keyboard focus uses an outline. Argument and output readers stay bounded.
- CodeMode renders output blocks in their original order in one reading view, separated by whitespace,
  without mode tabs, interactive JSON trees, collection paging or a panel and heading per block.
  JSON keeps every key, scalar type, numeric literal and object/array hierarchy; multiline strings
  show decoded newlines. Never assign output to calls or infer metadata from property names.
- A recognized standalone first-part runner banner contributes duration to the card header instead
  of the output body. Other text stays literal. Received output remains available in a height-bounded,
  keyboard-scrollable viewport; images keep their existing preview and original persisted indices.
- The single header copy follows the shared tool-block contract: tool name, arguments/Script, original
  result text (including the runner banner) and recorded result details. Result-only imports copy their
  result record without inventing a Script. There is no duplicate output-copy or Result details
  inspector. Recorded full-output files remain available through the existing authorized viewer.
- Rows show native status, tool/model identity and a useful path/query/parameter summary. Available
  arguments, errors and useful duration details open through keyboard/touch-capable disclosure.
  Parameter previews are not labelled complete. Truncated JSON previews may contribute complete
  top-level fields, never partial strings or nested lookalikes. Omit unusable summaries instead of
  displaying broken JSON; keep the original preview in row details. Paths preserve their leaf name
  when shortened visually. Keep order and row identity stable; bounded call projections are distinct
  from the CodeMode viewport's unconstrained height.
- The Host projects one child-call list per parent. Codemode supplies `details.calls`, live generic
  tools use parented execution events, and generic history uses the result message's `nestedCalls`.
  The browser renders that list for both live activity and history.
- Keep parent and child outcomes distinct. Do not infer that a failed child was intentionally handled
  merely because the parent completed successfully. Missing child results do not hide parent output.
- Use the shared text, image and authorized file readers. Classification-specific displays require
  a structured data contract. Script and call details remain available on demand.

## Generic results

Native and generic tool images remain visible when loaded from saved history. Persisted images resolve
through their message/part references; both inline and persisted images open the existing image preview.

Unknown tools and incompatible rules keep arguments, text, supported images, and structured
details. Expanded generic cards lead with the result and place arguments behind their own disclosure;
unsettled calls keep status and available arguments. Details serialize only when opened. A result
whose call is outside loaded history keeps its content without fabricated arguments. Invalid image
MIME types, excessive data, or invalid base64 characters produce a visible notice, not an empty
result.

## Custom-message reading projections

Optional `customMessages` maps exact Pi `customType` strings (including spaces and Unicode, bounded
to 128 characters) directly to a source label, ordered title field candidates, an exact Markdown
body field, and optional absent-field guards. Selectors read only
`content` or nested `details` keys. A missing/blank title candidate advances; non-string selected
values, missing bodies, present guarded fields, and non-string original content restore the generic
message. Present null/false guard values are not absence.

These reading projections preserve Pi content and remain independent of activity-card lifecycle.
The original type, content, and structured details remain in lazy Details and complete copy;
text/image/unknown-block content keeps generic rendering.
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

## Extension adapter composition

- One normal web build supplies generic capabilities. Extension-specific rules, commands, source
  names and text remain in external modules; no source patching or alternate adapter build exists.
- The selected profile declares ordered adapter references with stable IDs, names, paths and default
  enablement. Settings → Adapters persists per-ID overrides and updates the current browser without
  discarding drafts, attachments or Pi state. Module files remain unchanged.
- Relative paths resolve beside the physical profile. Disabled modules are not read; malformed
  modules warn independently. Later exact identities replace earlier declarations, hidden status
  keys union, and the combined configuration remains bounded. Nested module inclusion is unsupported.
- Status-bound discrete choices compose above the native Thinking options in both New and active
  sessions. A shared capability filter uses each lifecycle's command inventory and the same
  native-name precedence as completion; pages do not separately decide which adapters exist. New
  discovers registrations from its prospective directory without starting a session or reading
  another worker's mutable status.
- Unchanged choices keep Pi defaults. Explicit choices remain draft intent until creation and must
  be confirmed before first input delivery. A failed or uncertain application leaves that input and
  artifacts in the created session instead of sending with an unintended setting.
- Controls keep confirmation text, commit pointer selection on release and use one Pi-state
  confirmation boundary for initial and live changes. Pending state stays in the control's
  busy/disabled presentation without an extra progress line, keeping option guidance and errors; it
  survives closing the menu, and session/transport changes retire it. Effort availability does not
  disable an independently supported extension choice. A delayed confirmation clears its obsolete
  timeout hint as soon as Pi publishes the requested value. Missing status is neutral
  unavailability, not evidence that the extension needs reloading; confirmation timeout does not
  prescribe connection repair or redispatch a command.
- Exact hidden status keys affect display only. Configurable checkpoint titles, prefix elision and
  metric wording do not change the original summary, source identity or complete Copy.
- Cards, messages, controls and checkpoint rules use the same composition and enablement mechanism.
  Disabling restores native/generic display, not extension execution control.
## Checks

Resolver tests exercise rule selection, shape checks, and fallback. Component tests exercise
disclosure, retained content, and copy ownership. Browser tests exercise reading position,
scrolling, and clipboard behavior.
