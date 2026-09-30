---
purpose: Declarative tool and Thinking presentations provide typed summaries and bodies within the shared activity-card shell.
covers:
  - shared/tool-presentation-config.ts
  - server/tool-presentation-config.ts
  - src/tool-presentations/**
  - src/components/transcript-cards.tsx
  - src/components/ResourcePathLabel.tsx
  - src/styles/activity-cards.css
  - tests/browser/tool-presentations.spec.ts
  - tests/server/app.test.ts
  - tests/server/tool-presentation-config.test.ts
  - tests/web/{tool-cards,streaming-edit-cards}.test.tsx
  - tests/web/thinking-presentations.test.tsx
  - tests/web/tool-presentations.test.ts
---

# Tool and Thinking presentations

## Goal

Make common activity legible through typed data projections, with generic inspection when a rule
cannot interpret the content. [[activity-presentation]] owns card identity, disclosure, lifecycle,
status, copy actions, and streaming behavior. A rule replaces only the summary and expanded body.

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

| Tool | Content |
| --- | --- |
| `read` | File/range summary and source or image preview, without repeating that metadata above the body. |
| `write` | Requested file content. |
| `edit` | Requested replacements while pending/failed; Pi's persisted `details.patch` after success. |
| `bash`, `powershell` | Command and terminal output. |
| `grep` | Grouped matches and context. |
| `find`, `ls` | File/directory lists. |

Search context with the same line number and text is merged while retaining match flags. Match and
diff row tints span the complete shared horizontal scroll width. Unified-diff recognition requires
patch structure rather than recoloring ordinary prose starting with `+` or `-`. Native truncation
and result-limit metadata appears as a separate notice.

Streaming/interrupted edit previews accept incomplete fields and newly started array items without
discarding earlier typed replacements. Missing old/new sides render no rows; an explicit empty string
is a received side. Field order does not determine compatibility. Complete calls and wrong field
types remain strict. A successful edit requires the authoritative patch; the browser does not reread
the workspace or calculate an applied diff.

## Generic results

Unknown tools and incompatible rules retain arguments, text, supported inline images, and structured
details. Details serialize only when opened. A result whose call is outside loaded history retains
its content without fabricated arguments. Invalid image MIME types, excessive data, or invalid base64
characters produce a visible notice rather than an empty result.

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

Schema and resolver tests cover invalid configuration, mapping precedence, shape failures, and
Thinking fallback. Card tests cover native content, progressive edit shapes, generic results,
copy/resource ownership, and display bounds. Browser evidence is in
[[follow-tool-display-review-2026-09-29]].
