---
purpose: Lightweight model configuration and provider authentication using Pi's native settings, models, and credential storage.
covers:
  - server/{model-settings*,model-catalog*,model-metadata*,session-model-selection,session-projection,provider-auth*,app,index,runtime,runtime-worker-lifecycle}.ts
  - server/extensions/{inspire-branch-bridge,provider-auth-bridge}.ts
  - server/configuration-file.ts
  - shared/{contracts,commands,model-settings,provider-auth-bridge}.ts
  - src/{App,api,app-state,store,model-options,use-modal-focus,use-configuration-document}.ts*
  - src/components/{Settings,SettingsControls,SettingsSection,ModelsSettings,ModelDeclarationForms,ConfigurationForm,ProviderAuthentication,ModelSelector,ModelList,Composer,Welcome,CommandPalette,CommandHelp}.tsx
  - src/styles/model-settings.css
  - tests/server/{model-settings,model-catalog,model-metadata.integration,model-workflow.integration,provider-auth,provider-auth-bridge.integration}.test.ts
  - tests/server/configuration-file.test.ts
  - tests/integration/{model-cycle-native,model-thinking.integration}.test.ts
  - tests/web/{configuration-document,model-store,model-selector,modal-focus,provider-authentication,welcome-model-transition}.test.ts*
  - tests/browser/{model-selection,model-settings*,model-workflow,provider-authentication}.spec.ts
progress: in-progress
area: "Input & Models"
---

# Model settings and authentication

## Goal

Settings manages Pi's startup defaults, common-model scope, `models.json` declarations and saved
credentials. The session picker changes the current selection. Both use Pi's available models;
configuration editing and login remain independent.

The picker opens cached choices immediately and refreshes them without a separate progress row.
Initial discovery with no choices shows a concise loading state; a failed refresh stays visible
without discarding usable choices. Provider lists also keep loaded content during a background
refresh. New-session preparation is expressed through the model/start controls, without narrating
directory checks and model resolution. Blocking errors and required choices keep local guidance.

The session displays Pi's confirmed thinking level and runtime delivery settings. A pending write
has separate progress; a failed or retired request cannot restore an earlier value over a newer
confirmation.

## Interface

| Section | Controls |
| --- | --- |
| Models | Searchable rows with Common, Default and declaration actions. Clear removes the saved default. “Model default” clears explicit thinking. |
| Login & API keys | Saved credentials and Connect provider, followed by method selection and login. |
| Custom providers | Collapsed declarations with counts, Add provider and actions on the selected declaration. |

The picker and Settings share one virtualized list. Search, Up/Down and Home/End reach the full
filtered results. In Settings, Enter or a click selects a model for inspection, and the detail
controls have their own tab stops.

Display names lead, followed by the model ID. Provider-group captions omit the repeated provider,
while Common shows provider/ID. The list shows a checkmark and `aria-selected` for the current
choice. Full-identity tooltips remain available. Search emphasizes original-text
matches using the existing locale-folded literal-first/greedy-subsequence rule, including queries
spanning provider/ID, without changing row capacity, ordering or badges.

The picker's Manage models action keeps its session owner, or New's prospective directory.
Opening Settings directly from New uses that same directory. Provider navigation preserves its
query on Back and returns to saved providers after login.

## Defaults, common models and selection

Settings edits global Pi preferences and displays effective project overrides alongside them. Saved
identities and patterns remain visible when unavailable. A failed read has its own error state,
scoped to its file: an unreadable project settings file reports that its overrides are unavailable
but does not disable editing the separate global preferences. Global reads/writes
still require a valid global file and preserve the project file.

Common choices use Pi's ordered model-cycle patterns. Exact entries, including thinking-effort
suffixes, toggle directly. Rule-covered rows show a separate “Via rule” edit action instead of a
checkbox, including when an exact entry also matches. Its tooltip attributes the source rules; the
action opens the existing rule editor, where the pattern remains explicit. Editing keeps pattern
syntax, order, unmatched entries and unrelated settings. Common matches appear first
in the picker; without a configured common scope, the picker has no Common group.

Model cycling must preserve a single native cycle's cached scope, effort defaults and extension-event
order. Forward cycling uses the owning worker's RPC `cycle_model` and rereads the effective
selection. Previous model reports that backward cycling is unavailable and preserves selection.
The model picker remains usable. [[pi-capability-gaps]] tracks the missing native operation.
Thinking selection and cycling retain their native semantics. Startup-default edits leave the
current session's model and effort intact.

Gestures execute in order within their session/transport owner and respect editors, menus, modals
and IME. macOS uses Control+Command+M/P/R; other browser platforms use Alt+Shift+M/P/R only when the
layout actually produces that letter. Physical key codes never turn Option/AltGraph characters or
dead keys into model actions. Palette and keyboard-help hints share the same binding source.

Pi's selected identity can differ from the physical responder. Selection controls and New inheritance
use the selected identity; response metadata and usage describe the actual response. Virtual models show
Router in the existing model list. A physical response does not replace the selected router.

Live selection comes from the owning Pi, including after branch navigation. A taken-over Pi
supplies its own available catalog and selection through attach-control. Model and
thinking setters return actual state, including native adjustment and extension changes, without a
second setter overriding that decision or changing saved defaults. Native model cycling stays in the
original terminal; explicit selection and supported thinking-cycle gestures use the GUI controls.
Controls require advertised support, not merely an external owner or idle status. Unsupported controls
cannot disable the separate configuration/credential surfaces. For inactive sessions,
selection follows the viewed branch and Pi's recovery rules with current registration metadata.
File-backed transcripts open independently of model discovery. New from unavailable-workspace
history keeps known selection/effort but discovers choices in the prospective directory, not through
the read-only source. Choosing manual effort retires an in-flight thinking preview; directory changes
preserve that choice without leaving model readiness pending.

Native settings and trust reads run in the model metadata process. The model picker resolves
common choices with its catalog read, so session snapshots do not wait for Pi's settings lock.

A model-only change must preserve a manually selected current-session effort when the target
supports it, clamping only unsupported levels. This requires one owning-worker operation that applies
the effort intent before model-select hooks. [[pi-capability-gaps]] tracks the missing public Pi
interface. Until it exists, live selection keeps native default resolution instead of overriding
extension decisions with a second thinking setter.

Pi 1.4.0 cold startup follows configured defaults when the reconstructed context has no messages,
even if the file contains model/thinking records. Inspire leaves that decision to Pi: no preference
copy, synthetic messages or forced restoration arguments.

## New-session discovery

New distinguishes explicit selection, inheritance from a session and workspace defaults. Explicit or
inherited choices keep their resolved thinking value; manual thinking changes take precedence.
Workspace-default startup leaves model and unmodified thinking arguments to Pi. Once thinking is
chosen manually, model switches preserve that effort when supported and clamp it otherwise, without
reapplying defaults. Until a manual choice, switches use Pi's per-model thinking preference, then
global preference, then current effort, with supported-level clamping. Catalog refresh alone does not
reapply defaults; non-reasoning models disable thinking. If a chosen model's thinking cannot be
previewed before explicit new-folder creation, unmodified effort is left to native startup, not
guessed; a manual effort choice remains explicit.

One catalog inspection returns available choices, startup defaults and effective thinking
preferences for the prospective cwd. Model selection uses that inspection's preferences.
It includes global and already-trusted project extension registrations, using Pi's stored/inherited
trust and global default trust rule. A saved project or inherited refusal takes precedence even
when the directory has no trust-requiring resources. Metadata reads never change that decision.
Skipped project resources and individual extension-load failures produce warnings while keeping
the models Pi can load. Invalid model configuration and persistent metadata-query failures produce
local errors. Fresh trust decisions remain part of Pi startup.

Discovery registers extension providers through Pi's service factory before building one in-memory
session for commands and defaults. Validation uses a disposable in-memory session to register
providers without waiting for credential availability.
The short-lived SDK process writes no session file, emits no session-start event and makes no
agent/model request.
Refresh replaces an older preview while preserving explicit or inherited choices. The directory
check and model picker share one catalog read, which includes unresolved inheritance from the same
workspace. A source in a different workspace can resolve separately. Reads use bounded automatic
recovery for transient failure and stay bound to their directory, source and browser connection.

An unverified or known-invalid directory keeps Start unavailable until a successful check; an inherited
or explicit model cannot bypass that check. A failed observation keeps a known missing/invalid
path classified as such. Optional refresh of the same confirmed directory keeps its model,
effort and readiness; changing directory or transport requires fresh validation. Persistent failure
keeps staged work and local recovery. Process lifetime, shared queries and cache invalidation are
described in [[state-ownership]].

## Provider and model configuration

Create or choose a provider, then add its models. Provider fields cover identity, endpoint, API type
and optional model-file credentials. Model fields start with ID and display name, then capabilities
and limits. A model without an inherited API exposes its required API field; inherited APIs and
optional endpoint overrides stay compact. Custom API types are accepted.

Forms keep untouched providers, model metadata, overrides and advanced fields under Pi's schema.
Editable declaration fields share their patch schema and control metadata. API keys use explicit
keep, replace and remove edits. The provider snapshot exposes only whether a key exists.
Removing a declaration affects `models.json`, independently of built-in catalog entries and saved
login credentials. Configured declarations and saved preferences remain editable when model discovery
is unavailable; Settings reports the availability failure separately from file errors.

Provider and model forms open inside Models with the browsing view still mounted. The header
identifies the edit target. The shared model/MCP form keeps Save and Cancel reachable while the body
scrolls. [[design-system]] defines scrolling in short windows. Errors stay in the form.

Select a custom provider or model by identity to see its declaration actions. Models and MCP
share the editor's document, selection, draft and async ownership rules. Switching categories
retains drafts, search and loaded data. Changing the session, prospective directory or Host
connection retires file drafts and their pending responses. Hidden forms wait to take focus or scroll. Back and Cancel
discard the draft and restore the browsing context and originating control. Creating a provider
focuses Add model. Creating or renaming an available model selects the saved identity for
inspection. Common and Default writes leave focus under the user's control.

Candidate declarations are validated in the existing isolated metadata worker against the same
agent directory, selected working directory and project-trust policy as Pi. Extension provider
registration precedes validation so legal inherited API/endpoint declarations remain valid, including
when editing an unrelated provider. Unrelated extension-load failures do not veto valid declarations;
Pi still validates the complete candidate against the providers that loaded. Validation starts no
model turn or persistent session and keeps factory errors and credentials out of responses. Publish
only after revision and atomic-publication checks.

Model and MCP editors use the same native-file transaction and revision of the resolved target and
exact source text. Writes accept native syntax and use native-compatible locks and atomic
restrictive-mode replacement. Regular files lock their target. Final symlinks lock the lexical
path and target. Publication rechecks both the target and the reviewed revision. After publication, the editor retries a failed readback before reporting that
the save succeeded and the settings could not be refreshed.

A configuration save invalidates cached workspace metadata. For an addressed session, it refreshes
that worker only; other workspaces rediscover on demand. Without a session, it refreshes the edited
workspace catalog. Refresh preserves ongoing work and the current selection. The explicit Refresh
control rereads external changes while Settings remains open. Earlier catalog/settings reads cannot
replace a newer published write snapshot in the picker or Common scope, including its error state.
Opening Models and its Refresh action each request the native catalog and file configuration in
one read. A discovery failure keeps the last picker and Common choices, reports the problem, and
keeps file edits available. A committed save retires older reads even if its readback fails.

## Authentication

Connected and available providers share rows. The selected provider shows authentication methods,
credential removal and method-specific remote login instructions.

Provider methods come from the installed Pi, including native and extension API-key/OAuth flows.
`/login` opens provider selection and may reveal an unambiguous provider's methods; authorization
starts only after selecting a method. Loading, errors and empty results are separate states.
Provider discovery and login admission reread saved declarations without requiring a Host restart,
including when no session is selected.

Provider search matches case-insensitive substrings in IDs and names. Show an ID as secondary text
when it alone matches; emphasize matches without repeating identical labels. Returning from methods
preserves query and focus. Long login captions wrap without squeezing status or obscuring prompts.

Login operates on the connected Host's Pi credentials. Switching Settings categories leaves the
attempt running and preserves entered responses. The browser displays native links, codes,
prompts and outcomes. One status position shows the latest native progress message while pending,
falling back to a concise login status; the settled outcome replaces progress in that position. Authorization links, codes and prompts remain available. Supported methods
offer Remote login help on demand, following the selected method's device-code, pasted-code or
redirect interaction.

Attempts keep their originating worker. Cancellation or supersession prevents an older attempt
from replacing a newer credential choice. Status-read failures and failed cancellation both resume
observation. Once an attempt settles, its outcome supersedes earlier request errors;
late answer, cancellation or status responses cannot replace it or add stale errors. The Host briefly
keeps settled outcomes so clients can recover a lost final response.

Stored or resolved keys/tokens are omitted from ordinary model/status payloads and logs. Logout removes
Pi's saved credential; environment and `models.json` credentials are managed separately.

## Related contracts

[[interface-preferences]], [[composer]], [[pi-integration]].
