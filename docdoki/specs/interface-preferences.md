---
purpose: Settings organization, field-owned persistence, shared update observations, and task-alert controls.
covers:
  - shared/contracts.ts
  - server/{preferences,update-checker,pi-update-checker,update-coordinator}.ts
  - src/controllers/{preference,update,runtime-event}-controller.ts
  - src/{visual-preferences,session-actions,update-availability,use-modal-focus}.ts
  - src/components/{Settings,SettingsControls,SettingsDialog,SettingsSection,SessionActionsSettings,SystemVersionsCard}.tsx
  - src/styles/{settings-overlays,responsive}.css
  - tests/server/{preferences,update-checker,pi-update-checker,update-coordinator}.test.ts
  - tests/web/{preferences,session-actions,settings-navigation,settings-loading,system-versions,notices,update-controller,attention,modal-focus}.test.ts*
  - tests/browser/{settings-layout,loading-states}.spec.ts
---

# Interface preferences and task alerts

## Goal

Keep persistent preferences easy to find and save each change without overwriting newer intent.
[[workbench]] owns the shell entry point; [[activity-presentation]] owns card rendering.

## Settings organization

Settings opens from the topbar as a modal, leaving session navigation in place. Display, Conversation,
Behavior, Models, MCP, Adapters and System are separate category views. Only the selected category is visible,
focusable and exposed to assistive technology. Category navigation starts its content at the top;
scrolling within a category does not change the selection. Drafts, model browsing state and pending
login attempts remain intact across category switches. Model and credential destinations reveal their
owning category before locating the requested section.

[[design-system]] owns field-card layout, shared control sizing, selection markers and feedback
presentation. These rules also apply to Terminal settings.

| Category | Controls |
| --- | --- |
| Display | One field group: `Theme`, `Color palette`, `Content text size`, `Reading width`, `Project location`, then `Titlebar needles`. The workbench header and installed-window title bar have distinct scopes, explained beside their controls rather than combined under a location-based heading. |
| Conversation | One field group: activity visibility (`Reasoning detail`, `Tool activity`, `Activity groups`), then `Send key`. |
| Behavior | App behavior (`On launch`, `Task alerts`), `Session actions` ordering, then `Pi session settings` (`Steering delivery`, `Follow-up delivery`, `Automatic context compaction`, `Automatic retry`). |
| Models | Pi defaults, common scope/cycling, graphical model/provider configuration, and nearby login/logout under [[model-settings]]. |
| MCP | Scoped native-file configuration, protected-value edits and explicit selected-worker Reload under [[mcp]]; not a connection inventory. |
| Adapters | Unified enablement of externally configured GUI adapters under [[tool-presentations]]; not Pi extension execution management. |
| System | Component versions, Docs/Changelog release references and unified update check; then `Host`, with `Herdr enhancement` followed by Host restart under [[host-lifecycle]]. |

Pi controls follow [[pi-integration]]. A dedicated `Pi session settings` section and concise scope note
(`Changes apply to the current session; Pi manages defaults and project overrides.`) distinguish
current-session runtime settings from Pi-managed defaults and project overrides without implying confirmed
global persistence. Keep detailed persistence limitations in [[pi-integration]]; do not label a setter
acknowledgment as Saved. In `System`, `Herdr enhancement` shares the Host/restart card with the actions
that apply it under [[herdr-enhancement]].
Footer utilities present INSΠRE version, optional install action, and Reset preferences on a single line.
System lists Pi, Extensions and Inspire in that order. Pi's Docs and Changelog links share its label
row; update commands reuse the file/path click-to-copy presentation without a persistent copy icon.
Both restart actions use equal-height danger controls, with descriptions that
state whether project terminals keep running or close.
Category names and self-explanatory choices need no introductory text; descriptions explain scope or
non-obvious behavior. The bounded category navigation has no separate search.

Titlebar needles is an opt-in persisted switch for installed-window animation. The centered titlebar
brand toggles the same preference; refresh restores the saved choice. See [[design-system]] for motion.

Reset preferences opens a confirmation dialog stating its exact scope before patching the complete
interface-default set (including Herdr, titlebar needles and session action order) while leaving Pi
runtime settings, models, credentials, MCP servers, update observations, navigation curation, pane
state, and other direct work state unchanged.

Terminal settings uses the same category navigation for Appearance, Interaction and Saved output
under [[terminal]]. Category and subsection
navigation scroll only dialog content, keeping the header, navigation and utility footer in place.
Offscreen categories remain reachable in the narrow horizontal strip. Resizing keeps the selected
category and its label visible, clear of the fading edges, without resetting page scroll or snapping
back a deliberately browsed strip. Unknown runtime values show Unavailable rather than a confirmed state.

## Session action order

Behavior includes an ordered list of the session title menu's actions, with a drag handle on
the right of each row. Mouse and touch dragging and Alt+Up/Down shortcuts preserve the focused
action while it moves. Clicking or keyboard-activating a Settings handle opens move options
(up and down); Escape closes those options and restores the handle without closing
Settings. Starting a drag dismisses the move options.
A disclosure boundary separates the first three actions, shown immediately in the compact menu,
from the remainder revealed by More actions. Behavior settings use quiet, unboxed ordinal numbers
and a sentence-case boundary hint between thin rules, without a shaded strip or stacked row borders.
Row and drag-handle targets retain their existing sizes. Both surfaces edit the same saved order.
Ordering changes only presentation, not action eligibility or execution.

The order is a Host-persisted interface preference, saved through the existing field-owned write
path and included in Reset preferences. An older saved order keeps its relative order and gains
newly introduced actions at the end; sorting never removes actions. [[workspace-layout]] owns the
menu's behavior.

## Loaded extension names

System must list the current session's complete loaded-extension names when Pi exposes that
worker-owned inventory, including extensions without commands or tools. Registered capabilities,
a fresh resource scan and package update results cannot establish current-worker membership.
[[pi-capability-gaps]] records the missing interface; the requirement remains open.

## Modal focus

- The active modal traps Tab, suppresses background shell shortcuts, and restores its exact opener
  on close. Nested modals retain this ownership even when they close out of order. Anchored portaled
  controls belong to their containing modal's stacking, focus and logical tab order.
- A nested menu consumes Escape before its containing modal. Otherwise, Escape belongs to the
  topmost modal; an attributed extension request yields it only for projection-conflict recovery.
- Settings and Command Palette are mutually exclusive. An extension request takes modal ownership
  and suspends Settings together with its subordinate confirmations, preserving the selected page,
  project owner and unsaved forms. An open Palette stays mounted but hidden and inactive, retaining
  preparation text and rejection feedback. The suspended surface resumes after the question closes
  without implicitly saving configuration or restarting the Host.

## Preference persistence

- Changes patch only their own fields through a serialized write path. Concurrent preference,
  session-pin, folder-pin, and hide changes preserve one another.
- A refused write warns and rolls its fields back to the last Host-confirmed values. A newer local
  change retains ownership of its fields, including across a sequence of refused writes.
- Full snapshots returned by other operations apply only to fields whose local owner has not
  advanced since that operation began; deletion cleanup therefore preserves newer settings.
- Palette identifiers and their legacy migration follow [[design-system]]. Theme and palette changes
  own separate fields; resetting preferences returns to Chimonanthus with System luminosity.
- Missing stored fields receive migration defaults. Invalid fields use defaults in the displayed
  projection and produce a bootstrap warning; other settings remain editable. Field-scoped writes
  preserve unedited invalid values and unknown fields, and a valid edit repairs its addressed field.
  Known migrations canonicalize valid saved values on the next write. Unknown patch fields still
  reject. Recent models store only provider/ID, accepting extra discovery metadata without retaining it.
- Malformed JSON or a non-object root uses the full default projection and blocks writes to avoid
  discarding unreadable settings. The warning names the file to repair or remove; reads never rewrite it.
- The retired `assistantRoundDisplay` field is ignored on read and omitted on the next successful
  write; no Details/Divider preference or palette action remains.

## Update observations

- The Extensions check covers global/user packages. Document this scope in the command guide rather
  than adding a persistent qualifier to the result label.
- System shows the extension update count and copyable update command on the main line, then
  lists package source links below, one package per line, even for a single update. Details align
  right on desktop and left on narrow screens; long names wrap. Pi's package observation provides
  names and source types, not version differences or changelog text; the npm/repository links are
  source references, not embedded release notes.
- Versions offers Copy beside its check action whenever updates are available, including while
  the update notice is snoozed. It shares the notice's exact report: available version transitions,
  sorted extension package names, update commands and release links. Background checks preserve the
  known notice and its copyable report; only the check action is busy. Clipboard failures stay in
  this section and can be retried.
- Explicit checks bypass the cache and reread the installed Pi identity without importing its SDK.
  Pi availability and copied version transitions compare that installation with the latest release,
  not the version recorded at Host startup. The main row shows the installed version. When it differs
  from the Host-loaded version, show only `Restart Host to apply`; keep the loaded version in the
  version's tooltip, not an additional permanent explanation. A still-newer release keeps its update
  action alongside the restart status. An unreadable installation is unknown, never the startup
  version presented as a fresh observation. Local identity remains observable when remote checks fail
  or Pi is offline. Installed updates leave the available-update notice; pending activation alone
  does not create one. Restart behavior remains under [[host-lifecycle]].
- Extension results describe installed packages, not what any current session has loaded. Do not infer
  activation or manufacture a reload requirement from the package update list.
- The first accepted prompt after 08:00 Host-local time each day invokes cache-aware checks. The
  deployment persists this daily gate across restarts. Page startup, visibility, and timers do not
  initiate checks.
- The Host coalesces clients and caches results for six hours. Checks send no session data or
  credentials; an unavailable source leaves local work quiet. Pi checks use its official latest
  endpoint and package-manager observation. INSΠRE distinguishes no published release from a failed
  check.
- Available Pi, extension, and INSΠRE updates share one notice that opens Settings at System.
  Host snapshots, status events, and results own execution state. Browser request-pending state
  separately prevents duplicate clicks until Host execution is observed; the button uses one
  `Checking…` state throughout. Transient request failures recover with bounded backoff while retaining
  previous results. Observed Host execution ends request recovery, including when its HTTP response
  arrives late or is lost. A persistent or non-transient request failure is reported once in Versions
  without replacing known results. A new request or observed Host check clears that request error;
  transport replacement retires the old request and its recovery. HTTP failure or disconnection does
  not mark a running Host check finished.
- Observations and the exact-set 24-hour snooze belong to the Host deployment. Bootstrap and events
  reconcile local and forwarded views; dismissal anywhere hides the notice everywhere. Host restart
  preserves the remaining interval, and a changed version or extension set bypasses the snooze.
  Rendering a notice does not consume it.

## Independent activity density

Activity groups, tools, and reasoning have independent saved defaults and per-card overrides.
All default to **Adaptive**, stored as `dynamic`; existing stored identifiers retain their meaning.
Selectors put Adaptive first, followed by fixed modes from most to least detail:

| Control | Fixed modes |
| --- | --- |
| Activity groups | Expanded, Compact, Collapsed |
| Tools | Expanded, Compact, Collapsed, Hidden |
| Reasoning | Expanded, Collapsed, Hidden |

Option help describes materialization: Expanded loads every card; Compact presents up to the latest
24 behind the existing expansion entry; Collapsed shows only the group entry and releases child DOM.
Projection-scoped state preserves deliberate reading choices for reopening. A per-card override leaves
its saved default unchanged.

## Task alerts

[[notifications]] owns task outcomes, device-local intent, delivery, permission/status feedback,
test notifications and click-through. Keep its Off / Mark tab / System notification control in
Behavior, using the existing field-card layout with contextual status and actions below the choice.
The neighboring Notification grouping field selects Session or Project independently, with its own
save/error state and no permission prompt. [[notifications]] owns grouping and member-count semantics.

Notification permission and enrollment are installation-local, unlike ordinary Host preferences.
Reset preferences also resets alerts on this installation, not other devices. Legacy
`completionAttention` values supply migration intent; they do not establish permission or push
enrollment. Page refresh and reconnect preserve a Host-observed run's notification eligibility.

## Checks

Preference tests cover field ownership, refusal rollback, migrations, and invalid-file protection.
Settings and modal tests cover navigation, loading, menu dismissal, and focus restoration; Chromium
checks menu reachability and persistence. Update tests cover their observation lifecycle; task-alert
conformance follows [[notifications]], with device evidence and remaining acceptance in
[[follow-notifications-2026-10-22]].
