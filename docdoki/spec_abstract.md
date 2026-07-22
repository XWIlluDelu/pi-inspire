# Spec abstract

## Design map

| Area | Spec | Design |
|---|---|---|
| Product shell | [[workbench]] | A three-region workbench keeps project and session navigation visible at the left, conversation dominant in the center, and contextual work available on demand at the right. |
| Visual language | [[visual-language]] | Claude Science leads the restrained surface, typography, and finish; OpenAI4S remains a secondary reference for direct local-tool interaction and information organization. |
| Conversation | [[conversation]] | Compact user bubbles alternate with assistant answers presented as an open document flow containing typed Pi text and activity blocks. |
| Rich content | [[rich-rendering]] | One defensive Markdown pipeline owns both settled and streaming text, including mathematical notation. |
| Session continuity | [[session-continuity]] | Pi’s JSONL session tree remains canonical while the browser holds only a reloadable, virtualized projection. |
| Pi integration | [[pi-integration]] | A trusted loopback host adapts Pi RPC into a typed browser interface and presents supported extension dialogs natively. |
| Input | [[composer]] | One composer accepts text, project-file references, images, files, steering messages, and follow-ups. |
| Remote access | [[remote-access]] | A later relay connects the same web interface to a selected machine without storing its Pi state centrally. |

## Cross-spec direction

The product separates durable Pi state, a safe browser projection, and transient live events. The local host is the only privileged boundary and the browser remains replaceable: refreshing or reconnecting reconstructs the visible state from Pi’s session records and current runtime rather than from browser-local conversation authority.

The local release implements the daily-use conversation slice inside the adaptable workbench frame: session discovery and continuation, defensive rich rendering, complete composer input, typed activity cards, extension dialogs, essential runtime controls, and keyboard-accelerated visible actions. Reserved contextual surfaces remain available for later files, changes, branch trees, subagents, timelines, and artifacts.

The front end uses one coherent light-and-dark component system at medium information density. Sans-serif type owns the interface and default reading flow, serif type owns the wordmark and an optional reading style, and monospaced type owns code and machine-oriented data. Neutral surfaces, one restrained primary accent, fine boundaries, soft radii, and performance-safe state motion keep content dominant.
