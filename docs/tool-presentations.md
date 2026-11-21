# Custom presentations

A JSON profile defines summaries and body blocks for tool and Thinking cards, titles and Markdown
bodies for custom messages, and status controls for extensions. Inspire supplies disclosure, copy
and file actions. Declarations select data and cannot execute code. For commands and widgets, see
[Extension adaptation](extensions.md).

## Configuration

| Installation    | Default file                                                              |
| --------------- | ------------------------------------------------------------------------- |
| Source checkout | `<checkout>/.inspire/tool-presentations.json` (`.inspire/` is gitignored) |
| Linux package   | `${XDG_CONFIG_HOME:-~/.config}/inspire/tool-presentations.json`           |
| macOS package   | `~/Library/Application Support/Inspire/tool-presentations.json`           |
| Windows package | `%APPDATA%\Inspire\tool-presentations.json`                               |

To select another file, set `INSPIRE_TOOL_PRESENTATIONS_PATH` in the Host environment and restart
the Host. A symlink at the default path also works. Refresh the browser after editing. Invalid
profiles produce a warning and restore the shipped presentations. The authenticated browser
receives the declarations, so keep credentials out of the profile.

Every profile requires `version`, `rules`, and `mappings`. The empty profile is
`{"version":1,"rules":{},"mappings":{}}`.

For editor completion and structure checks, point `"$schema"` at the
[editor schema](tool-presentations.schema.json). A profile in a source checkout's `.inspire/`
directory can use `"$schema": "../docs/tool-presentations.schema.json"`. Inspire validates the
rules when it reads the profile and keeps the schema reference local to the file.

## Example

Save this profile and replace `custom_search` with the tool's exact RPC name. Its result contains
an unindented file path followed by numbered match and context lines.

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

## Rule selection

A user mapping overrides the shipped mapping for the same tool name. Mapping `grep` to
`user.example.search`, for example, replaces its native presentation. A missing or incompatible
selected rule uses the generic card. User rule IDs must be namespaced. Mappings can reference
shipped `inspire.*` rules, whose definitions are reserved.

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
| `image`                        | Base64 `data`, `mimeType`, and `alt` values; PNG, JPEG, GIF, WebP, and BMP are supported.                                                                                                                              |
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
- `body` selects a string from the bounded message preview and renders it as sanitized Markdown.
- Paths select `content` or `details.<key>` with safe dot-separated keys.
- Optional `requireAbsent` paths must be absent. Any present value, including null or false, restores
  generic rendering. Use guards when a selected title would omit provenance or trust qualifications.

Only string-content messages use this projection. Missing declarations, incompatible fields, and
text/image/unknown-block arrays retain the readable generic presentation. Customized Details lazily
shows `customType`, `content`, and `details` from the same bounded preview. Copy reads the saved
message on demand to include its complete original content and details. Presentation does not change
Pi's message or model context.

## Extension adapters

One selected profile composes independent adapter files:

```json
{
  "version": 1,
  "rules": {},
  "mappings": {},
  "adapters": [
    { "id": "example", "name": "Example", "path": "../modules/example.json", "enabled": true }
  ]
}
```

Toggle modules in **Settings → Adapters**. Choices take effect immediately and persist in Inspire
preferences. Disabling a module removes its declarations.

A module uses the same profile format and cannot include other adapters. Paths resolve relative
to the physical profile file, including through symlinks. Later modules replace matching rule IDs,
tool names, custom-message types, controls, checkpoints and the Thinking declaration. Hidden status
keys combine. Disabled files are skipped. An invalid module produces a warning while the other
modules remain active. Each file and the combined profile have a 256 KiB limit.

Modules can also declare:

- `hiddenStatuses` lists exact RPC status keys to omit from the top bar. A control automatically
  hides its own `state.key` while the value parses.
- `controls` adds discrete choices to the Thinking selector. Each control has a namespaced `id`,
  a `label`, `slot: "thinking"`, a registered slash `command` (including collision suffixes such
  as `/mode:2`), a `state` selector and two to eight `options`. Each option has a command
  `value` and a compact `label`. Optional fields are `title`, `description`, `confirmation` and
  `indicator` (`bolt` or `double-bolt`).
- `checkpoints`: exact compaction `source`, `title`, `tokensLabel` and `tokensDescription`.
  Optional `summaryPrefix` elides a redundant displayed prefix while retaining source Copy.
  `legacySummaryPrefix` matches cached source-less records at a word/colon boundary.

For example, a generic control declaration is:

```json
{
  "id": "user.example.mode",
  "slot": "thinking",
  "label": "Response mode",
  "command": "/response-mode",
  "state": { "key": "example-mode", "value": "mode" },
  "options": [
    { "value": "normal", "label": "Normal" },
    { "value": "quick", "label": "Quick", "indicator": "bolt" }
  ]
}
```

Put this declaration in `controls`. When the user selects Quick, Inspire sends
`/response-mode quick`. The extension publishes the effective state, such as `{"mode":"quick"}`,
under `example-mode` with `ctx.ui.setStatus()`. Publish at `session_start`, after each accepted
choice and when capabilities change, even if the terminal footer is hidden. The optional
`state.supported` path selects an object containing one boolean per option. `state.active` selects
a boolean indicating whether the current model applies the selected value.

A control appears when the target directory exposes its extension command. A live change requires
valid status from Pi. Before creating a session, an untouched control keeps Pi's default. An explicit
choice waits for Pi's status confirmation before sending the first message. If confirmation fails,
the new session keeps the draft and its attachments. The extension owns persistence and restoration.

## Native Codemode and nested calls

The shipped `codemode` presentation shows Calls, Output and Script. Child rows retain available
arguments, failures and durations. A child failure leaves the parent outcome intact. Opening a
child or the script keeps the card open through completion. Output preserves block order and
multiline JSON values. Copy includes the original script, result and recorded details. Images
and recorded full-output files open in their usual viewers. Other tools with child calls use
the same rows without a profile.
