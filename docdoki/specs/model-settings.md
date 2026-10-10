---
purpose: Lightweight model configuration and provider authentication using Pi's native settings, models, and credential storage.
covers:
  - server/{model-settings*,model-catalog*,model-metadata*,session-model-selection,session-projection,provider-auth*,app,index,runtime,runtime-worker-lifecycle}.ts
  - server/extensions/{inspire-branch-bridge,provider-auth-bridge}.ts
  - shared/{contracts,commands,model-settings,provider-auth-bridge}.ts
  - src/{App,api,app-state,store,model-options,use-modal-focus}.ts*
  - src/components/{Settings,SettingsControls,SettingsSection,ModelsSettings,ModelDeclarationForms,ProviderAuthentication,ModelSelector,ModelList,Composer,Welcome,CommandPalette,CommandHelp}.tsx
  - src/styles/model-settings.css
  - tests/server/{model-settings,model-catalog,model-metadata.integration,model-workflow.integration,session-model-selection,provider-auth,provider-auth-bridge.integration}.test.ts
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

The Models category has three sections:

1. **Models:** a searchable available-model list with Common and Default choices, followed by the saved
   default model, Clear action and default-thinking dropdown. “Model default” clears the explicit
   thinking setting. Common order and rules expand below the list. Declared models offer an edit action.
2. **Login & API keys:** saved providers with credential status and Manage, plus Connect provider.
   The provider directory, method selection and login attempt replace one another. Back preserves the
   directory query; finishing login returns to saved providers.
3. **Custom providers:** a collapsed-by-default configuration card with provider/model counts and
   Add provider. Each provider owns its connection fields and a collapsible model list with Add model.

Available-model and provider lists window large result sets while keeping every result reachable by
search and keyboard. Provider headings are quiet, unboxed labels within the Models card; compact
rows give Common and Default equal-width columns. Common uses a checkbox for independent membership;
Default uses a radio for the single saved startup choice. Their indicators share Settings control
surfaces, hairlines and accent tint/mark roles while retaining native input behavior. Reselecting
Default leaves it set; the saved-default summary's Clear action removes it. Action-row Up/Down and
Home/End navigation reaches the full filtered list, including unmounted rows. Default also supports Left/Right and wraps between
the first and last result, focusing and selecting the destination after it mounts. Common navigation
moves focus without toggling membership. Search navigation remains neutral until explicitly used.
The shared picker and Settings list show display names first. Provider-group captions omit the
provider already named by the heading; Common captions retain it. The picker always retains its
second-line ID, including identical names and IDs, and shows provider/ID in Common. Settings
shows identical names and IDs once. Both retain full-identity row tooltips.
Search emphasizes original-text matches in names, IDs and provider labels, tracing the existing
locale-folded literal-first/greedy-subsequence rule, including provider/ID-spanning queries.
Identity deduplication and emphasis preserve fixed row heights, capacity, ordering and badges.
The picker marks its selected model with one checkmark and `aria-selected`, and offers one
Manage models destination. From New, that destination keeps the prospective project directory; an
open session keeps its session owner. General control and focus styling follows [[design-system]].

## Defaults, common models and selection

Settings edits global Pi preferences and displays effective project overrides alongside them. Saved
identities and patterns remain visible when unavailable. A failed read has its own error state.

Common choices use Pi's ordered model-cycle patterns. Exact entries, including thinking-effort
suffixes, toggle directly. Rule-covered rows show a separate “Via rule” edit action instead of a
checkbox, including when an exact entry also matches. Its tooltip attributes the source rules; the
action opens the existing rule editor, where the pattern remains explicit. Editing
retains pattern syntax, order, unmatched entries and unrelated settings. Common matches appear first
in the picker; without a configured common scope, the picker has no Common group.

Next/previous-model and thinking-cycle commands use cached native choices. Gestures execute in order
within their session/transport owner and respect editors, menus, modals and IME. Startup-default
edits leave the current session model and thinking level unchanged.

Pi's selected identity can differ from the physical responder. Selection controls and New inheritance
use the selected identity; reply headers and usage use actual response semantics. Virtual models show
Router in the existing model list. A physical response does not replace the selected router.

Live selection comes from the owned worker, including after branch navigation. For inactive sessions,
selection follows the viewed branch and Pi's recovery rules with current registration metadata.
File-backed transcripts open independently of model discovery.

## New-session discovery

New distinguishes explicit selection, inheritance from a session and workspace defaults. Explicit or
inherited choices keep their effective thinking value; manual thinking changes take precedence.
Workspace-default startup leaves model and unmodified thinking arguments to Pi. Model switches use
Pi's per-model thinking preference, then global preference, then current effort, with supported-level
clamping. Catalog refresh alone does not reapply defaults; non-reasoning models disable thinking.

One metadata query returns available choices and startup-default previews for the prospective cwd.
It includes global and already-trusted project extension registrations, using Pi's stored/inherited
trust and global default trust rule. Skipped project resources produce a warning; failed discovery
produces an error. Fresh trust decisions remain part of Pi startup.

Discovery completes extension registration before resolving defaults. The short-lived SDK process
creates no persistent session, emits no session-start event and makes no agent/model request.
Refresh replaces an older preview without replacing explicit or inherited choices. Process lifetime,
shared queries and cache invalidation are described in [[model-discovery-ownership]].

## Provider and model configuration

Create or choose a provider, then add its models. Provider fields cover identity, endpoint, API type
and optional model-file credentials. Model fields start with ID and display name, then capabilities
and limits. A model without an inherited API exposes its required API field; inherited APIs and
optional endpoint overrides stay compact. Custom API types are accepted.

Forms retain untouched providers, model metadata, overrides and advanced fields under Pi's schema.
Removing a declaration affects `models.json`, independently of built-in catalog entries and saved
login credentials. Configured declarations remain editable when their models are unavailable.

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

Writes detect conflicting external edits, accept native file syntax and follow existing configuration
symlinks under the same lock authority as native edits. A committed write remains successful when
refresh or readback fails; the response supplies a warning so Settings can offer refresh or reload.

A configuration save invalidates cached workspace metadata. For an addressed session, it refreshes
that worker only; other workspaces rediscover on demand. Without a session, it refreshes the edited
workspace catalog. Refresh preserves ongoing work and the current selection. The explicit Refresh
control rereads external changes while Settings remains open.

## Authentication

Provider methods come from the installed Pi, including native and extension API-key/OAuth flows.
`/login` opens provider selection and may reveal an unambiguous provider's methods; authorization
starts only after selecting a method. Loading, errors and empty results are separate states.

The Connect provider directory uses regular-weight names and semibold literal search matches.
Search keeps its existing case-insensitive substring filter over provider ID and name. When only the
ID matches, the row also shows that ID as secondary monospace text with the matching fragment emphasized.
Names matching the query need no extra ID. Connected-provider and method-page titles retain their
stronger hierarchy, with no directory match emphasis; returning from methods preserves query and focus.

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

## Related records

[[follow-model-settings-auth-2026-10-02]] records configuration and authentication implementation;
[[follow-model-selection-2026-10-02]] covers thinking transitions and active-worker refresh;
[[follow-native-model-workflow-2026-10-05]] covers recovery, discovery and New inheritance.
Related contracts: [[interface-preferences]], [[composer]], [[pi-integration]].
