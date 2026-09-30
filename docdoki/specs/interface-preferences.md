---
purpose: Settings organization, field-owned persistence, shared update observations, and completion attention.
covers:
  - shared/contracts.ts
  - server/{preferences,update-checker,pi-update-checker,update-coordinator}.ts
  - src/controllers/{preference,update,runtime-event}-controller.ts
  - src/{visual-preferences,update-availability,use-modal-focus}.ts
  - src/components/{Settings,SettingsDialog}.tsx
  - src/styles/settings-overlays.css
  - tests/server/{preferences,update-checker,pi-update-checker,update-coordinator}.test.ts
  - tests/web/{settings-navigation,settings-loading,notices,update-controller,attention,modal-focus}.test.ts*
  - tests/browser/workbench.spec.ts
---

# Interface preferences and completion attention

## Goal

Keep persistent preferences easy to find and save each change without overwriting newer intent.
[[workbench]] owns the shell entry point; [[activity-presentation]] owns card rendering.

## Settings organization

Settings opens from the topbar as a modal, leaving session navigation in place.

| Category | Controls |
| --- | --- |
| Display | Theme, palette, content text size, shared transcript/composer reading width, project-location form. |
| Conversation | Reasoning detail, tool activity, activity groups, assistant-turn details, desktop send key. |
| Behavior | Launch behavior, completion alerts, Pi delivery/compaction/retry, optional Herdr enhancement. |
| Updates | Separate Pi plus user-scoped extensions and INSΠRE checks, results, and actions. |

Pi controls follow [[pi-integration]]. Herdr takes effect on Host restart under [[herdr-enhancement]].
Install-when-available, Pi/About, and Restore defaults remain footer utilities. The bounded category
navigation has no separate search.

Restore defaults patches the complete interface-default set, including Herdr. It leaves Pi runtime
settings, update observations, navigation curation, pane state, recent models, and other direct work
state unchanged.

Fields stay within their sections; explanatory copy yields to its control and stacks above it on
narrow phones. Open menus can extend beyond a card without clipping. Disabled controls remain
legible and visually distinct from selected, available controls.

## Modal focus

- The active modal traps Tab, suppresses background shell shortcuts, and restores its exact opener
  on close. Nested modals retain this ownership even when they close out of order.
- A nested menu consumes Escape before its containing modal. Otherwise, Escape belongs to the
  topmost modal; an attributed extension request yields it only for projection-conflict recovery.
- Settings and Command Palette are mutually exclusive. A pending extension request dismisses either
  app-level overlay before taking focus.

## Preference persistence

- Changes patch only their own fields through a serialized write path. Concurrent preference,
  session-pin, folder-pin, and hide changes preserve one another.
- A refused write warns and rolls its fields back to the last Host-confirmed values. A newer local
  change retains ownership of its fields, including across a sequence of refused writes.
- Full snapshots returned by other operations apply only to fields whose local owner has not
  advanced since that operation began; deletion cleanup therefore preserves newer settings.
- Missing stored fields receive migration defaults. For invalid fields, use defaults only for those
  fields; malformed JSON or a non-object root uses the full default projection. Preserve the saved
  file unchanged, warn during bootstrap, and refuse preference writes with a recoverable conflict
  until the user repairs or removes it.
- Every transient right-corner notice, including information notices, offers Copy and dismissal.

## Update observations

- Explicit checks bypass the cache. Results offer commands or release links; Host/Restart all use
  the confirmation and execution rules in [[host-lifecycle]].
- The first accepted prompt after 08:00 Host-local time each day invokes cache-aware checks. The
  deployment persists this daily gate across restarts. Page startup, visibility, and timers do not
  initiate checks.
- The Host coalesces clients and caches results for six hours. Checks send no session data or
  credentials; an unavailable source leaves local work quiet. Pi checks use its official latest
  endpoint and package-manager observation. INSΠRE distinguishes no published release from a failed
  check.
- Available Pi, extension, and INSΠRE updates share one notice that opens Settings at Updates.
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
lifecycles. Review evidence: [[follow-interface-review-2026-09-29]].
