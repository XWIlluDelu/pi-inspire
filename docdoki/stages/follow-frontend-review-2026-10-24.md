---
scope:
  - src/App.tsx
  - src/components/{Transcript,TranscriptUtilities,SearchField,Nav,WorkspaceBrowser,BranchTree,ChangesPane,ContextPane,ContextSplitBody,AppTopbar,FilePreview,Notices}.tsx
  - src/store.ts
  - src/components/transcript-viewport.ts
  - src/styles/{foundation,navigation,responsive,transcript,composer,workbench}.css
  - tests/web/**
  - tests/browser/**
---

# Frontend review and local improvements

## Objective

Evaluate the complete external frontend review and its two sketches/four reference screenshots
against the current product. Implement useful local improvements within delegated authority;
follow the user's subsequent item-by-item visual decisions. Work stays on `auto-dev`; no release,
main-branch integration or remote deployment is part of this work. The user authorized updating
the existing local build without restarting its services.

## Decisions

The review's problem statements and priority labels are proposals, not measured acceptance criteria.
The reference screenshots are historical; the sketches combine independent states and are not
working interfaces. Current specifications and source support the following narrower disposition.

| Report item | Disposition and independent reasoning |
| --- | --- |
| 1.1 Desktop search | Implement on-demand Find in its existing reading-zone location, with Close and keyboard access. This reduces the idle search footprint without adding header controls or changing the reading measure. Find and an open search still temporarily overlap reading content. |
| 1.2 Title chevron | Leave as a proposal. The existing text-only title is an explicit choice in [[workspace-layout]], with menu semantics/focus handling. A small phone affordance could help discovery, but should be compared against title width and header density rather than called a missing implementation. |
| 1.3 Observation dock | Do not implement the proposed card/terminal actions. `App.tsx` already explains automatic recovery and displays the viewed model/effort. Clone makes an independent branch; it does not take control of an external Pi. A project shell cannot promise access to an arbitrary external terminal. A future direct action should say what it actually does and use existing readiness checks. |
| 2.1 Phone tools / Latest | Keep the current positions pending a coherent header/reading-tool decision. The reference phone header already contains navigation, identity, Git, palette, Settings and context; inserting two 44px targets would require a real priority tradeoff. Moving Latest to the edge shifts its overlap rather than proving a zero-obstruction reading area. |
| 2.2 Phone Changes | Implement list/detail drill-down, Back, previous/next comparisons and browser-history depth. This is a local navigation improvement, not a missing CSS selector: the previous contract explicitly retained the split. Keep desktop hierarchy, list state and per-comparison reading positions. |
| 2.3 Welcome directory | Keep current order. The screenshot shows a popover covering content, not demonstrated clipping or an unreachable control. Directory-first composition is a valid workflow alternative but not an established fault. |
| 3.1 Context straight edge | The user declined the boundary-only comparison. Keep the current desktop gutters, resize hit bands and rounded inset context pane. Do not add side-pane borders or square its corners. |
| 3.2 Global geometry / type | The user subsequently accepted the narrower radius scale and unfilled resource tabs with an underline. Preserve the existing Rajdhani tab labels, weights, uppercase/tracking and type sizes. Warm surfaces and content dominance are already current goals. Witness Bars and font replacement are not accepted. Current wordmark is IBM Plex Sans SC; Rajdhani is deliberately structural, so the report's claim that it primarily brands the wordmark is inaccurate. |
| 4.1 SearchField | Share clear/focus/loading presentation for Nav, Workspace and History while preserving their keyboard/query rules. Native search clearing already existed; the material gaps are consistent explicit access and Workspace's clear action disappearing during loading. Leave model/file pickers' distinct interaction contracts intact. |
| 4.2 Path copy | Fix the two missing `store.copyOwnership()` arguments. Both paths already share `useCopied`; context-specific feedback is explicitly retained by [[design-system]]. A new variant component would add API without solving another defect. Changes also benefits through its existing `PathCopyButton`. |
| 4.3 History alignment | Do not force a Files-style header. Changes has a repository summary, not a search bar; History uses whole-pane outline/detail navigation, not the Files split. Its Back target must retain phone touch size. Reuse search behavior through 4.1 only. |

The Changes index is bounded by `min(--files-index-default-size, 42%)`; 42% is an upper bound.
Do not quote the report's 310px/85%/650px estimates as measurements. Current desktop search geometry
also differs from the review's historical 228px/460px description. The implemented contract changes
are limited to [[conversation]], [[workspace-layout]] and shared search behavior in [[design-system]].

Browser acceptance also exposed related local boundaries: notices must follow Find when its
launcher is replaced and recreated; narrow Files must fit its existing 44px Back target inside the
detail header; Files/Changes navigation focus rings must stay inside clipped containers. These are
included as behavior and accessibility fixes without changing desktop panel geometry.

The long-transcript browser fixture exposed a pre-existing update-depth failure during a burst of
80 synthetic messages. An isolated unmodified baseline failed 2/10 repeats; the initial review tree failed
4/10. `measureLatest` repeatedly queued unchanged boundary state while external-store commits
arrived. A local ref now suppresses those redundant updates, without changing socket/store
delivery or scroll ownership. The isolated guarded build passed 10/10 repeats with all 80 events
applied and no reconnect, including a wait beyond the reconnect delay. No diagnostic instrumentation
is part of the product change.
This does not establish how often a real network would reproduce that scheduling pattern.

## Current state

The functional repair pass was committed as `489c78aa` and its local build was updated without
restarting the Host. The full review, original report and all six images have been read/viewed.
Read-only presentation, Welcome ordering and topbar action layout remain unchanged.

The user's subsequent visual selection accepts control/surface/overlay radii of 4/8/10px,
8px user bubbles and Composer, and unfilled resource modes with a 2px selected underline.
Keep the tab font family, weights, uppercase/tracking, count styling and all type sizes.
Existing monospace roles already cover code, paths, identifiers, commands and measurements;
the selection does not authorize broader font substitutions. The user declined new side-pane borders
and squared context-pane corners. The accepted refinements are implemented and verified within the
scope below; structural font comparison remains a preview, not an accepted replacement.

The visual previews use isolated mock content from the same local build, not the historical
review screenshots. Ordinary-browser and installed WCO layouts must be compared separately:
WCO hides the navigation lockup but retains its own titlebar identity. The corrected desktop
comparison activates the existing WCO rules with the repository test's 32px titlebar geometry.
The 390px phone preview triggers the existing <=420px two-row toolbar rule; a separate 430px
preview verifies all six tools share one row and the current/proposal Composer height is 101px.
These window/viewport differences are not proposed product changes.

Combined unit verification passes 19 affected suites / 224 tests. The browser acceptance
includes both mouse and touch layouts, path-copy feedback, search/IME/modal ownership, phone
list/detail history, two-sided changes, reading restoration and focus-ring clipping. A History error
layout fixture now uses a permanent 403 rather than a transient 503 whose retry budget exceeded its
assertion timeout. The CSS contract checker now recognizes the existing runtime window-scrim owner;
no theme value was changed to satisfy that check.

## Functional repair verification

These checks describe the initial repair pass before its separately authorized local build update.

- Biome format/lint, import-boundary check, TypeScript build, Knip and `git diff --check` pass.
- Vite production-mode compilation succeeds in a separate temporary output tree. The normal
  deployment `dist` and build activation metadata were not written.
- All 44 related Chromium browser cases pass across nine suites: Changes, transcript search,
  reading navigation, notices, History layout, attachments, compaction checkpoints, navigation
  selection and workbench shortcuts. Phone/tablet sizes and mouse/touch emulation are covered.
- The 80-message diagnostic passes 10/10 repeats with complete application and no reconnect.
  The committed browser check also verifies 79 ordinary matches plus the unique older match.
- Final 390×844 manual inspection measures a 712px diff scrollport and a 53px navigation row
  containing 44px targets and focus clearance. The list is hidden during detail reading; Back
  restores the selected row. No document-level horizontal overflow was observed. Shared narrow
  search text is 16px and explicit Clear returns focus to its input.
- Light/dark desktop and narrow screenshots were visually inspected. This is local Chromium
  acceptance with an isolated mock Host, not physical iOS/Android or live-provider validation.
- DocDoki privacy-boundary check passes. No main branch, tag, release or production activation
  belongs to this delivery.

## Accepted visual refinement verification

- The production CSS changes are confined to shared radii, the user bubble/Composer radius, and
  resource-mode surfaces/selection. Font roles, sizes, weights, uppercase/tracking, badge alignment,
  pane borders, responsive toolbar rows and WCO rules are unchanged.
- Isolated Vite compilation, Biome format/lint, `git diff --check`, and 49 existing style/palette/theme
  unit checks pass. The validation build does not activate the actual local `dist`.
- Twenty-two of 24 selected Chromium cases pass: four structural-label widths (1440/768/390/320),
  count alignment, narrow Composer controls and running focus, pointer/keyboard header and gutter
  behavior, installed WCO layout, and ten palette/luminosity combinations.
- The two remaining theme cases reach and pass the resource-tab selection/contrast checks, then
  expose an existing terminal danger-menu hover contrast gap: Chimonanthus dark measures 4.4526:1
  and Classic Amber dark 4.3276:1 against the 4.5:1 requirement. A separate run using the unmodified
  `489c78aa` CSS reproduces both exact values. Do not weaken the threshold or change unrelated
  palette values as part of the accepted visual scope; this remains a known accessibility gap.
- Theme verification now loads the shared menu CSS and renders the real session-action row; the
  old isolated fixture omitted both and asserted an obsolete button-owned hover surface. The
  product's session/terminal menu behavior was not changed.
- The local update uses the existing source installation and normal static build publication;
  no service restart, push, main integration, tag or release is part of this delivery. Build
  receipts and visual evidence are retained under `output/playwright/visual-preview-2026-10-24/`.

## Remaining decisions

The user may decide the remaining proposals separately: title affordance, phone tool placement/Latest,
Welcome directory ordering, observation actions and History header composition.
Existing structural type is retained while the user compares uppercase Rajdhani and Plex; that
font-only preview does not authorize a replacement. Pane-edge changes were declined after the
boundary-only comparison. No main/tag/release/push or service
restart is authorized by the local update request.
