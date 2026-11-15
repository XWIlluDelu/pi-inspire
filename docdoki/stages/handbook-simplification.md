---
scope:
  - src/**
  - server/**
  - shared/**
  - extensions/**
  - scripts/**
  - tests/**
---

# Handbook simplification

## Objective

Implement the [simplification handbook](https://chatgpt.com/space/page_0b1050404f0c8191b1a18d9d168e6141)
while retaining native Pi files, active configuration and the observable behavior specified by the
project. The main plan estimates 64,335–90,055 net source lines including test replacements.
Measure the implementation against `3e123767` using the handbook's source inventory. The optional
attachment-retention and PDF experiments are outside the main plan.

## Current state

The measured inventory is 203,143 source lines. The cleanup and interaction restoration
together remove 48,798 lines (19.4%) from the handbook baseline, including
16,695 application and style lines and 32,103 test lines. The inventory counts
tracked TypeScript, JavaScript and CSS across the repository and excludes generated font styles.
Existing menu and tab choices retained by the user stay in place. Background receipt checks keep
the editor available for the next message. The 60,000-line figure is a progress reference.

- Saved-session queries share the JSONL reader and bounded history transport. Fork and Clone use
  Pi's native branch operation in a thread over a verified prefix. Resource transfers open the
  authorized logical path and validate range versions. HTML keeps the captured document and uses
  the same resource authority.
- Conversation history scrolls continuously, with Prompt Map as an in-conversation navigator.
  The restored right-side History tab inspects saved routes, searches all branches, and exposes
  native point previews and branch actions through the same view-addressed history transport.
  The title menu and `/tree` keep their quick branch picker. Live and saved History share the
  Shell card and keep structured log references separate from stdout.
- Opening an ordinary browser conversation warms Pi in the background to load extension controls
  before first input. Read-only route inspection can observe an external owner. Native writer
  admission still checks ownership before an action can write.
- Thinking level and per-session runtime settings keep confirmed values separate from pending
  writes. Deletion applies the committed result once and keeps confirmed navigation metadata
  when cleanup fails.
- The workspace tab strip scrolls and offers one searchable list for files and terminals. The
  old width-based hide/show registry and mutation observer are gone. The dock renders terminal
  tab descriptors directly; terminal output and control lifetimes stay with their existing owner.
  File and terminal actions float over the content. The dock uses one current navigation
  record and keeps current-schema reading positions without translating retired Git-side offsets.
- The start and session editors render their stored text directly. Input history copies text and
  artifacts on explicit selection. Editor height follows CSS instead of measuring the textarea or
  portalling the size button. Provider and extension prompts share form controls.
- Ordinary settings and Thinking choices use native selects. Extension controls and tab search
  keep their own compound panels. Models Settings reuses the virtualized model option list and
  renders actions once for the inspected model.
- All, Needs you and Hidden use one catalog and scrollport. Search and keyboard traversal use the
  same section order. Settings, palette, export and help share one inspection state. The main
  and terminal settings use the same category navigation. A native extension question takes
  focus and suspends an open editor.
- Update probes share a cache owner. Live and saved views share snapshot assembly without
  retaining transcript snapshots in slot metadata. Each socket owns its subscription state, and
  each Pi dialog owns its process and deadline. Deletion reservations share a registry. A lost prompt response
  triggers a bounded read of its original Host receipt. An unchanged retry observes the same
  receipt without sending the prompt again. Composer keeps in-flight, uncertain and recoverable
  prompt states under one operation identity. Terminal data and maintenance share one
  wire version. Current credentials, Herdr scopes and attach-control entry paths are in use.
- The owned Pi bridge publishes bounded native checkpoints. The disk reader verifies the file
  independently, including appends from a second Pi. Live adopts finalized native entries from
  checkpoints, preserves unconfirmed output and no longer claims authorship from file appends.
  Reconnecting sockets replay only events newer than their runtime snapshot cut.
- The notification service receives settled outcomes from the runtime and attached receiver,
  without reconstructing runs from browser events.
- The last-opened hint supplies a fresh browser's starting address. It no longer controls worker
  retention, addressed reads or another browser's completion and failure indicators.
- A Live replacement delivers the bounded rows, branch and persistence diagnostics together.
  Join replays only events after the snapshot cut, including cuts within a token batch. A stale
  HTTP observation and sequence from an earlier Host cannot displace the current view.
- Prompt, Stop and Return use one Host operation receipt with typed inputs and matched executor,
  command and ID. Stop/Return retries observe only; retirement stays unknown and concurrent
  confirmation restores the result once.
- `inspire pi` runs the native Pi terminal with its public SDK and returns the individual queue
  disposition for remote Steer and Follow up. A regular terminal Pi does not return that
  disposition from the extension API; the browser and Host refuse busy input before dispatch.
- The Host publishes and serves only the current asset manifest. Browser build mismatch blocks
  requests and subscriptions; an open draft remains visible for manual reload. The previous
  asset cache, retired palette/menu identifiers and redundant literal checks were removed.
- Tool, Thinking, custom-message and checkpoint presentation use one generation. Live and
  History load the same deferred Markdown reader. Checkpoint and tool cards share disclosure
  and copy controls, and tool results share the lazy details and raw fallback readers.
- Model discovery resolves extension registrations before constructing its one in-memory preview.
  Validation keeps native provider registration independent of credential availability.
- HTTP bootstrap provides configuration, authority and an address. The addressed subscription
  supplies the only initial transcript projection, then releases events after its sequence cut.
  The snapshot digest and unchanged acknowledgement were removed. A missing addressed session
  settles to an empty view on the same socket, while other read failures retain the current view.
- Terminal controls persist a validated intent and receive the shared operation envelope from a
  single endpoint. The daemon epoch still owns receipt recovery. A retired browser build releases
  its terminal attachment without stopping the process. Browser-issued Host restart uses the same
  receipt shape; only observation of the replacement Host settles restart completion.
- Ordinary JSON requests use shared input schemas, methods, addresses and observation policy.
  History Watch joins Switch and Edit at one navigation endpoint. Native pages, entry reads,
  saved Composer input, copy and images share one cancellable view scope. The selected run state
  is derived from the Host's per-session status instead of being stored and inferred twice.
- The terminal daemon uses the same typed intents as the browser. Receipt observation cannot admit
  a missing operation. File and terminal tabs share a strip and search list. The file view and Git
  diff keep the same toolbar during a change of body. Files, notebook and Markdown share syntax
  rendering. Model and MCP settings share their file transaction and browser write fences.
- Welcome and Composer share one draft, and a tab reload restores the original prompt receipt ID
  for observation. Pending UI and Stop keep their native execution owner. Provider credentials
  and extension questions use the same prompt fields while their native attempts remain separate.
- Confirmed preferences carry the Host's publication order. Pending curation blocks destructive
  review. Individual and bulk deletion share one command and return the exact committed subset
  with a stamped navigation outcome. The restart runner and systemd entry points share the
  incarnation-bound plan and process-exit checks.
- Tests supply real bootstrap metadata and explicitly deliver joined snapshots. Injected Host
  fixtures use the same catalog and attachment store as their runtime. Replaced reader, transport
  and deletion tests retain the native and browser failure cases at their owning layer.

- Live activity uses one disclosure and bounded Earlier/Later pages. The Host publishes the turn
  owner during streaming and native checkpoint adoption. The browser keeps deliberate tool
  reading choices by native call ID and removes timestamp-based fold aliases and scroll
  compensation. The native History reader shares cancellation and retry for page, search,
  route and entry reads.
- Every HTTP and WebSocket detail snapshot is addressed. The last-opened hint selects only a
  fresh tab's starting address. Snapshots carry their runtime cut directly. Git keeps one status
  read and one selected diff read. File and terminal tabs, search fields, candidate lists, and
  code/diff readers share rendering and navigation within their respective surfaces.
- Welcome reads model choices and thinking defaults from one native catalog query. Model
  Settings opening, refresh and post-authentication reuse one configuration read. Model and
  MCP file recipes and forms share field definitions and protected-value edits.
- Settings and the palette share the overlapping preference choices. Pi native command metadata
  names its browser destinations and execution requirements. Confirmed command activity owns
  its running and settled results. Prompt reload retains its original content fingerprint and
  observes the original receipt without storing an executable request.
- Replacement test fixtures exercise actual addressed Host selection, model/MCP routes, current
  signed instance readiness, systemd submission, and real launcher shutdown. Shared fixture
  setup supplies only the file, process or browser behavior relevant to the case.
- Settings and its nested confirmations, the palette, export, extension questions and the
  narrow drawer use native modal dialogs. Anchored pickers remain within their owner. Shared
  resource tests use actual HTTP responses and file descriptors for image, download, HTML,
  range and revocation cases.
- Catalog paging and refresh publish through one chronological read. Curation and live rows
  join it without advancing the cursor. History, resource and catalog reads reuse the same
  scope and check ownership before publishing. Addressed snapshots carry one per-session status
  map. Prompt, Pending and restart reuse the in-flight receipt read lifecycle. Terminal
  joins a single daemon receipt promise per intent.
- The workbench, topbar and transcript use a common toolbar and disclosure layout. Narrow
  screens reach the same project, comparison, tab and terminal actions directly. The terminal
  browser tests use real PTYs and Host tickets, with faults injected at the receipt or parser
  boundary. A single native History journey covers pinned paging, search, restoration and
  independence from Live.
- The shared message editor owns both Welcome and the active conversation's text, file picker,
  paste, drop and submission controls. The Welcome model choice retains its source and observes
  directory defaults through one bounded read. Native and browser tests exercise the actual first
  send, model defaults, mixed files and images, and upload completion across navigation.
- The workspace dock renders the tab row and persistent terminal toolbar directly. The same PTY
  survives switching between Files and Terminal or opening a focused window. The palette and
  title menu use the same session actions and rename dialog. Earlier-branch recovery uses the
  normal layout above the Live scrollport.
- Live and reconnect consume the Host's same bounded tool activity records. The browser no
  longer rebuilds tool execution, queue and child calls from native events. Tool output, raw
  arguments and custom diagnostics share the bounded code reader and disclosure. Native Pending
  and model cases use actual authenticated HTTP, Pi and queue evidence instead of replaying them
  through a second test runtime.
- A checkpoint can extend the native cursor while Live still displays its transient rows. A
  seal advances the visible leaf and replaces matching rows together. Before a model call,
  the bridge seals saved input so its Fork action is available while the reply streams.
  Settings and Terminal Settings share their scrollable layout, and action dialogs reuse
  the same title and action rows.

## Latest replacements

- New and reopened native workers use one spawn configuration. New, Fork and Clone share
  destination admission checks, and native writes carry the specific Pi worker they admitted.
  Deferred input uses the same worker and navigation checks at drain and delivery. Pool
  reclamation shares work checks and projection cleanup.
- Prompt, Pending, terminal controls and Host restart share in-flight receipt observation.
  Pending can still accept the first confirmed handoff from the original POST or a later
  read. Terminal recovery keeps the original daemon admission epoch and intent.
- Launcher and systemd adapters share restart submission results. Browser and scheduled
  restart share the rule that releases admission only after proven non-issuance. Terminal
  daemon startup and service restart share readiness polling. CLI shutdown still needs the
  signed cleanup result, actual exit and the launcher lock before replacing the Host.
- Overlapping tests for new-worker loss, restart admission, confirmed prompt delivery and
  malformed restart tracking were consolidated into their owning suites. Tests, builds and
  type checks were skipped for this batch.

- Models derive saved projections and edit schemas from one declaration field list. MCP
  shares record reads across inspection, protected connection reads and inherited policy,
  and publishes additions, edits and removals with the same patch operation. Preferences
  and known project directories share locked JSON publication. Native Pi files retain their
  native lock protocol. Tests, builds and type checks were skipped for this batch.

- Host input and terminal operations share HTTP observation and receipt identity checks. The terminal
  adapter retains daemon epoch recovery and the Host restart adapter retains replacement-Host
  confirmation. Terminal replay validates continuation and output offsets through the same code path.
- New and reopened Pi workers share startup and readiness handling. Retirement detaches pending
  images and clears presentation through the same routines, with queue retirement kept in its
  existing lifecycle phase. Model, Thinking and runtime settings share browser ownership checks.
- Terminal menu actions use the existing dock dispatcher with their original disclosures and
  triggers. Existing session curation controls, terminal keyboard behavior and focus coverage were
  retained. Repeated tests were consolidated while keeping native Pi and PTY fault cases. Tests,
  builds and type checks were skipped for this batch.


- Host input routes share receipt admission and publication. Pending Return, Clear and writer
  retirement share removal of held input; Return uses the same order as the visible queue.
- Terminal shortcuts and palette actions use the same dock dispatcher and the active terminal
  channel owns takeover. Saved output settings serialize updates and clears through one action
  state. MCP, terminal and modal browser coverage keeps the ownership and native boundaries
  while dropping repeated configuration and layout flows. The extension status always opens its
  scoped reader and no longer measures overflow; extensions and command receipts share the dock
  layout. No tests, builds or type checks were run.

- Prompt acceptance no longer scans the saved transcript for a recent row matching text and
  attachment bytes. The native saved-history reader owns saved text and original artifacts;
  recent text-only inputs come from their delivery records. Prompt, Stop and Return use one Host
  receipt table; daemon expiry and epoch rotation remain with the terminal executor.
- Pending summaries and copy use one ordered native/Host item iterator and one item coordinate.
  Copy still requires its matching view and revision and reads original authorized images.
- Terminal actions use one menu and the touch toolbar uses native horizontal scrolling with
  fixed arrow keys. Tab movement uses the menu and keyboard. Terminal restart reuses the
  launcher's readiness and checks the replacement's process identity once. Tool details keep one order
  throughout execution and settlement. Settings uses one palette select and common controls.
- Occupancy opens the same Session & usage readout as the palette and `/session`. Loading
  uses one reduced-motion-aware glyph; tab completion stays in its session. Browser coverage
  drops duplicate layout, clipboard, receipt and fixture cases. No tests, builds or type
  checks were run for this batch.

- The worker publishes its native startup leaf after the admitted prefix check. Independent
  JSONL appends advance the saved document during startup. Live exposes a saved-position
  address for branch restoration. Branch commands share the worker status listener and RPC
  command framing. Stop and Host shutdown use the worker retirement path.
- Browser input frames reach the terminal manager through one attachment channel. Browser
  and daemon commands share the dispatch table, and runtime and terminal sockets share
  liveness, build retirement and drain. Terminal takeover and reconnect share owner transfer.
- Host and daemon receipts share result accounting and wire response construction. Browser
  confirmation binds receipt identity, state and HTTP status. Terminal tombstones still
  rotate the daemon admission epoch before forgetting old identities.
- This batch removes repeated worker retirement, terminal receipt and Pending recovery
  schedules. Native queue, authenticated daemon and real browser lifecycle cases remain.
  Tests, builds and type checks were skipped for this batch.

- Full snapshots and atomic Live replacements use one selected transcript view. The event reducer
  publishes its live slice directly. A readiness event during open needs no second HTTP read
  because the selected WebSocket subscription supplies its own snapshot.
- The saved JSONL reader and worker checkpoints share native entry indexing and view queries.
  Source observation reports file integrity once. Rewrites and replacements retire the saved
  history generation. Worker admission still verifies the native startup prefix.
- Prompt and Pending share receipt admission, observation and retirement with command-scoped payloads.
  Pending Copy uses one ordered image source list. Terminal attachment controls share the current
  schema between the browser gateway and daemon. The daemon-confirmed catalog publishes tab order.
- Models and MCP use the same editing, confirmation and field controls. Their native validation,
  staged changes, protected fields and independent authentication retain their domain owners.
- Conversation activity shares disclosure controls, tool/result rendering and code rows. The
  palette and pickers share option styling. Smaller suites exercise native branching, resource
  lifetime, restart submission, terminal recovery and configuration through their actual owners.
- Stop, Return and Clear share the native queue receipt and image cleanup. The native Pi
  journeys cover prompt admission, shell and compaction lifetimes, and exact Pending recovery.
  One runtime suite injects faults at the worker and persistence boundaries.
- File, branch image, attachment and export reads share body observation. Browser tests drive
  actual file replacement, HTML grant retirement, catalog curation, session actions and export
  retry. Component tests retain ownership and failure cases that require controlled timing.
- Model and MCP tests use the Host configuration endpoints and native record readback. Saving
  common model choices for a cold session reloads the native catalog when its snapshot has
  no resolved choices.
- Command receipts, global notices, update status and pane errors share a feedback layout.
  Settings and the workspace pane also share lazy loading, while each retains its focus scope.
- Native and browser flows carry the shared composer, queued images and normal launcher and
  shutdown cases. Focused tests retain uncertain receipts, later drafts, retired view reads,
  actual process exit and foreign unit checks.
- Saved-session opening and Fork or Clone reserve the destination in one registry. Cleanup and
  deletion read the same reservation by native ID or path. The branch tests share actual file
  transitions while retaining collision, incomplete native replies, Stop and exit faults.
- The workspace dock uses a single tab row and a shared toolbar layout. Markdown, notebooks,
  and PDF use one anchored contents list. File preview uses one publication of authorized body
  bytes and uses the body's reported size when the file changes during a read.
- Raw and formatted tool results share a content renderer. The native checkpoint tests cover
  repeated messages and the unsealed-to-sealed transition in one file and worker progression.
  The Host integration exercises early readiness during open and the atomic socket join.
- Ordinary preferences and terminal settings use shared field controls. Models and MCP share
  scalar field bindings, row collections, details and confirmation controls. Configuration tests
  exercise the existing Host on native session data and keep revision, redaction and ownership
  faults with their owning adapter.
- Attached Pi publishes through the same validated receiver and leaf check for background
  polling and action-time reads. One native test delivers each of Steer and Follow up while the
  active run is held. Replacement receiver and exact Stop cases retain their original authority.
- Restart matches the interruption grant at the Host, HTTP decoder and browser status owner.
  Native configuration reads share a publication scope that retains the addressed editor and
  retires earlier model results after a confirmed write.
- Tool, child-call and custom-message details mount their bodies through the same disclosure.
  User and custom messages resolve saved images by the original part index. Live and saved
  Shell copy uses the same command, context and outcome formatting.
- Owned and attached Pi share prompt artifact resolution, filesystem revalidation, and the
  check that recalled files and images still match the submitted content. Pending admission
  and receipt observation derive the operation identity from the same input fields.
- Model validation checks the staged bytes that will be published and keeps the original
  agent's model store. MCP reads and protected value reveals share document validation and
  check the expected revision before parsing the new content.
- Session actions use the existing anchored placement, dismissal, and focus behavior. The
  palette shares its current-session check across session and native command dispatch.
- Saved history, logical resources and worker lifecycle tests share their native fixtures,
  retaining cursor expiry on source replacement, Range revalidation and failed worker handoff.
- The Pending handoff owns its receipt and draft application. A current transport can apply
  the first matching receipt from the original request or an addressed observation. The
  terminal uses shared search and dialog controls for its PTY text.
- History details carry their action capabilities and body type. Only route lists construct
  route labels. History verifies each cursor once before opening its pinned native branch.
- Shell, compaction and branch summaries share the Stop confirmation deadline. Their native
  completion evidence and exact worker checks remain specific to the interrupted operation.
- Pending browser tests exercise the actual queue, ordered images, Return and Stop. One long
  conversation covers saved reading and the narrow jump to Pending.
- Model and MCP editors use the Settings scrollport at every viewport height. Configuration,
  credentials and Terminal Settings share loading and error feedback.
- Recent, workspace search and Changes share file rows and Git markers. Fork and Clone share
  browser admission and result application while retaining their distinct native commands.
- WebSocket tests reuse one Host for failed joins and open or closing peers, and one socket
  for delayed selection, missing detail and subsequent recovery. A real native Pi workflow
  covers branch dialog delivery and the ensuing saved callback messages in order.
- Command and navigation browser tests exercise the real Pi question, catalog paging,
  delayed selection and attention updates through their normal controls.
- Git status and configuration tests use one native repository fixture for HEAD-to-worktree
  comparison, configuration provenance, unusual paths and isolated process behavior.
- The project file chooser uses the common anchored panel and shares file options and feedback
  with inline completion. Recent rows, their replies and status use the same addressed read owner.
- One real attached Pi journey covers queue refusal, Stop, uncertain delivery, repeated receipt
  reads and transport-copy expiry. Receiver retirement and restart retain distinct fault tests.
- Prompt attachment withdrawal uses its existing draft and operation references. Pending,
  terminal and restart publish from their respective receipt records. One export record
  drives both admission and the dialog's busy state.
- Recent receives one ordered list from the Host. Embedded and filesystem responses share
  byte-range headers and version preconditions. The Files tree has one reveal behavior.
- Restart admission tests exercise the real Host HTTP route. Deletion recovery uses real
  session files through the browser. Terminal transport tests close the same Host used for
  attachment and input while verifying the PTY survives.
- Extension status uses the common anchored panel. Extension widgets, raw methods, tool
  results, child calls and Shell share activity disclosures and content rendering. Files
  compares the current published standing to fence older probes.
- Single images and galleries share the browser inspection owner and preserve the visible
  image on Back. Command completion, palette and dispatch use the same native metadata.
  JSONL export and Clear Pending share the worker delivery fence. Embedded image indexing
  and byte reads use the same bounded traversal.
- The native MCP journey owns credential reveal, transport editing and reload confirmation.
  Tool output checks use the actual browser clipboard and stream alongside focused reducer
  tests. Recipient selection tests exercise concurrent opens without repeating nominal setup.
- Prompt and Pending share the typed HTTP boundary used by other Host JSON operations.
  Pending uses its visible action record to retire stale UI completions. Socket replay retains
  the frame sequence beside its payload and projects lifecycle data before encoding.
- Model, provider and restart settings use the existing browser journeys for their real
  controls and recovery behavior. Pending attachment recovery uses the addressed Host receipt
  journey, and startup rejection cases share one worker lifecycle.
- Activity headings, shell output and extension widgets share reader and action components.
  Composer widgets use one bounded layout across viewport heights. Maintenance restart runs
  through the signed Host path and native runtime lease. Hidden-folder and full-catalog
  deletion run together on real session files. File and terminal navigator browser journeys
  cover delayed search and ordering, and one workbench journey covers preview retirement.
- Source and Changes share a reading viewport. Markdown and file-path actions use the same
  clipboard component. The directory dialog uses a bounded native editor instead of hidden text
  sizing. Browser update checks retire the same record that owns their retry budget.
- Native Files journeys cover Recent recovery, file-manager intent, same-tab source navigation
  and stale scopes. The Host handles directory citations without losing other probe results.
- Stop and Return call one browser API to start or observe their typed Pending intent. Changes
  uses its real browser surface to cover unavailable versus clean status, native file identities,
  and retirement on session switch. Alias and request-admission timing stay in focused Store tests.
- Prompt, terminal and restart recovery use one bounded browser storage codec and keep their own
  receipt schemas. Ordinary session and configuration calls address the shared endpoint registry.
  Terminal controls send one typed intent. Pi runtime settings use one typed entry from the
  browser to the native worker.
- Session action admission is shared by the palette and title menu. Rename and Export use the
  workbench's inspection owner. Main and terminal settings use the same field controls.
- Native Pi tests combine startup, usage, receiver replacement and dialog lifetime with their
  real session workflows. The native Pending workflow copies and returns recalled images and file
  references. Browser scenarios exercise streaming tools, clipboard, saved images, scoped reading,
  Settings interruption and terminal controls. Focused tests retain stale result and retirement faults.
- Main and terminal settings use native selects for ordinary choices. The model chooser uses
  the common anchored panel. The palette, dock and xterm use the same terminal shortcut
  definitions. The ordinary and prepared editors use one command dispatch.
- Saved search and branch copy share a bounded thread runner; a copy thread exits before
  staging cleanup. Linear disk appends retain their published row prefix. Git reads use the
  shared view scope. Browser journeys own the Changed file outcomes, delayed workspace search
  and action order focus; focused checks retain races across distinct read owners.
- Both update sources return the same Host status as bootstrap and socket events. CLI start and
  stop share instance lock acquisition; CLI, browser and maintenance submit the same ordered
  systemd restart command and retain their own proof of completion.
- One read-scope suite owns backoff, definitive authorization errors and cancellation during
  retry. Callers keep their view and source admission tests. The Host endpoint suite checks
  authentication, request validation and private bytes; browser and native workflows own
  successful dispatch and interaction. Transport tests keep the unbounded observation policy
  for Export and History Edit; runtime tests still refuse a file removed during Pi startup.
- Native command metadata supplies palette labels and completion hints. Callers use the typed
  Host route client directly for ordinary JSON requests, and palettes share semantic defaults.
  Browser journeys cover native model identity, terminal reconnect, and narrow Settings
  navigation. Focused tests retain receipt cleanup, stale resource reads and exact Shell output
  ownership.
- File content, downloads and interactive HTML verify the same resource grant. Git, Files,
  Recent and session catalog requests use the typed endpoint boundary. Terminal controls share
  project-owned feedback, and the browser mounts Terminal Settings directly in its native
  dialog. Browser tests keep menu focus, native clipboard, file authority and configuration
  flows while dropping repeated geometry assertions.

- Settings, Context and command help use the same recovery action. Pairing uses the existing
  text field and shares the startup card with Host recovery. Welcome recents and prompt choices
  use the same option styling, and MCP opening and refresh share the addressed request.

- The addressed event and reconnect snapshot use the same admitted extension question, including
  its Host deadline. Retry and compaction backoff publish the Host’s typed state directly.
  Browser scenarios retain prepared-command focus, CodeMode clipboard, and restart observation.

- Settings, Terminal Settings and MCP share a semantic switch button. Terminal font size uses
  the same bounds when restoring saved values and stepping from the dialog.
- Configuration and file browser scenarios exercise the live Host and the user interaction.
  Focused tests own request cancellation, validation, and saved state.
- One browser selection owner tracks open, create, deselect, fork and transport replacement.
  Terminals and model catalog calls use typed endpoints directly, and formatted activity
  and CodeMode share a reader. Terminal and tool browser tests retain transport and clipboard
  behavior, including delayed replies and the exact saved image part.
- Pairing, Host recovery and render recovery share the startup card. Live uses the shared
  notice for returning to the saved branch position.
- Socket replacement, reconnect and stop share stream teardown. Context loading and the
  loaded drawer use the same close control.
- Recent retains projected display rows during refresh. Browser command, theme and dock
  checks cover submitted intent, shipped color roles and terminal identity across Files.
- History entry reads use the same addressed browser route as History navigation. Images use
  the Host's projection-read guard and retain their native source and view checks.

- Session deletion, clearing Hidden, Host restart and preference reset share one confirmation
  dialog. Export and the directory picker reuse its header. Chromium covers errors, stale or
  partial deletion, restart scope, reset cancellation and keyboard navigation.

- Palettes inherit shared foreground, rail and status colors. The titlebar uses the rail
  directly, and conversation search and dock selection checks target their current controls.

- Model Settings writes and catalog reads share one publication generation. File previews share
  HTML lease teardown, Git result notices share their presentation, and Markdown code uses the
  activity header. Repeated browser scenarios were trimmed around those existing owners.
  Keyboard help uses the document’s natural section order and CSS columns on wider screens.
  This pass was left untested at the user’s direction.

- Runtime reads use one slot and reconciliation path for History, copy and lazy resource bodies.
  Resource bodies still check their issuing view and projection revision on either side of
  reconciliation. Attached model selection uses the same receiver check at dispatch and publication.
  The restart work check inspects each runtime slot once.
- Daemon RPC and terminal attachment open through the same current-protocol handshake. Host and
  daemon receipt result eviction share byte accounting. Daemon tombstones still rotate the
  admission epoch before being forgotten.
- Startup and saved-message browser journeys absorb the useful cases from the separate empty-state
  and message-action suites. Browser settings and resource journeys retain native readback,
  interaction and downloads. Shared tests own revision conflicts, retry policy and delayed reads.
  This pass ran no tests, builds or type checks.

- Queued and direct runtime work use the same slot retention. Runtime callers use the existing
  projection coordinator and worker lifecycle directly. Prompt, Stop and Return share the Host
  receipt reader with their own settlement and polling rules. Terminal ownership announcements
  share one payload builder, and the IPC decoder owns socket chunk conversion. MCP reads and
  validation use the same exposure normalization.
- Current browser journeys absorb repeated setup and checks for palette focus, model settings,
  notebook/source navigation, terminal tab switching and receipt recovery. Runtime tests use a
  common isolated Pi fixture. Native Pi delivery, uncertain outcomes and actual terminal
  reconnects retain focused cases. This pass ran no tests, builds or type checks.

## Software versions and saved data

The old browser asset cache, generated-token formats, unscoped Herdr leases, retired layout
translations and old attach-control entry points were removed. Browser, Host and daemon use
their current contracts. An unsupported stored operation can still be shown as unknown and
tracking can be explicitly cleared. The original Pi session and attachment data remain in the
native readers.

## Remaining architecture and test replacement

- Review the remaining runtime queue and reconciliation paths against Pi's distinct native
  scheduling boundaries. Prompt draft recovery, Pending handoff, terminal receipt epochs,
  and CLI process exit retain their executor-specific evidence.
- Review R7's remaining MCP field projection and native query ownership. Complete native
  command invocation and keyboard dispatch through the action inventory. Connect remaining
  tool and extension cards to the shared content renderer and remove redundant styles while
  keeping their existing interactions.
- Reduce the remaining synthetic runtime, lifecycle, operation, configuration and browser test
  matrices to shared contracts and real workflows. Retain distinct Pi, PTY, filesystem and
  browser failure cases.
