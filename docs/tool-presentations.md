# Custom presentations

Local JSON declarations customize tool cards, Thinking, and displayed custom messages without changing Inspire or the Pi extension. Tool and Thinking rules define a collapsed summary and typed body blocks; custom-message declarations select a reading title and Markdown body from the bounded message preview. Inspire owns layout, disclosure, copy, and resource actions, plus lifecycle/status for activity cards.

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

Use **Settings → Adapters** to toggle each module immediately, without rebuilding the web app or
reloading Pi. Overrides persist in Inspire preferences; module files stay unchanged. These are GUI
adapters, not Pi extension installers. Disable an adapter to restore native/generic rendering.

Adapter files use this same version-1 declaration format but cannot include other adapters.
Paths resolve relative to the physical profile file, including through a profile symlink. Modules
compose in profile order: later exact rule IDs, tool mappings, custom-message types, control IDs
and checkpoint sources replace earlier ones. Hidden status keys combine; the last Thinking
declaration wins. Disabled files are not read. A broken module warns and leaves other adapters
active. The combined profile retains the same configuration-size bounds.

In addition to cards, modules may declare:

- `hiddenStatuses`: exact RPC status keys to omit from the top bar without deleting their state.
- `controls`: status-bound discrete choices in the `thinking` slot. Each declaration has a namespaced
  `id`, a `label`, an exact slash `command`, a `state` selector (`key`, `value`, optional
  `supported` and `active` field paths), and two to eight `options`. Each option has a safe command
  `value`, compact `label`, optional full `title`, `description`, `confirmation`, and
  `indicator` (`bolt` or `double-bolt`). Controls appear only when the corresponding extension
  command is available, using the same native-name precedence as command completion.
  Use Pi's registered invocation name, including collision suffixes such as `/mode:2`.
  The same choices appear before session creation when the target directory discovers the command.
  Untouched choices keep Pi defaults; an explicit choice stays local until creation, then the native
  command must be confirmed before the first input is delivered. Failure preserves that input and its
  attachments in the new session. Live changes use the same confirmation boundary: Pi status confirms
  changes; a command receipt does not.
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

Put it in a module's `controls` array. The extension publishes JSON such as `{"mode":"normal"}`
under `example-mode`. Inspire sends `/response-mode quick` only after a user selects it.
These declarations execute no JavaScript and contain no application-source substitutions.

The extension must publish this machine-readable state through `ctx.ui.setStatus()` at
`session_start`, after an accepted selection, and whenever its effective capability changes.
Publish it independently of optional terminal/footer visibility. If `supported` is selected,
provide a boolean for every option value; if `active` is selected, provide a boolean. Keep
the requested value distinct from whether it is active for the current model.

Command discovery alone does not establish this state contract. Missing or invalid state leaves
live controls unavailable; a pre-session selection cannot release the first message without
confirmation. A successful command receipt is not a substitute. The extension owns persistence
and restoration; the adapter only selects fields and sends commands. When upgrading a customized
extension, verify its published package still provides the required status, not just the command
name. Keep producer changes in the extension and presentation declarations in its adapter module.

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

CodeMode and nested tools show child calls inside the parent card. CodeMode headers summarize the
observed tools and any child failures; the native tool name stays `codemode`. CodeMode keeps Calls,
Output and Script in that order during execution and afterward. Calls lists always appear directly
inside an open parent card; long CodeMode call lists use conversation scrolling rather than a nested
list viewport. Other nested call lists retain their bounded scrolling. Script remains behind its own
disclosure. Open a call to inspect available parameters, errors and duration. Parameter previews
remain labelled. Inspecting Calls or Script
keeps the card open through completion; child failures do not change the parent's recorded outcome.

Calls use compact rows with path/command summaries; output sits in a separate reading area using
the native tool-card style. Output blocks retain their order, JSON keeps its fields and hierarchy,
and multiline strings show actual newlines. Long results scroll inside the card, without mode tabs,
JSON tree controls or collection paging. The header shows call/failure counts and available duration.
Its copy button copies the complete tool block—arguments/Script, original result text and recorded
result details—like other tool cards. Images and recorded full-output files use the existing viewers.
The shared call view requires no custom presentation profile and preserves the configured tool/activity
display preferences.

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
- `body` selects a string from the bounded message preview and renders it as sanitized Markdown.
- Paths select `content` or `details.<key>` with safe dot-separated keys.
- Optional `requireAbsent` paths must be absent. Any present value, including null or false, restores
  generic rendering. Use guards when a selected title would omit provenance or trust qualifications.

Only string-content messages use this projection. Missing declarations, incompatible fields, and
text/image/unknown-block arrays retain the readable generic presentation. Customized Details lazily
shows `customType`, `content`, and `details` from the same bounded preview. Copy reads the saved
message on demand to include its complete original content and details. Presentation does not change
Pi's message or model context.

`customMessages` is optional in version-1 profiles.

Declarations select data; they cannot execute code, inject HTML/CSS, or access the filesystem/network. For commands, widgets, or dedicated GUI controls, see [Extension adaptation](extensions.md).
