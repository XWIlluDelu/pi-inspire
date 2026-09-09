# Spec abstract

## Design map

| Area | Spec | Design |
|---|---|---|
| Product shell | [[workbench]], [[workspace-layout]], [[interface-preferences]] | A three-region workbench keeps collapsible, curated project navigation at the left — globally pinned sessions, pinned folders, and a reversible Hidden group — conversation dominant in the center, and contextual work available on demand at the right. |
| Project terminal | [[terminal]] | An independent local daemon owns ordered project-scoped PTYs while paired browsers provide detachable xterm views with one explicit writer, exact reconnect, and no terminal splits. |
| Resource preview | [[resource-preview]] | Transcript references and workspace-indexed files open in a session-bound, defensive preview surface rather than an unrestricted browser file client. |
| Visual language | [[visual-language]] | An original scientific-workbench character: reference grammar without reference identity, Amber/Jade palettes tuned independently per light/dark theme plus semantic annotation hues, one type voice per role. |
| Design tokens & components | [[design-system]] | The concrete contract — palette roles per theme, type scale, spacing, radii, elevation, motion, and per-component anatomy — that `src/styles.css` implements. |
| Conversation | [[conversation]], [[activity-presentation]] | Compact user bubbles alternate with assistant answers presented as an open document flow containing typed Pi text and activity blocks. |
| Rich content | [[rich-rendering]] | One defensive Markdown pipeline owns both settled and streaming text, including mathematical notation. |
| Activity presentation | [[tool-presentations]] | Validated local declarations project known Pi calls and optional Thinking text into bounded summaries and typed Web blocks while their native card shells remain fixed. |
| Session continuity | [[session-continuity]] | Pi’s JSONL remains canonical; [[session-persistence]], [[session-transport]], [[session-branches]], and [[session-deletion]] detail the independent ownership boundaries. |
| Pi integration | [[pi-integration]], [[host-lifecycle]] | A trusted loopback host adapts Pi RPC into a typed browser interface and presents supported Extension dialogs and text widgets natively without coupling the product to particular Extensions. |
| Connectivity | [[connection-modules]] | Detachable local connection modules add ingress paths to the same loopback host without becoming Pi or browser-state authority. |
| Input | [[composer]] | One composer accepts text, project-file references, images, files, steering messages, and follow-ups. |

## Implemented capability

Markdown and Notebook previews now render authorized local images inline, resolve links from the document directory, navigate heading fragments, and display cell-local Notebook attachments. [[document-relative-previews]] records the shared-renderer repair, bounded image ownership, preserved security restrictions, and Node 22 / Chromium evidence.

Projection reads, ownership witnesses, and baseline commits now share one FIFO. Complete same-object bytes can survive metadata-only movement only after full revalidation; stale results cannot consume current claims or revive a writer. [[projection-reconciliation-ownership]] records the content-equivalence boundary, preserved startup/partial/replacement checks, and Node 22 / real-Pi / Chromium evidence.

Observation deadlines no longer terminate healthy Pi mutations; prompt receipts preserve one operation, worker retirement requires exit evidence, terminal retries retain owner-side identities, and maintenance restarts consume current owner authority. [[operation-lifecycle-ownership]] records all five repairs, real Pi slow-compaction and browser recovery evidence, and the explicit terminal-service protocol upgrade boundary.

Compaction and retry presentation now follow authoritative session state independently of commands or observed start events; retry details restore from Host snapshots, and update requests no longer overwrite Host checking state. [[state-authority-review]] records four repairs, other inspected boundaries, and verification limits.

PWA title-bar metadata follows light/dark mode with palette-independent neutral colors; installed icons use a fixed carbon/silver/white mark. [[neutral-pwa-chrome]] records the checks and browser/OS update limits.

Named tool cards appear before argument completion and stream bounded, redacted previews through coalesced patches, with truthful execution/interruption states and snapshot continuation. [[streaming-tool-arguments]] records limits, linear-path traffic measurements, and the final Pi 0.85.1 / Node 22 / Chromium verification.

[[simplification-review]] records removal of obsolete adapters/benchmarks, explicit deletion validation, terminal spawn cleanup, separated Host socket ownership, responsibility-scoped store tests and contracts, and StrictMode focus restoration. Its isolated Node 22 and Chromium verification excludes the concurrently developed tool-argument streaming slice.

The New session directory picker has a default-off Show hidden folders eye-icon toggle beside its heading, with Host-owned dot-name and Windows/macOS hidden-attribute filtering. [[hidden-project-directories]] records behavior and verification limits.

Resource reads are independently session-addressed across browsers, and terminal catalog writebacks are project-generation-bound. Preview content reuses the short-lived workspace index while retaining per-request path/object checks; Windows VS Code file URIs use native path conversion. [[review-resource-terminal-ownership]] records the review repairs, cache tradeoff, and verification limits.

Shared image previews center the fitted image with a nearby upper-right close button and theme-aware background controls directly below; the standard modal scrim remains separate from a neutral transparency checkerboard and viewer-local White/Black alternatives. [[image-preview-backgrounds]] records the rationale and regression evidence.

Displayed custom messages are independently readable, information-blue extension context with Markdown and optional Details, outside tool activity folds. PI error retains its existing presentation. [[custom-message-presentation]] records the projection boundary and verification scope.

Pi reply errors are visible at the failed message, including empty replies, retained partial output, and expandable/copyable details restored from Pi history. [[follow-pi-error-display-2026-09-06]] records implementation evidence and deployment scope.

## Cross-spec direction

The product separates durable Pi state, a safe browser projection, and transient live events. The local host is the only privileged boundary and the browser remains replaceable: refreshing or reconnecting reconstructs the visible state from Pi’s session records and current runtime rather than from browser-local conversation authority.

The local baseline defines the complete daily-use conversation slice inside the adaptable workbench frame: session discovery and continuation, independent background runtimes, bounded history and Pi branch actions, defensive rich rendering, complete composer input, typed activity cards, extension dialogs, essential runtime controls, curated navigation, Git-aware project and Changes inspection, session-bound file previews, and keyboard-accelerated visible actions. Later subagents, timelines, and richer artifact surfaces extend that frame rather than complete a missing local conversation loop.

Optional connection modules preserve this same browser projection and operation semantics while adding independently managed ingress paths to the selected loopback host. Pi state and privileged capability remain on that host; a module neither becomes conversation authority nor controls the trusted client artifact. The dedicated terminal data plane traverses that same paired HTTPS/WebSocket ingress, but its daemon and PTYs remain independent of the Host, browser, and connection-module lifecycle. Generic proxy handling may harden forwarded HTTPS requests only when direct loopback behavior remains unchanged.

The front end uses one coherent light-and-dark component system at medium information density. IBM Plex Sans SC owns the interface, Chinese/Latin reading flow, and uppercase `INSΠRE` wordmark; Flux Mono SC v0.1.0 owns code and machine-oriented data on a native 600/1200 CJK grid. Neutral paper surfaces, an Amber default or Jade alternative palette tuned independently per theme, a small semantic annotation palette, fine boundaries, soft radii, and performance-safe state motion keep content dominant.
