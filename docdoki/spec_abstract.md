# Spec abstract

## Design map

| Area | Spec | Design |
|---|---|---|
| Product shell | [[workbench]] | A three-region workbench keeps collapsible project navigation and globally pinned sessions at the left, conversation dominant in the center, and contextual work available on demand at the right. |
| Resource preview | [[resource-preview]] | Transcript references and workspace-indexed files open in a session-bound, defensive preview surface rather than an unrestricted browser file client. |
| Visual language | [[visual-language]] | An original scientific-workbench character: reference grammar without reference identity, one shared accent tuned per theme plus semantic annotation hues, one type voice per role. |
| Design tokens & components | [[design-system]] | The concrete contract — palette roles per theme, type scale, spacing, radii, elevation, motion, and per-component anatomy — that `src/styles.css` implements. |
| Conversation | [[conversation]] | Compact user bubbles alternate with assistant answers presented as an open document flow containing typed Pi text and activity blocks. |
| Rich content | [[rich-rendering]] | One defensive Markdown pipeline owns both settled and streaming text, including mathematical notation. |
| Session continuity | [[session-continuity]] | Pi’s JSONL session tree remains canonical while the browser holds only a reloadable, virtualized projection. |
| Pi integration | [[pi-integration]] | A trusted loopback host adapts Pi RPC into a typed browser interface and presents supported extension dialogs natively. |
| Input | [[composer]] | One composer accepts text, project-file references, images, files, steering messages, and follow-ups. |
| Remote access | [[remote-access]] | A later relay connects the same web interface to a selected machine without storing its Pi state centrally. |

## Cross-spec direction

The product separates durable Pi state, a safe browser projection, and transient live events. The local host is the only privileged boundary and the browser remains replaceable: refreshing or reconnecting reconstructs the visible state from Pi’s session records and current runtime rather than from browser-local conversation authority.

The local release implements the daily-use conversation slice inside the adaptable workbench frame: session discovery and continuation, defensive rich rendering, complete composer input, typed activity cards, extension dialogs, essential runtime controls, globally pinned and collapsible navigation, session-bound file previews, and keyboard-accelerated visible actions. Other contextual surfaces remain available for later changes, branch trees, subagents, and timelines.

The front end uses one coherent light-and-dark component system at medium information density. Noto Sans SC owns the interface and reading flow, IBM Plex Serif appears only in the italic wordmark, and IBM Plex Mono owns code and machine-oriented data. Neutral paper surfaces, one brand accent (teal, tuned per theme) beside a small semantic annotation palette, fine boundaries, soft radii, and performance-safe state motion keep content dominant.
