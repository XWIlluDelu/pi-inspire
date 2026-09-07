# Workbench implementation notes

## Custom message presentation

### Decision

The user approved a neutral, information-blue message surface for displayed Pi custom messages while explicitly retaining the existing PI error surface. The current contract is in [[conversation]] and [[design-system]]. A custom message supplies extension-authored context, without the call/result lifecycle of a tool. Its optional `details` is separate from its Markdown `content`; no details entry is synthesized when that field is absent or null.

The previous tool-style card, custom activity tiles, and automatic tool-density lifecycle were removed. Tool calls and Thinking keep their existing presentation. Custom messages stay outside activity folds even when tool visibility is Hidden. The change does not alter Pi delivery or model-context conversion.

### Projection boundary

- `CustomMessage.tsx` renders Markdown and text/image blocks, preserves inspectable fallback data, and lazily mounts expanded Details.
- `transcript-row-projection.tsx` places custom messages in chronological independent rows. Host-paired entry identities retain the row across live-to-durable timestamp adoption and history prepends; host reconciliation remains unchanged.
- `server/session-projection.ts` treats displayed custom messages as visible boundaries in older-history and user-turn navigation. Merely changing the browser renderer would otherwise leave older custom content hidden in deferred activity ranges. Hidden context-only messages remain invisible.
- Settled custom content participates in All search, but not User or Model scopes. Source/type labels do not claim user or Pi authorship.
