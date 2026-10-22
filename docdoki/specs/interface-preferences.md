---
purpose: Settings organization, field-owned persistence, shared update observations, and completion attention.
covers:
  - shared/contracts.ts
  - server/{preferences,update-checker,pi-update-checker,update-coordinator}.ts
  - src/controllers/{preference,update,runtime-event}-controller.ts
  - src/{visual-preferences,update-availability,use-modal-focus}.ts
  - src/components/{Settings,SettingsControls,SettingsDialog,SettingsSection,SystemVersionsCard}.tsx
  - src/styles/{settings-overlays,responsive}.css
  - tests/server/{preferences,update-checker,pi-update-checker,update-coordinator}.test.ts
  - tests/web/{settings-navigation,settings-loading,system-versions,notices,update-controller,attention,modal-focus}.test.ts*
  - tests/browser/{settings-layout,loading-states}.spec.ts
---

# Interface preferences and completion attention

The retired `assistantRoundDisplay` field is ignored when reading existing preferences and omitted
on the next successful write. Its Details/Divider UI and command-palette actions are removed.

## Goal

Keep persistent preferences easy to find and save each change without overwriting newer intent.
[[workbench]] owns the shell entry point; [[activity-presentation]] owns card rendering.

## Settings organization

Settings opens from the topbar as a modal, leaving session navigation in place. Display, Conversation,
Behavior, Models, MCP and System are separate category views. Only the selected category is visible,
focusable and exposed to assistive technology. Category navigation starts its content at the top;
scrolling within a category does not change the selection. Drafts, model browsing state and pending
login attempts remain intact across category switches. Model and credential destinations reveal their
owning category before locating the requested section.

Section headings and descriptions sit above independent bordered field cards, not inside tinted
header bands. Cards do not clip menus or keyboard focus. Checked switches use the shared accent fill
and its contrasting foreground role in both luminosities; category and palette choices keep explicit
selected-state markers. These are presentation choices, not changes to preference saving behavior.

| Category | Controls |
| --- | --- |
| Display | One field group: `Theme`, `Color palette`, `Content text size`, `Reading width`, `Project location`, then `Titlebar needles`. The workbench header and installed-window title bar have distinct scopes, explained beside their controls rather than combined under a location-based heading. |
| Conversation | One field group: activity visibility (`Reasoning detail`, `Tool activity`, `Activity groups`), then `Send key`. |
| Behavior | App behavior (`On launch`, `Completion alerts`) and `Pi session settings` (`Steering delivery`, `Follow-up delivery`, `Automatic context compaction`, `Automatic retry`). |
| Models | Pi defaults, common scope/cycling, graphical model/provider configuration, and nearby login/logout under [[model-settings]]. |
| MCP | Scoped native-file configuration, protected-value edits and explicit selected-worker Reload under [[mcp]]; not a connection inventory. |
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
interface-default set (including Herdr and titlebar needles) while leaving Pi runtime settings, models,
credentials, MCP servers, update observations, navigation curation, pane state, and other direct work
state unchanged.

Settings and Terminal settings share field, switch, stepper and segmented-control styling: 32px
controls for a mouse, 40px for touch. Ordinary dropdowns, segmented choices and the named palette grid
share a choice-column width. Segments use a recessed group with a neutral selected surface and edge.
Named palette choices retain independent bordered tiles with an accent-tinted selected surface and
accent border, not a shared recessed tray. Both use stronger selected weight and theme-accent text as
specified in [[design-system]]; palette names and hue markers remain visible. Section icons use theme-accent ink, while heading
text stays neutral. Category selection, switches and keyboard focus retain their functional emphasis.
Ordinary fields wrap controls according to available space, rather than per-field wide flags;
descriptions retain a readable column. Narrow cards let wrapped controls fill the row. Switches, font-size steppers and model
identity summaries keep their compact layouts. Segment labels do not wrap. Herdr availability and
pending-restart notes remain unboxed, with each message and its associated action wrapping as
separate items rather than running together. Terminal settings uses the same category
navigation for Appearance, Interaction and Saved output under [[terminal]]. Category and subsection
navigation scroll only dialog content, keeping the header, navigation and utility footer in place.
The narrow horizontal category strip uses one accent underline for selection, with visible keyboard focus and
reachable offscreen categories; the desktop sidebar retains its existing treatment. Resizing keeps
the selected category and its label visible, clear of the strip's fading edges, without resetting
page scroll or forcing a deliberately browsed strip back on each scroll event. Unknown runtime
values show Unavailable rather than a confirmed state.
Open menus can extend beyond cards without clipping. Disabled controls remain legible and distinct
from selected, available controls.

## Loaded extension names

System must list the current session's complete loaded-extension names when Pi exposes that
worker-owned inventory. This remains blocked in Pi 1.0.0 and the installed 1.1.0: neither RPC nor
`ExtensionAPI`/`ExtensionContext` exposes it. `get_commands` and `getAllTools()` describe registered
capabilities, not extensions that register neither. A fresh SDK resource scan would describe another
runtime, not this worker. The narrow missing interface is a current-worker loaded-extension identity
read, including command-free extensions. Package update results remain separate from membership.

## Modal focus

- The active modal traps Tab, suppresses background shell shortcuts, and restores its exact opener
  on close. Nested modals retain this ownership even when they close out of order. Anchored portaled
  controls belong to their containing modal's stacking, focus and logical tab order.
- A nested menu consumes Escape before its containing modal. Otherwise, Escape belongs to the
  topmost modal; an attributed extension request yields it only for projection-conflict recovery.
- Settings and Command Palette are mutually exclusive. An extension request takes modal ownership;
  Settings closes, while an open Palette stays mounted but hidden and inactive. Its preparation text
  and rejection remain available when the extension dialog closes.

## Preference persistence

- Changes patch only their own fields through a serialized write path. Concurrent preference,
  session-pin, folder-pin, and hide changes preserve one another.
- A refused write warns and rolls its fields back to the last Host-confirmed values. A newer local
  change retains ownership of its fields, including across a sequence of refused writes.
- Full snapshots returned by other operations apply only to fields whose local owner has not
  advanced since that operation began; deletion cleanup therefore preserves newer settings.
- Palette identifiers and their legacy migration follow [[design-system]]. Theme and palette changes
  own separate fields; resetting preferences returns to Chimonanthus with System luminosity.
- Missing stored fields receive migration defaults. For invalid fields, use defaults only for those
  fields; malformed JSON or a non-object root uses the full default projection. Preserve the saved
  file unchanged, warn during bootstrap, and refuse preference writes with a recoverable conflict
  until the user repairs or removes it.
- Every transient right-corner notice, including information notices, offers Copy and dismissal.

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
  sorted extension package names, update commands and release links. A check in progress disables
  copying the previous observation; clipboard failures stay in this section and can be retried.
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
  separately prevents duplicate clicks and shows `Pending` until Host execution is observed; HTTP
  failure or disconnection does not mark a running check finished.
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
24 behind the existing expansion entry; Collapsed shows only the group entry while retaining already
materialized children and local state. A per-card override leaves its saved default unchanged.

## Completion attention

Completion alerts are Off, Mark tab, or Desktop notification (`off | title | desktop`), defaulting to
Off. Desktop also records the tab marker, preserving attention after a notification disappears or
cannot be delivered.

- Only browser-observed live completion qualifies. An agent run owns its settlement; nested
  compaction cannot consume it. Standalone manual compaction owns its own end. Socket loss clears
  observed ownership.
- Snapshots preserve an existing arm only while the matching operation remains live; they never
  create one. Foreground selected work, bootstrap/history, and duplicate terminal events do not
  generate attention.
- The marker composes with an extension-set title. Viewing its session in a focused, visible tab or
  selecting Off clears it.
- A Settings gesture requests desktop permission. The result applies only while Desktop remains the
  latest choice; denial or an unavailable API warns without changing saved intent.
- OS notifications contain fixed outcome text, opaque session identity, and cwd-derived project
  metadata. Catalog titles are excluded because unnamed-session titles can contain first-message
  text. Clicking focuses the window and selects the owning session.

## Checks

Preference tests cover field ownership, refusal rollback, migrations, and invalid-file protection.
Settings and modal tests cover navigation, loading, menu dismissal, and focus restoration; Chromium
checks menu reachability and persistence. Update and attention tests cover their separate observation
lifecycles.
