---
scope:
  - src/**
  - shared/{commands,contracts,model-settings,tool-presentation-config}.ts
  - tests/web/**
  - tests/browser/**
---

# Pi workflow interface and browser evidence

## Scope and current surface

The interface retains Amber/Jade themes and existing typography, keeps routine controls compact, and
reveals configuration details on demand. The table maps the current surfaces to their owners;
contracts hold detailed behavior. Known quality findings remain in
[[follow-native-workflow-quality-2026-10-03]], and missing native adaptations in
[[follow-pi-native-capability-review-2026-10-02]].

| Surface | Current behavior | Main implementation |
| --- | --- | --- |
| Settings | Categories navigate one continuous document; aligned fields and shared controls. System orders Pi, Extensions and Inspire, with inline Pi links, copyable update commands and two danger-styled restart actions. | `Settings.tsx`, `SettingsControls.tsx`, `SystemVersionsCard.tsx` |
| Models | Bounded available-model list with Common/Default row actions and default results immediately below; separate Login & API keys and collapsed Custom providers sections. | `ModelsSettings.tsx`, `ModelList.tsx`, `ModelDeclarationForms.tsx` |
| Credentials | Saved-provider management, discovery and login occupy one view at a time; Back retains query/focus. Positively identified remote methods have on-demand help. | `ProviderAuthentication.tsx` |
| Terminal settings | Appearance, Interaction and Saved output share field/header styling. Browser defaults remain separate from Host output/retention. | `TerminalSettingsDialog.tsx`, `SettingsControls.tsx` |
| Scrolling | Shared thin, theme-aware native scrollbars; terminal matches their visual treatment without changing scroll ownership. | `scrollbars.css`, `terminal.css` |
| Mobile surfaces | Opaque drawer/sheet entrances, darkening navigation scrim, and stable Settings/Context shells through deferred loading and failure. | `App.tsx`, `ContextPaneShell.tsx`, `SettingsDialog.tsx`, `responsive.css` |
| Session identity | Title-owned Rename/Clone/Export, same-point Rename entry, left-aligned identity/Git/status, right-aligned global controls at every width. | `AppTopbar.tsx`, `SessionActionsMenu.tsx`, `Nav.tsx` |
| Extension status | Topbar text at every width, with full reading by pointer/touch/keyboard when truncated. | `ExtensionDisplays.tsx` |
| Session search | Name/path/ID and retained text, Pi-style matching and keyboard result selection. | `NavSessions.tsx`, `session-catalog-controller.ts` |
| History | Prompt-led outline, complete paged/cross-branch inspection, independent copy actions, optional continuation summary and authorized resource previews. | `BranchTree.tsx`, `branch-controller.ts`, `EarlierBranchBanner.tsx` |
| Composer/Pending | Compact input, overflow-only Expand with no resting gutter; equal-width mobile Steer/Queue, head/tail Pending text and clickable image thumbnails, complete Copy, Return/Stop image recovery and explicit Clear confirmation. | `Composer.tsx`, `Transcript.tsx`, `transcript-rows.tsx`, `composer-controller.ts` |
| Drafts/references | Tab-local text drafts, retained pre-compaction prompt history and committed inline references while prose continues. | `ComposerInput.tsx`, `composer-completion.ts`, `session-drafts.ts` |
| Palette/help | Topbar or Ctrl/Command+K at every width, without a duplicate sidebar entry. Task search and draft-independent preparation; shortcuts and installed release notes share Help. | `CommandPalette.tsx`, `CommandHelp.tsx`, `App.tsx` |
| Export | Title menu and palette open the same independent format/download dialog. | `ExportDialog.tsx`, `App.tsx` |
| Context/shell | Read-only occupancy hint preserves percentages above 100%; native shell output streams and retains access to full logs. | `Composer.tsx`, `BashExecution.tsx` |
| Extension content | Standard keyboard/deadline dialogs; readable attribution/text first, raw identifiers in inspection. | `ExtensionUiDialog.tsx`, `CustomMessage.tsx`, `ExtensionDisplays.tsx` |
| Availability/failure | Effective retry state, recheckable unavailable-Herdr enablement, and one stale notice for retained Git results including clean/non-repository state. | `store.ts`, `HerdrSettings.tsx`, `ChangesPane.tsx` |

Component paths are under `src/components/`, controllers under `src/controllers/`, and styles under
`src/styles/`. Contracts: [[workspace-layout]], [[interface-preferences]], [[model-settings]],
[[composer]], [[session-branches]], [[pi-integration]] and [[design-system]].
Usage: [Pi commands](../../../docs/pi-commands.md).

## Recorded verification

- **Input, commands and History:** fresh Chromium desktop/narrow flows covered retained drafts,
  reference completion/restoration, prepared-command completion through extension dialogs, same-point
  Rename, Clone, image recovery/resend, History resource retry and Escape ownership. Delayed Rename
  responses preserve subsequent typing in desktop and touch flows. Both Export
  entries downloaded HTML/JSONL while retaining the draft. Native Pi 1.0 checks established export
  content, unchanged source state and no generated project files for graphical export.
- **Models and settings:** component/controller checks covered owner-bound configuration/auth state,
  repeatable auth receipts, row actions, focus return and continuous category navigation. Browser
  checks covered provider/model editing, login navigation, preference readback, compact rows/equal
  action widths, copyable update commands, restart controls and browser/Host terminal settings.
  [[follow-model-settings-auth-2026-10-02]] retains the bounded-catalog workload and measurements.
- **Responsive reading:** actual light/dark pages were inspected at desktop, 540px, 390px and 320px,
  including expanded controls, Help, Pending, long titles, status disclosure and Settings footer.
  Touch status expansion included keyboard overflow reading and accessibility checks. Relevant images
  are under `output/playwright/model-refinements/` and the topic stages' evidence paths.
- **Picker interactions and alignment:** settings search/refresh keeps models unchanged and avoids
  automatic first-row highlighting; pointer and keyboard candidates use distinct interaction states
  with one shared tint. Project files anchor to their trigger and dismiss outside/Escape; floating
  preference menus stay clickable beyond the Settings scroll boundary. Desktop/touch browser checks
  cover these paths, stationary-pointer keyboard navigation, thumbnail viewing, and mobile delivery
  geometry. Light/dark card checks cover wrapped attribution, Copy centering, and compact-label
  alignment without changing control height. Evidence: `output/playwright/ui-alignment/`,
  `output/playwright/pending-thumbnails/`, and the related browser suites.
- **Mobile surface loading:** Light/Dark 390px frame captures verified opaque entrances, one context
  shell across cold loading, and no bright scrim or replayed entry. Local Settings cold readiness
  changed from about 329ms to 55–58ms after removing the committed-fallback retry wait; warm opening
  takes one extra frame. A held 600ms module response still exposes truthful loading. Focus handoff,
  failure/reload, reduced motion, 844×390 landscape, and nested terminal Escape checks passed.
  Evidence: `output/playwright/mobile-drawers/` and `tests/browser/loading-states.spec.ts`.
- **Scrollbars:** Amber/Jade light/dark checks covered a 320px picker, native wheel/drag/keys,
  horizontal code scrolling, terminal dragging and high contrast. Images are under
  `output/playwright/scrollbars/`. Chromium scrollbar screenshots require omitting the default
  `--hide-scrollbars` launch argument; otherwise working scroll areas appear without scrollbars.
- **Boundaries:** native preference/authentication checks used installed Pi 1.0 and isolated roots,
  synthetic providers and callbacks, not live-account login. Typecheck/build and relevant
  component/browser regressions passed for the recorded checks. The quality stage records the final
  default-suite and release verification.

Complete loaded-extension names remain unavailable from Pi 1.0 RPC. The requested inventory is
recorded in [[interface-preferences]], not as permanent page help.
