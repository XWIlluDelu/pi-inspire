---
purpose: "Settings remain a bounded modal surface with field-owned persistence, independent activity-density controls, and truthful cross-browser update and completion observations."
covers:
  - shared/contracts.ts
  - server/{preferences,update-checker,pi-update-checker,update-coordinator}.ts
  - src/controllers/{preference,update,runtime-event}-controller.ts
  - src/{visual-preferences,update-availability,use-modal-focus}.ts
  - src/components/{Settings,SettingsDialog}.tsx
  - src/styles/settings-overlays.css
  - tests/server/{preferences,update-checker,pi-update-checker,update-coordinator}.test.ts
  - tests/web/{settings-navigation,settings-loading,notices,update-controller,attention,modal-focus}.test.ts*
---

# Interface preferences and completion attention

## Goal

Persist only the user-selected interface fields without stale rollback, invalid-file normalization,
or duplicated update authority. The shell entry point remains [[workbench]] and activity
presentation is detailed in [[activity-presentation]].

## Checks

### Settings, updates, and ordered persistence

- Persistent interface preferences live in a floating settings overlay opened from the topbar rather
  than consuming the session-navigation column. Its navigation groups are Display (theme, palette,
  content text size, shared transcript/composer reading width, project-location form), Conversation
  (reasoning detail, tool activity, activity groups, assistant-turn details, desktop send key),
  Behavior (launch routing, completion alerts), and Updates. Updates keeps Pi plus user-scoped
  configured extensions separate from INSΠRE: each has an explicit cache-bypassing check, concise
  current/available/unavailable state, and only a command or release link rather than installing,
  updating, or restarting anything.

  The first prompt successfully accepted by a Host deployment after 08:00 Host-local time each day
  invokes those same checks through their cache-aware path; the deployment persists that daily gate
  across restarts, while page startup, visibility, and fixed timers never initiate an update check.
  Pi checks use Pi's official latest-version endpoint and package manager observation; INSΠRE
  distinguishes a repository with no release from a failed check. Search is absent because this
  bounded surface does not justify a second retrieval mechanism; install-when-available, Pi/About,
  and Restore defaults remain quiet footer utilities. Restore patches exactly the twelve preference
  fields and leaves update observations, navigation curation, pane state, recent models, and other
  direct work state untouched.

  Settings fields remain inside their section at every supported width; explanatory copy yields
  space to its control and stacks above it on a narrow phone. Every modal overlay owns keyboard
  focus while open, cycles Tab within its surface, composes correctly when a newer modal appears
  above it, and restores the exact opener on close even when nested modals close out of order. An
  active modal suppresses background shell shortcuts; Settings and Command Palette never overlap,
  and a pending extension request dismisses either app-level overlay before taking focus. The
  central top-modal owner handles Escape, so an option-focused palette and a nested surface close
  only their own topmost layer; an attributed extension request yields Escape only for a
  projection-conflict recovery action.

- Preference persistence is field-scoped and ordered: each change patches only its own fields
  through a serialized write path, so rapid or concurrent changes — including pin, folder-pin, and
  hide updates — can never overwrite one another with stale full snapshots. A refused write emits a
  warning notice and rolls its own fields back to the last value the host confirmed rather than to
  whatever was on screen when it started, so a run of refusals cannot leave a control showing a
  value nothing persisted; any field a newer local change has since claimed belongs to that change.
  A full preference snapshot returned by another operation applies only to fields whose local owner
  has not advanced since that operation began, so deletion cleanup cannot repaint a newer setting.

  On startup, missing fields receive migration defaults. If a stored object contains invalid fields,
  valid fields are still projected in memory while only invalid fields use defaults; malformed JSON
  or a non-object root uses the full default projection. In every invalid case the exact saved file
  remains byte-for-byte unchanged, bootstrap presents a visible warning, and all preference-writing
  operations return a recoverable conflict until the user repairs or removes that file; unrelated
  changes can never normalize or overwrite it silently. Every transient right-corner notice,
  including informational notices, exposes Copy and immediate dismissal.

  The host checks update sources without sending session data or credentials, coalesces clients,
  caches results for six hours, and leaves local work silent when a source is unavailable. Available
  Pi, extension, and INSΠRE updates share one concise right-corner notice whose action opens
  Settings at Updates. Host-owned checking flags remain separate from browser HTTP request-pending
  flags: only Host snapshots/status events/results can change execution state. A request failure or
  transport loss cannot declare a still-running Host check finished; a pending request separately
  guards duplicate clicks and displays `Pending` until Host execution is observed. Update observations
  and the exact-set 24-hour snooze belong to the stable
  Host deployment rather than any browser origin: bootstrap and the authenticated event stream
  reconcile every local or forwarded view, closing the notice anywhere hides it everywhere, Host
  restart preserves the remaining interval, and any changed version or extension set bypasses the
  old snooze. Merely rendering a notice never consumes it.

### Independent activity density

- Activity-group, tool-card, and reasoning-card visibility preferences are independent and default
  to the persisted `dynamic` mode, labelled Adaptive in Settings. Their selectors put this
  recommended mode first, then fixed modes from most to least information: Activity groups use
  Adaptive, Expanded, Compact, Collapsed; Tools add Hidden; Reasoning omits Compact and includes
  Hidden. Activity-group option help states the materialization boundary: Expanded loads every card,
  Compact presents up to the latest 24 behind the existing expansion entry, and Collapsed presents
  only the group entry without discarding already materialized children or local state. Existing
  explicit stored strings keep their literal meaning; only the user-facing Dynamic label changes to
  Adaptive.

- Users can change the shared card default and can override an individual card without changing that
  saved preference.

### Completion attention

- Completion attention is an explicit `off | title | desktop` preference, presented as Off, Mark
  tab, and Desktop notification, and defaults off. Desktop is progressive rather than exclusive:
  every qualifying desktop notification also records the durable tab marker so the completion
  remains visible after the OS surface disappears or cannot be delivered. A marker and optional
  notification are derived only from a browser-observed live terminal transition: agent runs own
  their settle, nested compaction cannot consume that ownership, and a standalone manual compaction
  owns exactly its own end. Socket loss invalidates all observed ownership.

  Authoritative snapshots never create ownership; they retain an existing arm only while its session
  reports the matching operation still live, otherwise they retire it. Foreground selected work,
  historical/bootstrap status, and duplicate terminal events do not qualify. The marker composes
  with an extension-set title and clears when its owning session is viewed in a focused visible tab
  or attention is turned Off. Desktop permission is requested only by the Settings gesture, and its
  result applies only while Desktop remains the latest completion-alert choice. Denial or an
  unavailable API leaves saved intent unchanged while reporting the refusal through a warning
  notice.

  OS notification fields use fixed outcome copy, opaque session identity, and cwd-derived project
  metadata only; catalog title is forbidden because its unnamed fallback is conversation-derived
  first-message text. Clicking a notification focuses the window and selects the owning session.
