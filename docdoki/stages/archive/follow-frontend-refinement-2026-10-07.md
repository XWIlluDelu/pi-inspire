---
scope:
  - src/components/
  - src/styles/
  - src/{source-diff,file-icons,syntax-highlighting,palette-search,store,snapshot-transition}.ts
  - shared/contracts.ts
  - tests/web/
  - tests/browser/
  - docdoki/specs/{workbench,conversation,workspace-layout,activity-presentation,resource-preview,model-settings,interface-preferences,design-system,terminal,composer,session-branches}.md
---

# Frontend refinement outcomes

## Outcome

Completed. All retained local groups, including the final focused Models editors, are accepted.
The completed overall review is recorded in [[challenge-release-round-quality-2026-10-11]].

The work refined the existing Pi GUI rather than replacing its reading controls, activity language
or data ownership. [[design-system]] owns shared presentation; surface specifications own behavior.

## Retained results

| Area | Final result and contract |
| --- | --- |
| Reading and activity | Floating Search, Prompt Map and bottom-centered text Jump to latest remain. Double activity rails, tool/Thinking segments and middle dots remain; collapsed bands have one native-button Tab stop, while open boundaries operate independently and restore focus without scrolling. [[conversation]], [[activity-presentation]] |
| Settings and Models | Main and Terminal settings use category views with one narrow selection underline. Main pages preserve browsing state, drafts and login while hidden; ordinary fields wrap by available space. Models uses Common checkboxes, Default radios and explicit Via rule editing, with full-list keyboard reachability. Focused provider/model editors keep Save/Cancel reachable and restore query, disclosure, scroll and focus on return. [[interface-preferences]], [[model-settings]], [[terminal]] |
| Composer and Pending | File chips emphasize names and upload/error state. Pending retains 0.75 idle dimming, interaction emphasis without a second button-opacity layer, one total and truthful mode labels. Header actions are Copy/Return/Clear; the existing activity count jumps to and focuses Pending. Narrow Model labels shrink to preserve Thinking adjacency; Stop stays filled red. [[composer]] |
| Search and identity | File search, explicit pickers and inline completion share file-type icons, parent captions and match emphasis. Same-line picker directories use @. Session/Terminal parent hints disambiguate matching or colliding projects; cross-project session capsules remain. Selector IDs stay visible even when identical to names; only Settings deduplicates exact name/ID pairs. Palette titles and secondary hints use their distinct match weights. [[design-system]], [[model-settings]], [[session-continuity]] |
| Shared controls | Neutral stroke roles, native checkbox/radio skin, content-action visibility and role-based quiet buttons are consistent across surfaces. Markdown task markers retain their original baseline and normal opacity. Touch-first model/palette/file choosers focus a non-editable panel until search is requested. Directory selection uses an editable, soft-wrapping path; Welcome retains its single-line input. [[design-system]], [[workbench]] |
| Files and Changes | Source readers share an unframed full-width canvas and sticky gutters. Changes retains revision-correct highlighting, addition/deletion tints and the active edge. File-type icons and tree-leaf alignment are shared; new diffs land at the first change and preserve pane-scoped reading/navigation state on revisits and reloads. [[resource-preview]] |
| History | Summary configuration precedes same-session actions within the fixed action dock. Quiet Activity disclosures and one framed Shell record expose literal command/output, semantic status, Copy and authorized full-log access. Ordinary rich content remains unchanged. [[session-branches]] |
| Terminal | Compact toolbar/profile creation preserves direct default creation where appropriate. Touch keys use complete snapped slots with all four arrows fixed in a trailing group; the 53px strip height remains. Profile and More share native disclosure exclusion. Status/transport colors and terminal ownership remain unchanged. [[terminal]] |
| Information states | Shared empty/loading/error states use unfilled icons and weight-500 titles, with larger conversation emptiness explicitly scoped. Release-note recovery and complete shortcut notation follow the same control language. CodeMode Calls use conversation scrolling; compaction metrics distinguish Pi context from Magic Context historian chunks. [[design-system]], [[tool-presentations]], [[conversation]] |

Independent functional repairs remain:

- Settled provider-login outcomes supersede earlier request errors and late responses.
- Welcome directory editing cannot implicitly create a session with Enter.
- Same-session file selection survives prompt/view updates by reauthorizing the named resource;
  incompatible session/workspace or embedded-image identity changes still clear it. HTML reauthorization
  releases execution and returns to static viewing.

## Decisions that constrain later design

- Keep frequent Pin/Hide directly available on narrow/touch rows; an overflow menu adds friction
  to ordinary session curation.
- Welcome's bordered directory input is editable, not redundant framing. Its position below the
  toolbar keeps the first message primary; data dependency does not impose directory-first layout.
- Keep the topbar project location as plain text with existing copy feedback; no added folder glyph.
- Preserve the fixed Files index/detail layout and Recent allocation. The rejected content-sized
  index/full-body narrow preview did not justify replacing this shared geometry. Hiding unavailable
  Source/Preview actions and removing Notebook Markdown gutter labels remain independent cleanups.
- Retain original cross-project session capsules: they separate project identity from title/age.
  Parent-query hints and file-picker directory cues remain independently useful.
- Keep ordinary standalone PWA chrome; window-titlebar fusion was withdrawn, not deferred work.
- Image-copy capability is separate from the three action-presentation types; missing image copying
  does not create a fourth visibility type.

## Evidence

Focused component/style and desktop/touch Chromium checks cover keyboard ownership, asynchronous
state retention, long content, selection/copy payloads and the changed layouts. Matched light/dark
captures and narrow checks were inspected. The directories below preserve representative final
comparisons; specifications and the semantic test suites retain the regression contracts.

| Area | Local visual evidence under `output/playwright/` |
| --- | --- |
| Settings and Models | `settings-refinement/`, `models-editor-refinement/`, `models-refinement/` |
| Composer/Pending and action visibility | `composer-hierarchy/restored-*.png`, `pending-navigation/`, `action-presentation/` |
| Files/Changes readers and navigation | `source-readers/`, `files-changes-navigation/`, `changes-readability/` |
| History Shell record | `history-refinement/integrated-shell*.png`, `history-refinement/integrated-comparison.png` |
| Terminal controls and location context | `terminal-refinement/snap-comparison.png`, `terminal-parent-context/` |
| Shared strokes, choices and touch focus | `line-tokens/`, `markdown-choices/`; chooser focus is covered in the model/palette/file-picker browser suites |
| Search and information states | `navigation-search/`, `palette-hint-matches/`, `pane-states/`, `release-note-states/` |
| File-selection continuity | `preview-continuity/` |

Some earlier after-captures show withdrawn experiments, not retained design: Welcome directory-first
layout, topbar location glyph, cross-project caption replacement and picker ID deduplication.
The retained baseline is described above and in the contracts, not by those images.

## Continuation

- [[challenge-release-round-quality-2026-10-11]] records the holistic quality review of the accepted
  interface alongside the whole Pi 1.0 core/native round.
- [[follow-pi-native-capability-review-2026-10-02]] owns unimplemented image copying and effective
  paste verification, including reverse input order when copying multiple images separately.
- [[follow-file-browsing-experience-2026-08-24]] retains Notebook kernel-name inference and deferred
  Files design questions. [[follow-native-command-surface-2026-09-04]] owns the compact-success
  receipt proposal and its required transcript inventory.
