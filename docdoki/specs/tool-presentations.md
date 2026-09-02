---
purpose: Bounded presentation declarations turn Pi tools and optional Thinking text into compact, truthful Web activity while preserving native card shells and fallbacks.
covers:
  - shared/tool-presentation-config.ts
  - server/tool-presentation-config.ts
  - src/tool-presentations/
  - src/components/transcript-cards.tsx
  - src/styles.css
  - tests/server/app.test.ts
  - tests/server/tool-presentation-config.test.ts
  - tests/web/tool-cards.test.tsx
  - tests/web/tool-presentations.test.ts
  - tests/web/thinking-presentations.test.tsx
---

# Activity presentations

## Goal

Make common tool and Thinking activity immediately legible without coupling the browser to Pi's imperative terminal renderers, admitting arbitrary executable presentation code, or hiding canonical content when a semantic projection cannot safely interpret it.

## Checks

- Existing Tool and Thinking cards remain the only owners of identity, disclosure, Adaptive lifecycle, status, copy, resource actions, motion, accessibility, and failure styling. A configured presentation replaces only its summary and expanded body.
- Tool rule definitions have namespaced ids and remain separate from exact tool-name mappings. INSΠRE ships project-wide Pi rules and mappings; a machine-local configuration adds declarative rules and replaces mappings without modifying shipped definitions.
- Tool resolution applies the user mapping for a tool name when present, otherwise the shipped mapping. After selecting that one mapping, a missing, throwing, or shape-incompatible rule returns directly to generic raw rendering; it never tries a second semantic rule.
- Thinking has one optional direct declaration because it is a singleton activity kind. It may select only display-cleaned `thinking.text`; tool rules cannot select that namespace, and Thinking cannot select tool arguments or results.
- If a Thinking summary cannot resolve, the complete native Thinking presentation remains active. If only its lazy body is incompatible, the configured summary remains while the body falls back to native Thinking rich text. Copy continues to use the complete display-cleaned Thinking text.
- Declarations are pure projections. Tool rules see only the persisted/RPC-visible call name, arguments, result content, result details, and lifecycle state; Thinking sees only its loaded text. Declarations do not read files, access the network, or infer extension provenance.
- Resolving a collapsed card remains cheap. Potentially large blocks are built only when the body mounts, code bodies initially project at most 400 numbered lines, and declarative summaries cannot select full tool result text or JSON-format objects. User text and structured item previews are bounded; complete copy actions retain the canonical call, result, or Thinking content. Unified edit patches remain complete because the patch is the content being inspected.
- Both activity kinds use the same bounded block vocabulary: properties, text, sanitized Markdown, code, terminal output, unified diff, replacement, list, grouped search, image, and notice.
- Shipped mappings cover Pi's native `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools. They present file/range metadata, numbered source or image previews, requested writes, authoritative applied patches, terminal command/output, grouped matches, and file or directory lists rather than argument JSON. A grouped-search match tint spans the complete horizontal range shared with longer neighboring lines.
- File-resource actions retain the complete reference for preview and accessibility. A path that fits remains visually complete; actual overflow uses one continuous middle projection that gives the bounded filename tail first claim on available width, then preserves as much leading context as fits. The visible leading and tail text stay adjacent without a breakpoint-only abbreviation or blank spacer. An expanded block keeps its label on one line while the path consumes every remaining pixel in the row.
- Successful native `edit` cards use Pi's persisted `details.patch`; they never reread the workspace or compute a replacement diff in the browser. Pending or failed edits may show explicitly labelled requested replacements without claiming file coordinates or application success. Every unified-diff row tint spans the complete scrollable width, including the horizontal overflow created by longer neighboring lines.
- Native truncation and result-limit metadata becomes a separate notice rather than being mixed into source, terminal, search, or list content. Complete copy actions still retain the original full arguments and result projection.
- Unknown tools, malformed calls, unexpected result shapes, absent Thinking configuration, and failed rule execution retain their inspectable native fallback. No selected-rule failure is swallowed or reinterpreted as another tool.

## User configuration boundary

Source checkouts load `.inspire/tool-presentations.json`, inside the already ignored machine-local directory. Installed packages use the native user configuration directory: `${XDG_CONFIG_HOME:-~/.config}/inspire` on Linux, `~/Library/Application Support/Inspire` on macOS, and `%APPDATA%\\Inspire` on Windows. `INSPIRE_TOOL_PRESENTATIONS_PATH` overrides either location. The Host validates the file on every authenticated bootstrap and never rewrites it. Invalid input raises a transient warning and activates no user tool rules or Thinking declaration.

Tool declarations can select persisted `args.*`, normalized `result.*`, and `tool.name` fields. Exact mappings bind tool names to user or shipped rule ids. The optional top-level `thinking` declaration uses the same summary and block grammar directly, with `thinking.text` as its sole selectable field:

```json
{
  "version": 1,
  "rules": {},
  "mappings": {},
  "thinking": {
    "summary": [
      { "value": { "literal": "Trace" } },
      {
        "value": { "path": "thinking.text", "format": "first-line" },
        "subdued": true
      }
    ],
    "blocks": [
      {
        "type": "markdown",
        "label": "Reasoning",
        "source": { "path": "thinking.text" }
      }
    ]
  }
}
```

Declarations compile into typed render primitives. They cannot execute JavaScript or React, inject HTML or CSS, read files, or access the network.

## Non-goals

- Pi `renderCall` and `renderResult` return terminal components and are not reused as Web renderers.
- INSΠRE does not auto-detect which extension owns an overridden tool name; an informed user owns that mapping.
- Users cannot replace card shells, lifecycle behavior, copy authority, status semantics, or disclosure interactions through presentation declarations.
