# Custom presentations

Local JSON declarations customize tool cards, Thinking, and displayed custom messages without changing Inspire or the Pi extension. Tool and Thinking rules define a collapsed summary and typed body blocks; custom-message declarations select a reading title and exact Markdown body. Inspire owns layout, disclosure, copy, and resource actions, plus lifecycle/status for activity cards.

## Configuration

| Installation    | Default file                                                              |
| --------------- | ------------------------------------------------------------------------- |
| Source checkout | `<checkout>/.inspire/tool-presentations.json` (`.inspire/` is gitignored) |
| Linux package   | `${XDG_CONFIG_HOME:-~/.config}/inspire/tool-presentations.json`           |
| macOS package   | `~/Library/Application Support/Inspire/tool-presentations.json`           |
| Windows package | `%APPDATA%\Inspire\tool-presentations.json`                               |

`INSPIRE_TOOL_PRESENTATIONS_PATH=/absolute/path/to/file.json` overrides the default. Set it in the environment that starts the Host, then restart. Editing the selected file needs only a browser refresh: every authenticated bootstrap reads and validates it. Invalid input produces a warning and uses the shipped presentations.

For versioned personal profiles, keep the JSON in a separate configuration repository and select it with the override or a symlink at the default path. Keep runtime state and pairing data out of that repository. Declarations are sent to the browser, so literals must not contain secrets.

Every configuration requires `version`, `rules`, and `mappings`. An empty profile uses native presentations and generic extension cards:

```json
{ "version": 1, "rules": {}, "mappings": {} }
```

Presentation profiles do not change which Pi extensions run.

## Example

This custom search tool returns an unindented file path followed by numbered match/context lines:

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

Mapping `grep` instead of `custom_search` replaces the native-name presentation, useful when an extension overrides that tool. The rule uses the query/path in its summary rather than repeating them above the results.

## Rule selection

For each exact RPC tool name, Inspire chooses the user mapping, otherwise the shipped mapping, otherwise the generic card. If the selected rule is missing, fails, or cannot interpret the data, the card falls directly back to generic rendering; it does not try another semantic rule.

User rule IDs must be namespaced, such as `user.example.search`. Shipped `inspire.*` IDs are reserved. A user mapping may reference a shipped rule without redefining it.

## Native Codemode and nested calls

Codemode and nested tools show child calls inside the parent card. Expanded running cards show the
call process; settled cards lead with the result and keep Calls and Script as secondary disclosures.
Open a call to inspect available parameters, errors and duration. Codemode parameter summaries remain
labelled previews. Inspecting Calls or Script keeps the card open through completion.

Results use the existing text, image and authorized file viewers. The shared call view does not require
a custom presentation profile and preserves the configured tool/activity display preferences.

## Values and summaries

A value is a literal, such as `{ "literal": "Matches" }`, or a field selection, such as `{ "path": "args.root", "fallback": ".", "format": "basename" }`.

| Selectable field                           | Content                                                                 |
| ------------------------------------------ | ----------------------------------------------------------------------- |
| `args.<key>`                               | Tool-call arguments; dots select nested keys and numeric array indexes. |
| `result.text`                              | Normalized textual result.                                              |
| `result.error`                             | Whether the result is an error.                                         |
| `result.details` or `result.details.<key>` | Structured result details.                                              |
| `tool.name`                                | Exact RPC tool name.                                                    |

Field selections accept `fallback`, `prefix`, `suffix`, and `format`. Formats are `text` (default), `json`, `first-line`, `basename`, and `count`. Summary values cannot select `result.text` or use JSON formatting.

A summary part has a `value`; `kind: "resource"` makes it a file reference. `reference` can supply a target different from the displayed value. Parts use a space separator by default; `separator: "dot"` and text-only `subdued: true` are available.

A missing required value makes the rule incompatible. Set `optional: true` on a summary part, individual property, or body block to omit it instead. A `properties` block is made optional item by item. Result-backed blocks are omitted until a result arrives.

## Body blocks

| Type                           | Fields and behavior                                                                                                                                                                                               |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `properties`                   | `items`: labeled values with optional `resource` references.                                                                                                                                                      |
| `text`, `markdown`, `terminal` | `source` and optional `label`. Markdown uses the shared sanitized renderer.                                                                                                                                       |
| `code`                         | `source`, optional `label`, `language`, and `lineNumbers` (false hides the gutter).                                                                                                                               |
| `diff`                         | Unified-diff `source`, optional `label` and file `path`.                                                                                                                                                          |
| `replacement`                  | Required `label`, `oldText`, and `newText`; optional file `path`.                                                                                                                                                 |
| `list`                         | Array or newline-delimited `source` rendered as file/directory links; optional `root` supplies their base path. `format: "annotated-lines"` recognizes trailing `  [annotation]` and standalone `[notice]` lines. |
| `search`                       | `source` with `format: "grouped-lines"`: file headers followed by ` <line>: <match>` or ` <line>- <context>` rows. Standalone bracketed lines are notices.                                                        |
| `image`                        | Base64 `data`, `mimeType`, and `alt` values; PNG, JPEG, GIF, and WebP are supported.                                                                                                                              |
| `notice`                       | `source`, optional `tone`: `muted`, `warning`, or `error`.                                                                                                                                                        |

`list` and `search` also accept `label`, `emptyValues`, and `emptyText`. Sources and the named value fields use the same literal/selection grammar above. `label` and other declaration options are ordinary JSON values. The full schema is `shared/tool-presentation-config.ts` in a source checkout.

For task or agent-status lists, use text/Markdown or a text widget rather than file-opening `list` blocks.

Bodies have bounded previews and local scrolling. Copy uses the Host-projected arguments and final result; the displayed preview can be shorter. Argument-generation copies are explicitly partial.

## Thinking cards

The optional top-level `thinking` declaration uses the same summary/block grammar directly, without a tool mapping. Its only selectable field is display-cleaned `thinking.text`:

```json
{
  "version": 1,
  "rules": {},
  "mappings": {},
  "thinking": {
    "summary": [
      { "value": { "path": "thinking.text", "format": "first-line" } }
    ],
    "blocks": [{ "type": "markdown", "source": { "path": "thinking.text" } }]
  }
}
```

A missing or incompatible summary uses the native Thinking card. If only the body fails, the configured summary remains and the body uses native rich text.

## Custom messages

Optional `customMessages` declarations match exact Pi `customType` strings (1–128 characters,
including spaces and Unicode) independently of outgoing tool mappings. For an extension that supplies structured sender and body fields:

```json
{
  "version": 1,
  "rules": {},
  "mappings": {},
  "customMessages": {
    "review_message": {
      "source": "Review",
      "title": ["details.sender.name", "details.sender.id"],
      "body": "details.body",
      "requireAbsent": ["details.externalOrigin"]
    }
  }
}
```

- `source` is a subdued source/type label.
- `title` lists up to four field paths. The first nonblank string becomes the primary title; missing,
  null, or blank candidates advance to the next path. A non-string candidate is incompatible.
- `body` selects an exact string rendered as sanitized Markdown, without rewriting or truncation.
- Paths select `content` or `details.<key>` with safe dot-separated keys.
- Optional `requireAbsent` paths must be absent. Any present value, including null or false, restores
  generic rendering. Use guards when a selected title would omit provenance or trust qualifications.

Only string-content messages use this projection. Missing declarations, incompatible fields, and
text/image/unknown-block arrays retain the readable generic presentation. Customized Details lazily
shows the original `customType`, `content`, and `details`; copy always includes that complete original
content and details. Presentation does not change Pi's message or model context.

Existing version-1 profiles remain valid without `customMessages`. Older Inspire releases reject
this added field; remove it when sharing a profile with those releases.

Declarations select data; they cannot execute code, inject HTML/CSS, or access the filesystem/network. For commands, widgets, or dedicated GUI controls, see [Extension adaptation](extensions.md).
