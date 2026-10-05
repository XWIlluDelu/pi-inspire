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

Keep ordinary model selection lightweight. Put defaults, common-model configuration, and graphical
management of Pi's `models.json` in Settings. The model catalog and its default-value results share one card.
Configuration and login are independent: adding a provider must not require completing a separate
onboarding or authentication workflow.

## Page structure

The Models category contains three sections in this order:

1. **Models.** One searchable available-model list provides Common and Default chip buttons beside
   each model, using the same small-radius controls as the rest of Settings, with direct configuration
   editing beside declared model names. Common/Default occupy equal-width columns at the row end.
   Provider headings use a distinct surface; names truncate with the full name in the title. Lists
   use compact rows, with extra height only for narrow stacked layouts; virtualized and visible
   row heights match. An inline results area immediately
   follows the catalog: Default model displays the configured value with a text Clear button, and Default
   thinking provides a dropdown starting with Model default. A collapsible Common order and rules area
   allows reordering and removing cycling patterns.
2. **Login & API keys.** Saved credentials with provider status ("API key saved" / "Signed in"), Manage
   action and aligned method choices with secondary removal. Credential
   management, provider discovery and a login attempt are separate views: opening one replaces the
   previous view. Back preserves the directory query; finishing a login returns to saved providers.
3. **Custom providers.** An independent collapsible card (collapsed by default) with an `+ Add provider`
   action in the header, summary row displaying provider/model count and Show/Hide toggle, and detailed
   configuration for endpoints and model declarations in Pi's `models.json`. A provider has its own
   heading and connection details; its Models group, model actions and Add model control are nested
   underneath rather than presented as peer rows. Each provider's model list starts collapsed and
   shows only display names and IDs when opened; capabilities remain in the model editor.

## Selection and defaults

- Default model and Default thinking sit directly below the available-model catalog in an inline results
  area separated by a hairline border. Default model stacks its name above the provider/id, with Clear
  alongside. An unset value reads "Not set", aligned with the adjacent settings controls. Default thinking provides a dropdown starting with
  "Model default" ("Use each model's own setting.") followed by Pi thinking levels. Project-specific
  overrides appear as additional "This project uses <target>." guidance. Neither operation changes the
  active session. Failed reads remain distinct from unset values, and unavailable configured models
  retain their identity.
- Default and common-model candidates come from Pi's currently available models, as in the session
  picker, not its complete catalog. Already usable built-in models need no manual declaration.
  Configuration and authentication changes refresh these choices without switching the current model.
  Retain saved identities and patterns when temporarily unavailable; they are not new candidates.
- The session picker marks the current model once, with a checkmark and `aria-selected`; it has no
  duplicate Active badge. Settings and picker search bars share compact styling. Provider headings
  span the list width; rows supply text padding without an extra inset frame.
- Ordinary picker selection changes the current choice, not the saved startup default. The picker
  offers one Manage models destination rather than per-row configuration menus. From New, this
  destination carries the prospective project directory; in-session settings retain their session owner.
- Settings exposes the default model and default thinking level as distinct Pi settings. Preserve
  native precedence and current-session state; defaults are not a second Inspire configuration.
- Common models appear first in the picker, in their configured cycle order; other models remain
  searchable. With no configured common models, show no common heading, empty state, or placeholder.
- Settings owns adding/removing/reordering the common scope. Use Pi's native model-cycle setting,
  not an independent favorites database. Common selection is an action in the existing-model list,
  distinct from adding a model declaration. Preserve existing native patterns and unrelated settings
  without requiring pattern syntax for ordinary selection. Show readable model names with identifiers
  secondary where needed. Exact common members, including a complete identity with a thinking-effort
  suffix, toggle directly. A rule-covered row shows Common without a persistent raw expression; expanded
  saved-entry details expose the source rules for editing/removal. Do not imply that removing one exact
  entry removes rule coverage. Preserve dynamic matching without expanding patterns into identity
  snapshots or adding exclusion rules.
- Model lists and menus have bounded visible size and render work as their data grows. Search and
  keyboard navigation can reach every matching available model without mounting the entire catalog.
- Next/previous-model and thinking-cycle actions use the existing command/keyboard surfaces and
  reflect results in the existing controls. Use cached native choices promptly, not a network catalog
  refresh on each keystroke. Rapid gestures retain their order within a session/transport owner;
  earlier work cannot delay or mutate a new owner. Do not add permanent arrow buttons or a new
  management page for cycling. Browser shortcuts must respect focused editors, menus, modals, and IME.

## Native identity and startup discovery

- Pi's selected model and the physical responder are different authorities. Picker selection,
  thinking choices and New inheritance use the selected identity. Reply headers and Pi context/usage
  retain the actual response semantics. A virtual routing entry remains selected after a physical
  response; show a compact Router marker in model choices, not a second selector or route editor.
- Live snapshots use the corresponding owned worker's selection, including after real branch
  navigation whose effective leaf has not yet become the persisted tail. Without a worker, resolve
  selection from the viewed branch using Pi's recovery rules and current registration metadata.
  Pending or failed model discovery does not delay file-backed transcript opening; unresolved
  selection is not inferred from the physical responder.
- New distinguishes explicit choice, session inheritance and workspace default. Explicit/inherited
  models retain the controls' effective thinking value, with manual changes taking precedence.
  Workspace-default startup omits the model argument and, unless adjusted, thinking; Pi resolves
  both. Do not make an incomplete preview override native defaults.
- A single catalog query returns choices and startup defaults for the prospective project directory;
  refreshes supersede older previews without replacing explicit or inherited selection. Include global and already-trusted project extension registrations as well as static
  declarations. Use stored/inherited decisions and Pi's global default trust rule; fresh extension
  trust decisions remain with normal Pi startup. Listing models does not approve a project.
  Distinguish skipped project resources and failed discovery from an empty available list.
- Discovery completes native registration before final default resolution. It does not create
  persistent session records, emit session-start events or initiate an agent/model request. It uses
  bounded native metadata initialization, not a permanently running discovery worker or an Inspire
  model registry. Existing refresh and configuration/authentication changes refresh these results.

## Provider and model configuration

- Provide graphical add/edit/remove for provider and model declarations in the installed Pi's
  `models.json`. Do not turn this into a provider catalog, subscription manager, or onboarding system.
- Create or choose the provider first, then add models within it. Provider fields prioritize identity,
  endpoint and API type, with credentials as needed. Model fields start with required ID and optional
  display name, followed by capabilities and limits. Use a short default placeholder when API type is
  inherited. Endpoint-first provider configuration remains valid; when a model has no inherited API, expose
  its required API field before capabilities rather than hiding it as an optional override. Accept custom
  API types without treating an example or placeholder as a default. Other endpoint/API overrides remain
  on demand. Configured declarations remain manageable independently of current authentication.
- Work with Pi's native schema and preserve untouched providers, model metadata, overrides, and
  advanced configuration. Removing a custom declaration must not imply deleting a built-in catalog
  model or logging out of its provider.
- Configuration writes retain valid existing data and native-accepted file syntax; invalid input and
  conflicting external edits do not silently overwrite it. Follow existing config symlinks and lock
  the same authority as native edits. Reuse native public settings/model facilities where available.
  A successful file write remains a committed success when optional refresh/readback fails.
- Bind form drafts to their provider/model target and creation mode. Show submission errors in the
  current form. A new provider continues at Add model; a newly available model is shown in the existing
  list for row actions. Unavailable declarations do not become selectable candidates. Cancel returns to
  its entry, and common/default saves retain row focus. Do not reclaim focus after the user moves it or
  the settings owner retires.
- Refresh model availability through the accepted non-interrupting catalog path. Configuration
  changes do not silently switch the current model or restart ongoing work. The explicit refresh
  control rereads external edits while Settings stays open; focusing it does not highlight the first
  model as if the user selected that row.

## Login and saved credentials

- Start with connected providers and Connect provider. Each row offers Manage; methods, removal
  and login fields appear only when opened. Connect provider reveals a searchable, bounded list;
  no saved credentials means the same Connect entry, not an empty credential table. Selecting a
  provider replaces the bounded directory with its full-width methods; Back to providers preserves
  the search and returns focus to it. Saved credential status sits beside the name when space fits. `/login`
  opens provider selection and can reveal an unambiguous matching provider's methods without
  starting authorization. Loading and failed reads remain distinct from an empty search result.
- Adapt the installed Pi's provider login methods, including supported API-key and interactive
  authorization flows, and provider logout/removal of saved credentials. Do not restrict the list to
  the providers with a remote-authorization badge.
- Authentication applies to the connected Host's Pi credentials, not the browser device's Pi. Use
  native authorization interactions rather than creating a separate account system.
- Methods with native remote support show Remote login and a circled-question button. Click, tap or
  keyboard activation reveals the supplied explanation; it is not persistent page copy. Help follows
  the actual native method (for example device-code or pasted-code completion), including during an
  authorization attempt. Other methods have no remote badge; their native login path remains available.
- Show the native link/code/input and pending/completed/cancelled outcome without requiring Host-side
  browser automation. Do not report authorization as completed until Pi accepts it. Cancelled or
  superseded attempts cannot overwrite a newer credential choice. A temporary status-observation
  failure remains recoverable without restarting authorization or resubmitting its input. Failed
  cancellation resumes observation. The owning Host retains terminal receipts briefly for repeat
  reads, so a lost final response does not erase the outcome.
- Credentials remain Host-owned. Normal model/bootstrap/status payloads and logs do not expose stored
  or resolved keys/tokens. Logout removes the saved credential; it does not claim provider-side
  revocation or deletion of environment/model-file credential sources.

## Checks

Check native settings/configuration round trips without touching live user files, preservation of
advanced declarations and unrelated fields, default/common distinction, no empty common group,
cycle order, and current-session continuity. Exercise native authorization callbacks with isolated
credentials and synthetic providers/transports, including remote code/URL completion, cancellation,
and logout. Distinguish this from live-account verification. Verify settings and picker integration
in fresh-bundle desktop and narrow Chromium, including keyboard/touch controls, on-demand method help
and draft preservation.

## Sources

The approved direction keeps configuration independent of login, routine choices compact, and
remote-login guidance specific to methods with established support.
[[follow-model-settings-auth-2026-10-02]] records implementation, verification and supported boundaries;
[[follow-model-selection-2026-10-02]] records thinking transitions and non-interrupting catalog refresh.
[[follow-native-model-workflow-2026-10-05]] records selected-model recovery, startup discovery,
nonblocking transcript access and New inheritance verification. Related contracts:
[[interface-preferences]], [[composer]], and [[pi-integration]].
