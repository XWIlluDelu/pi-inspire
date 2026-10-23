---
purpose: Lightweight model configuration and provider authentication using Pi's native settings, models, and credential storage.
covers:
  - server/{model-settings*,model-catalog*,model-metadata*,session-model-selection,session-projection,provider-auth*,app,index,runtime,runtime-worker-lifecycle}.ts
  - server/extensions/{inspire-branch-bridge,provider-auth-bridge}.ts
  - server/configuration-edit-locks.ts
  - shared/{contracts,commands,model-settings,provider-auth-bridge}.ts
  - src/{App,api,app-state,store,model-options,use-modal-focus}.ts*
  - src/components/{Settings,SettingsControls,SettingsSection,ModelsSettings,ModelDeclarationForms,ProviderAuthentication,ModelSelector,ModelList,Composer,Welcome,CommandPalette,CommandHelp}.tsx
  - src/styles/model-settings.css
  - tests/server/{model-settings,model-catalog,model-metadata.integration,model-workflow.integration,session-model-selection,provider-auth,provider-auth-bridge.integration}.test.ts
  - tests/server/configuration-edit-locks.test.ts
  - tests/integration/model-cycle-native.test.ts
  - tests/web/{model-settings,model-store,model-selector,modal-focus}.test.ts*
  - tests/browser/{model-settings*,model-workflow}.spec.ts
  - tests/browser/fixtures/model-scale.ts
progress: in-progress
---

# Model settings and authentication

## Goal

Manage Pi's model configuration and authentication without replacing native storage, trust or current
session selection. Preserve selected routing identity separately from physical response identity.

Settings manages Pi's startup defaults, common-model scope, `models.json` declarations and saved
credentials. The session picker changes the current selection. Both use Pi's available models;
configuration editing and login remain independent.

## Interface

Models settings separates three tasks:

| Section | Controls |
| --- | --- |
| Models | Searchable available models; Common membership; one Default; saved-default Clear; default thinking; ordered common rules; declared-model editing |
| Login & API keys | Saved credential status and Manage; Connect provider; provider → method → login navigation |
| Custom providers | Collapsed provider/model list with counts, Add and Edit/Remove; connection fields and advanced model declarations |

Common uses independent checkboxes; Default is a single radio choice whose Clear action removes the
saved value. Reselecting Default keeps it selected. “Model default” clears explicit default thinking.
Controls, disclosures and focus styling follow [[design-system]].

Large lists stay reachable through search and keyboard despite virtualization. Up/Down and Home/End
navigate the full filtered results. Default also supports Left/Right and wrapping selection;
Common navigation moves focus without changing membership. Focus waits for an unmounted target row.
Search navigation stays neutral until explicitly used.

Display names lead. Provider-group captions omit the repeated provider, while Common shows
provider/ID. The picker retains its ID line and selected checkmark/`aria-selected`; Settings omits
an identical repeated ID. Full-identity tooltips remain available. Search emphasizes original-text
matches using the existing locale-folded literal-first/greedy-subsequence rule, including queries
spanning provider/ID, without changing row capacity, ordering or badges.

The picker's Manage models action retains its session owner, or New's prospective directory.
Opening Settings directly from New uses that same directory. Provider navigation preserves its
query on Back and returns to saved providers after login.

## Defaults, common models and selection

Settings edits global Pi preferences and displays effective project overrides alongside them. Saved
identities and patterns remain visible when unavailable. A failed read has its own error state.
Read failures retain their file scope: an unreadable project settings file reports that its overrides
are unavailable, but does not disable editing the separate global preferences. Global reads/writes
still require a valid global file and preserve the project file.

Common choices use Pi's ordered model-cycle patterns. Exact entries, including thinking-effort
suffixes, toggle directly. Rule-covered rows show a separate “Via rule” edit action instead of a
checkbox, including when an exact entry also matches. Its tooltip attributes the source rules; the
action opens the existing rule editor, where the pattern remains explicit. Editing
retains pattern syntax, order, unmatched entries and unrelated settings. Common matches appear first
in the picker; without a configured common scope, the picker has no Common group.

Model cycling must preserve a single native cycle's cached scope, effort defaults and extension-event
order. Forward cycling uses the owning worker's RPC `cycle_model`, followed by an effective read;
never replace it with model/effort setters. Pi 1.3.0 RPC and its extension contexts expose no owning
backward-cycle action: Previous model currently reports that limitation and leaves selection unchanged;
the model picker remains available. [[pi-capability-gaps]] retains the backward-cycle requirement;
repeated forward calls cannot reproduce it. Explicit thinking selection and thinking-cycle commands
keep their separate native semantics. Gestures execute in order within their session/transport owner and
respect editors, menus, modals and IME. macOS uses
Control+Command+M/P/R; other browser platforms retain Alt+Shift+M/P/R only when the layout actually
produces that letter. Physical key codes never turn Option/AltGraph characters or dead keys into
model actions. Palette and keyboard-help hints share the same binding source. Startup-default
edits leave the current session model and thinking level unchanged.

Pi's selected identity can differ from the physical responder. Selection controls and New inheritance
use the selected identity; response metadata and usage describe the actual response. Virtual models show
Router in the existing model list. A physical response does not replace the selected router.

Live selection comes from the owning Pi, including after branch navigation. A connected native TUI
supplies its own available catalog and selection through the session-activity receiver. Model and
thinking setters return actual state, including native adjustment and extension changes, without a
second setter overriding that decision or changing saved defaults. Native model cycling stays in the
original terminal; explicit selection and supported thinking-cycle gestures use the GUI controls.
Controls require advertised support, not merely an external owner or idle status. Unsupported controls
cannot disable the separate configuration/credential surfaces. For inactive sessions,
selection follows the viewed branch and Pi's recovery rules with current registration metadata.
File-backed transcripts open independently of model discovery. New from unavailable-workspace
history retains known selection/effort but discovers choices in the prospective directory, not through
the read-only source. Choosing manual effort retires an in-flight thinking preview; directory changes
preserve that choice without leaving model readiness pending.

Pi 1.4.0 cold startup follows configured defaults when the reconstructed context has no messages,
even if the file contains model/thinking records. Inspire leaves that decision to Pi rather than
adding a preference copy, synthetic messages or forced restoration arguments.

## New-session discovery

New distinguishes explicit selection, inheritance from a session and workspace defaults. Explicit or
inherited choices keep their resolved thinking value; manual thinking changes take precedence.
Workspace-default startup leaves model and unmodified thinking arguments to Pi. Model switches use
Pi's per-model thinking preference, then global preference, then current effort, with supported-level
clamping. Catalog refresh alone does not reapply defaults; non-reasoning models disable thinking.
If a chosen model’s thinking cannot be previewed before explicit new-folder creation, unmodified
effort is left to native startup rather than guessed. A manual effort choice remains explicit.

One metadata query returns available choices and startup-default previews for the prospective cwd.
It includes global and already-trusted project extension registrations, using Pi's stored/inherited
trust and global default trust rule. Skipped project resources and individual extension-load failures
produce warnings while retaining the models Pi can load. Invalid model configuration and persistent
metadata-query failures produce local errors. Fresh trust decisions remain part of Pi startup.

Discovery completes extension registration before resolving defaults. The short-lived SDK process
creates no persistent session, emits no session-start event and makes no agent/model request.
Refresh replaces an older preview without replacing explicit or inherited choices. Directory/catalog,
inherited-selection and per-model thinking reads use bounded automatic recovery for transient failure.
Each attempt stays bound to its directory, source, input intent and browser transport; changing these
owners or unmounting retires old waits and responses. Manual effort retires a pending thinking preview.
Successful reads clear their obsolete errors without creating a session or submitting a message.

An unverified or known-invalid directory keeps Start unavailable until a successful check; an inherited
or explicit model cannot bypass that check. A failed observation preserves a known missing/invalid
path rather than reclassifying it. Optional refresh of the same confirmed directory retains its model,
effort and readiness; changing directory or transport requires fresh validation. Persistent failure
keeps staged work and local recovery. Process lifetime, shared queries and cache invalidation are
described in [[state-ownership]].

## Provider and model configuration

Create or choose a provider, then add its models. Provider fields cover identity, endpoint, API type
and optional model-file credentials. Model fields start with ID and display name, then capabilities
and limits. A model without an inherited API exposes its required API field; inherited APIs and
optional endpoint overrides stay compact. Custom API types are accepted.

Forms retain untouched providers, model metadata, overrides and advanced fields under Pi's schema.
Removing a declaration affects `models.json`, independently of built-in catalog entries and saved
login credentials. Configured declarations and saved preferences remain editable when model discovery
is unavailable. Settings reports the availability failure separately from file errors; catalog
discovery is not a prerequisite for reading or saving configuration.

Provider/model creation and editing open a focused subview inside the Models category, replacing
the browsing sections without unmounting their state. The header identifies the edit target and
offers Back to models; the form body scrolls separately from the always-reachable Save/Cancel
actions. Existing field contents, advanced disclosures and declaration semantics remain unchanged.
Back and Cancel discard that editor's draft and restore the originating list context, including
search, disclosure state, scroll and focus. Saving an existing model preserves the search; if its
new identity no longer matches, focus returns to search. A newly created model still receives focus
in the ordinary available list. Virtualized return targets receive focus after their row mounts.

Drafts belong to their provider/model and creation mode and survive Settings category switches.
Model search and loaded data retain the same Settings owner while its category is hidden; hidden
content does not take focus or apply destination scrolling. Errors remain in the form. Creating a
provider continues at Add model; a newly available model appears in the ordinary model list. Cancel
returns to the entry point, and Common/Default saves retain row focus unless the user has moved it.

Candidate declarations are validated in the existing isolated metadata worker against the same
agent directory, selected working directory and project-trust policy as Pi. Extension provider
registration precedes validation so legal inherited API/endpoint declarations remain valid, including
when editing an unrelated provider. Unrelated extension-load failures do not veto valid declarations;
Pi still validates the complete candidate against the providers that loaded. Validation starts no
model turn or persistent session and keeps factory errors and credentials out of responses. Publish
only after revision and atomic-publication checks.

Writes detect conflicting external edits, accept native file syntax and follow existing configuration
symlinks under the same lock authority as native edits. Regular files take one native target lock
rather than double-locking a case/normalization alias; final symlinks retain lexical and target
authorities. Target/revision checks remain mandatory before publication, including a file replaced by
a symlink during the edit. After publication, a refresh/readback failure produces a warning and a
recovery action without changing the save result.

A configuration save invalidates cached workspace metadata. For an addressed session, it refreshes
that worker only; other workspaces rediscover on demand. Without a session, it refreshes the edited
workspace catalog. Refresh preserves ongoing work and the current selection. The explicit Refresh
control rereads external changes while Settings remains open. Earlier catalog/settings reads cannot
replace a newer published write snapshot in the picker or Common scope, including its error state.
Only the current catalog observation may publish warnings or errors; an obsolete warmup cannot
restore feedback after a configuration snapshot has been accepted.

## Authentication

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
prompts and outcomes. Supported methods offer Remote login help on demand, following the selected
method's device-code, pasted-code or redirect interaction.

Attempts retain their originating worker. Cancellation or supersession prevents an older attempt
from replacing a newer credential choice. Status-read failures resume observation; failed cancellation
also resumes observation. Once an attempt settles, its outcome supersedes earlier request errors;
late answer, cancellation or status responses cannot replace it or add stale errors. The Host briefly
retains settled outcomes so clients can recover a lost final response.

Stored or resolved keys/tokens are omitted from ordinary model/status payloads and logs. Logout removes
Pi's saved credential; environment and `models.json` credentials are managed separately.

## Configuration checks

- `tests/server/model-metadata.integration.test.ts` exercises native global/trusted-project provider
  composition, inherited model declarations, unrelated-provider edits, an explicit agent-directory
  authority, and validation without a turn or persistent session.
- `tests/server/model-settings.test.ts` covers revision conflicts, file/symlink authority, atomic
  edits, preserved unedited declarations and protected credentials.

## Related contracts

[[interface-preferences]], [[composer]], [[pi-integration]].
