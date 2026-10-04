---
scope:
  - server/{model-settings*,provider-auth*,model-catalog,app,index,runtime,runtime-worker-lifecycle}.ts
  - server/extensions/{inspire-branch-bridge,provider-auth-bridge}.ts
  - shared/{contracts,commands,model-settings,provider-auth-bridge}.ts
  - src/{App,api,app-state,store,model-options,use-modal-focus}.ts*
  - src/components/{Settings,SettingsSection,ModelsSettings,ModelDeclarationForms,ProviderAuthentication,ModelSelector,ModelList,Composer,Welcome,CommandPalette,CommandHelp}.tsx
  - src/styles/model-settings.css
  - tests/{server,web,browser}/*model*.test.ts*
  - tests/server/provider-auth*.test.ts
  - tests/browser/model-settings*.spec.ts
  - tests/browser/fixtures/{model-scale.ts,workspace.mjs}
  - tests/web/fixtures/model-menu-layout.ts
  - tests/web/provider-authentication.test.tsx
  - scripts/start-browser-test-host.mjs
  - playwright.config.ts
  - docdoki/specs/{model-settings,interface-preferences,composer,pi-integration}.md
  - docs/pi-commands.md
---

# Model configuration and provider login

## Objective

Implement [[model-settings]]: native defaults and common models, graphical provider/model declarations,
and provider login. Keep configuration independent of authentication and selection distinct from creation.

## Current state

Native defaults/common scope, graphical declarations and provider login are implemented. The checks
below establish configuration and interaction behavior; remaining native adaptations and quality
findings are tracked in [[follow-pi-native-capability-review-2026-10-02]] and
[[follow-native-workflow-quality-2026-10-03]].

## Implemented behavior

- Settings orders Models, Login & API keys, then Custom providers. The available-model list and
  default results share one section; credentials and collapsed declarations remain independent.
  [[model-settings]] specifies the layout and controls.
- Default/common candidates use Pi's current availability. Saved unavailable identities remain visible,
  and declarations remain editable. The picker shares virtualized rows with Settings; full displayed
  provider/model IDs, including IDs containing slashes, are searchable. The list contracts for few results.
- Exact common entries, including thinking-effort suffixes, toggle directly. Pattern-covered entries
  expose their source rules in expanded details. Native patterns retain dynamic matching and order.
- Provider/model forms use the native schema, preserve untouched fields and credentials, and keep
  connection overrides secondary. A missing model API appears as a required field when not inherited.
  Drafts belong to their creation/edit target; errors appear in the active form. Creation continues at
  Add model or the newly available model's row; Cancel and saved row actions preserve keyboard continuity.
- Configuration supports native JSONC/BOM, symlinks, locking and conflicting-edit detection. A committed
  write remains successful if optional refresh fails. Availability refresh leaves the current model intact.
  New → Manage models carries the prospective project directory; existing sessions retain their owner.
- Native defaults, project overrides and common-cycle order remain distinct. Cached next/previous-model
  and thinking-cycle actions preserve gesture order within an owner; editors, IME and overlays retain
  keyboard priority. [[follow-model-selection-2026-10-02]] records the selection work.
- `/login`, `/logout` and `/scoped-models` reach the corresponding controls. Native API-key and interactive
  login callbacks use the installed worker's current provider definitions, including extension changes.
  Remote-login help follows supported method provenance. Attempts and prompts retain their worker/owner
  identity; cancellation, supersession and transient status failures preserve the current attempt's state.
  Completion refreshes credentials and model availability. Stored secrets are omitted from projections.

## Verification

### Native and component behavior

- Installed Pi 1.0 checks in `tests/server/{model-settings,provider-auth,provider-auth-bridge.integration}.test.ts`
  cover configuration round trips, defaults/project precedence, typed identities, dynamic patterns,
  unrelated fields, invalid/conflicting files, symlinks, JSONC/BOM and committed-write readback failures.
- Native auth checks exercise API keys, method selection, device/manual/redirect callbacks, supersession,
  cancellation, removal and secret-free projections. Remote-help checks include extension replacements
  and reused method IDs. A real RPC fixture persists a synthetic key and changes same-worker availability
  without changing the PID, session, current model, thinking or entries.
- Component checks cover form identity, field order, missing/inherited/custom API types, form-local errors,
  focus after save/cancel, later focus moves, common/default writes, prospective and retired owners,
  catalog adoption, polling recovery, cached cycles, modal navigation and full-ID search/copy.
- Production-GUI/native API-key checks recovered from a status 503 without restarting login, and
  from a lost cancellation receipt through polling to Login cancelled. Both pre-session and worker
  owners returned repeatable completed receipts. Native behavior-setting persistence feedback remains a separate open interface gap.
- Browser and native authentication tests use synthetic credentials and callbacks, not real accounts.

### Browser interaction

Fresh-bundle Chromium checks at desktop and 390px cover picker and command destinations, the three-part
layout, provider → model → Common/Default, thinking, login completion/removal, project ownership and
preserved drafts/current-model selection. Keyboard, IME and touch help are covered. Representative
Settings and login screenshots were inspected; no serious/critical accessibility findings were reported.

A separate browser check used the real isolated Host and installed Pi 1.0 settings/auth routes. It saved
provider and model declarations, selected Common/Default and thinking, and verified provider/model/row
focus, Cancel return, required API feedback and full-ID search. The single-result list measured 132px at
390px width, without horizontal overflow. This supplements the deterministic browser fixture's UI checks.

### Large-list behavior

`tests/browser/model-settings-scale.spec.ts` uses a native catalog fixture with 1,532 catalog models and
1,074 available models after synthetic credentials. The picker initially mounted 10 model rows, Settings
7; the observed peak was 11, with at most 14 added in one mutation batch. End, ArrowUp and search reached
the final models. Unavailable catalog entries were excluded.

| Operation | Desktop | 390px touch |
| --- | ---: | ---: |
| Picker open | 80 ms | 58 ms |
| Picker End | 32 ms | 29 ms |
| Picker search | 70 ms | 70 ms |
| Settings End | 51 ms | 40 ms |
| Settings search | 33 ms | 41 ms |
| Settings grid | 560 × 340 px | 320 × 340 px |

These are operation-to-settled-frame measurements on the isolated Chromium fixture. The fixture makes
no model requests. Evidence is in `output/playwright/models-scale-{desktop,touch}.json` and the matching
picker/list screenshots.

## Supported boundaries

Provider login requires Pi's native authentication APIs. Declaration and default configuration remain
independent of login availability. The graphical editor exposes common declaration fields and preserves
advanced native-file settings. Changed Host environment follows the ordinary Host lifecycle.
