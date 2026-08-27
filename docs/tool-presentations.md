# Custom tool presentations

INSΠRE ships presentation rules for Pi's native tools. A local user can add data-only rules for custom tools and replace exact tool-name mappings without changing INSΠRE or the tool extension. See [Adapting Pi Extensions to INSΠRE](extensions.md) when deciding whether behavior belongs in a command, widget, or Tool Presentation.

## Configuration location

- Source checkout: `<checkout>/.inspire/tool-presentations.json` (`.inspire/` is gitignored).
- Installed package: `${XDG_CONFIG_HOME:-~/.config}/inspire/tool-presentations.json` on Linux, `~/Library/Application Support/Inspire/tool-presentations.json` on macOS, or `%APPDATA%\\Inspire\\tool-presentations.json` on Windows.
- Explicit host override: `INSPIRE_TOOL_PRESENTATIONS_PATH=/path/to/tool-presentations.json`.

The host reads the file for every authenticated bootstrap, so save it and refresh the page. Invalid JSON or declarations produce a browser warning and leave only shipped rules active; the file is never rewritten. The validated declarations are sent to the authenticated browser, so the file is private configuration, not a credential store: do not place secrets in literals.

## Resolution

Rules and mappings are separate. A mapping selects exactly one rule:

```text
user mapping for tool name
> shipped mapping for tool name
> generic raw card
```

Once a user mapping is selected, a missing rule, exception, or incompatible data shape goes directly to the generic raw card. INSΠRE does not guess tool provenance and does not try the shipped mapping afterward. Shipped `inspire.*` rule IDs are reserved and cannot be redefined, although a user mapping may point another tool name to a shipped rule.

## Example

```json
{
  "version": 1,
  "rules": {
    "user.example.search": {
      "summary": [
        {
          "value": { "path": "args.pattern", "prefix": "/", "suffix": "/" }
        },
        {
          "value": { "literal": "in" },
          "subdued": true
        },
        {
          "kind": "resource",
          "value": { "path": "args.path", "fallback": "." }
        }
      ],
      "blocks": [
        {
          "type": "properties",
          "items": [
            { "label": "Query", "value": { "path": "args.pattern" } },
            {
              "label": "Root",
              "value": { "path": "args.path", "fallback": "." },
              "resource": { "path": "args.path", "fallback": "." }
            }
          ]
        },
        {
          "type": "search",
          "label": "Matches",
          "source": { "path": "result.text" },
          "format": "grouped-lines",
          "emptyValues": ["No matches found"],
          "emptyText": "No matches found"
        }
      ]
    }
  },
  "mappings": {
    "custom_search": "user.example.search"
  }
}
```

Mapping `grep` instead of `custom_search` explicitly replaces the shipped `grep` presentation. This is useful when an extension itself replaces Pi's tool under the native name.

## Thinking presentation

A top-level `thinking` declaration can provide the same `summary` and `blocks` arrays for Thinking cards without a rule or tool-name mapping:

```json
{
  "version": 1,
  "thinking": {
    "summary": [
      { "value": { "path": "thinking.text", "format": "first-line" } }
    ],
    "blocks": [{ "type": "markdown", "source": { "path": "thinking.text" } }]
  }
}
```

`thinking.text` is the only field root available in this declaration. It contains display-cleaned reasoning text and remains subject to the same validation, truncation, and sanitized Markdown rendering as tool rules. A missing or incompatible declaration falls back to the native Thinking card.

## Values and fields

Every displayed value is either a literal or a field selection:

```json
{ "literal": "Result" }
{ "path": "args.query" }
{ "path": "args.root", "fallback": ".", "format": "basename" }
```

Allowed field roots are:

- `args.<key>` — tool-call arguments; nested keys and numeric array indexes use dots.
- `result.text` — normalized textual result content.
- `result.error` — whether the tool result is an error.
- `result.details.<key>` — persisted result details.
- `tool.name` — the exact RPC tool name.

Value options are `fallback`, `prefix`, `suffix`, and `format`. Formats are `text` (default), `json`, `first-line`, `basename`, and `count`. Summary values cannot use `result.text` or JSON formatting, keeping collapsed-card resolution cheap.

A required missing value makes the selected rule incompatible. Set `"optional": true` on a summary part, property, or block to omit it instead. Result-backed blocks are omitted while a call is still pending.

Each summary part has a `value`. `kind: "resource"` makes it an INSΠRE file reference; an optional `reference` can differ from the displayed value. Parts default to a space separator and may instead use `separator: "dot"`; text parts may use `subdued: true`.

## Declarative blocks

Supported block types are:

- `properties`: labeled scalar values with optional resource references.
- `text`, `markdown`, `code`, and `terminal`: one selected value; `code` also accepts `language` and `lineNumbers`.
- `diff`: unified diff text with an optional resource `path`.
- `list`: arrays or newline-delimited text. `annotated-lines` recognizes trailing `  [annotation]` metadata and standalone `[notice]` lines.
- `search`: `grouped-lines` expects an unindented path header followed by ` <line>: <match>` or ` <line>- <context>` rows; standalone bracketed lines become notices.
- `replacement`: `oldText`, `newText`, and an optional `path`.
- `image`: base64 `data`, `mimeType`, and `alt` values for PNG, JPEG, GIF, or WebP.
- `notice`: a selected value with optional `muted`, `warning`, or `error` tone.

Declarations cannot execute JavaScript or React, inject HTML, or access the filesystem or network. Markdown uses INSΠRE's existing sanitized renderer. Structured previews and text bodies are bounded; the card Copy action still includes the complete persisted arguments and result.
