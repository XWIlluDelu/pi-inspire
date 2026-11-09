---
scope:
  - src/**
  - tests/browser/**
  - docdoki/specs/design-system.md
  - docdoki/specs/interface-preferences.md
  - docdoki/specs/resource-preview.md
  - docdoki/specs/workspace-layout.md
  - docdoki/specs/composer.md
---

# Workbench interactions

## Objective

Keep conversation reading, resource inspection and settings controls consistent across desktop
and narrow layouts. [[design-system]], [[interface-preferences]], [[resource-preview]],
[[workspace-layout]] and [[composer]] hold the current design; this stage retains work state
and undecided proposals.

## Implemented

### Reading and navigation

- Desktop conversation search stays visible; Ctrl/Cmd+F focuses it and Escape blurs without
  clearing the query. Narrow layouts use the conversation's adjacent Search/Prompt Map launchers
  and expand search in the same tool row. The header has no duplicate search launcher.
  [[design-system]] records the contextual-tool and disclosure constraint; [[conversation]] owns
  query, focus and responsive continuity.
- Compact Activity headers, guides and status marks preserve reading typography, copy/disclosure
  behavior and touch targets. Alignment follows visible glyph/text bounds, not only element boxes.
  Mono labels retain intrinsic width; positive gaps separate the label, matrix and quieter summary.
  Activity and CodeMode peer metadata share middle-dot separators, with failure ink confined to
  the failed count.
- Session titles and metadata share a two-line hierarchy across desktop and drawers. Status shares the existing
  icon slot, so state changes do not narrow or move titles. Hidden uses the normal text axis
  without another nesting indent; trailing actions retain shared columns across pointer modes.
  Phone and touch drawers keep their persistent actions in a separate column. Welcome Recent
  shares the desktop radius and flat surface while retaining phone target sizes; assistant Copy
  now uses the same narrow/touch target as message Copy.
- Narrow path, search, picker, dialog and rename inputs keep their owner typography rather than
  a blanket 16px size. Composer honors Compact/Comfortable/Large at every width, with drafts and
  control targets preserved. Focused Chromium and Firefox flows cover the changed common surfaces
  and saved size choices; only the existing iOS-local sidebar exception remains.
- Files and History search retain compact 12.5px text and 13px icons at every width, including
  placeholders and focused editing, while preserving 34px desktop / 40px narrow control heights.
  Chromium and Firefox checks cover input/clear focus at 1280px, 820px and 390px; matched dark
  narrow-layout views confirm the typography change.
- Files, History and Changes share search/section spacing and readable row hierarchy. Recent uses
  its actual row count rather than reserving five empty slots. Folder actions retain visible
  keyboard focus; file-availability marks keep their own trailing slot.
- Source-backed Copy preserves authored Markdown destinations, display-math delimiters and
  complete source text. Inline math uses natural inline layout; wide blocks scroll locally.
- Constrained composer selectors retain the full Thinking label while long model names yield.
  Settings utility labels and keyboard outlines remain inside the 320px installation-state footer.

### Context pane

- Files, Changes, History and Terminal share one content area. Opened files and project terminals
  share the leading tab strip; fixed tool tabs trail it. Overflow keeps the active tab visible
  and reveals other tabs without reordering them or recreating terminal processes.
- Changes is a full-height list. Selecting a path opens its ordinary file tab in Git Changes mode;
  Files selects body mode on the same tab. Body and diff reads have independent availability and
  reading positions. Net HEAD-to-working-tree inspection replaces separate staged/unstaged modes.
  The API and browser state now identify only the path; legacy saved tabs and reading positions
  migrate at the storage boundary.
- File actions float above the reader and collapse on reading intent. Source/Preview, Git,
  change navigation, Copy path and Download keep their existing action order and availability.
  Terminal tools use explicit collapse; temporary search/selection overlays own the same corner
  without changing the user's saved tool state.
- Shared tab/control geometry, surfaces, neutral hover and focus follow [[design-system]].
  The desktop header stays stable while tabs load or appear. The 4px context gutter retains its
  centered 8px resize hit band; indicators are hidden at rest.
- Navigation retains its 460px manual maximum. The context pane may consume the remaining shared
  width budget while preserving the conversation reserve; default and saved widths remain intact.
- PDF uses continuous, virtualized pages with selectable static text. Page navigation, anchored
  zoom, per-page proportions and stable controls follow [[resource-preview]].

### Continuity and feedback

- The collapsed desktop rail and narrow navigation toggle share unread outcome counts, urgency
  and accessible descriptions. Expanded desktop navigation retains row-level status without a
  duplicate header badge. Component checks cover live updates, selection exclusion and count
  capping; deployed Chromium checks cover completion, failure/input, clearance, click containment,
  responsive parity and light/dark presentation.

- F5 restores browser-tab-local session/workbench navigation, file order/selection, tool choice,
  Files filters/expansions and independent Source/rendered reading offsets. Files are reauthorized
  and reread; missing files keep their tabs and errors. No file bytes, handles or HTML execution
  grants are persisted. Iframe-internal interaction and media playback retain separate lifetimes.
- Transport replacement retires content authority while retaining named tabs and directory
  navigation. Positional embedded-image references still retire. Held bootstrap does not flash
  the Welcome form before restoring the selected session.
- Refresh and bounded read recovery preserve confirmed content and reading positions. Routine
  selection/preparation feedback stays in existing controls. Invalid restart recovery data offers
  local repair; transient storage failures retry without discarding tracking.
  Renewed file handles restore rendered-reader offsets when the reader is recreated.
- Foreground image inspection survives both directions of the responsive workbench breakpoint.
  Back/Close retires the image before reconciling drawer history, preserving the underlying file.
- Ctrl/Meta+click shows an authorized file or directory in the Host's file manager.
- Carbon & Silicon is an optional neutral Light/Dark palette using the saved `mono` identifier.
  Existing defaults, syntax colors and palette migrations remain intact.

## Verification

Focused component and browser checks cover tab overflow/reuse, independent file offsets, F5 and
reconnect, Files query/expansion, net Git comparisons, terminal output/unfinished input, tool focus,
pointer/coarse targets and responsive containment at desktop, 390px and 320px widths.
Search checks cover directly available desktop input, in-place narrow expansion, local focus
return and query continuity across width changes; Chromium and Firefox both cover the default
state, expansion and keyboard flow. Reading fixtures include long URLs, tables, code, images,
math and large activity histories.
Matching isolated before/after views informed the accepted visual changes. Focused Chromium and
Firefox checks cover installable/installed footer states, long model labels and bidirectional
image-inspection resize; component and Chromium checks also cover modal Back/Close and native
extension-question cancellation.

The 2026-11-07 mobile consistency review passes 33 focused Chromium scenarios and 24 navigation/style
unit checks. It covers ordinary, pinned and Hidden rows, pointer/touch actions, status changes,
drawer dismissal, settings category access and message geometry. Isolated page comparisons include
320/375/390px phones, landscape and desktop, with light and Mono dark views. At 390px, the sampled
session title gains 26px by moving age below it without reducing the 36px action targets.
The follow-up review passes 11 focused Chromium scenarios for selected-tab containment, widget
Copy hit areas in short windows, landscape Settings safe areas and touch search across widths.
Tabs gain their own row before Close can be clipped; compact widgets include Copy in their height
budget. Overlay spacing now owns safe-area bounds, and touch search keeps full targets when
rotating or expanding both side panes.
These browser checks do not replace physical Android/iOS acceptance.

The 2026-11-06 review passes 27 Chromium scenarios covering composer continuity, connection
recovery, tab overflow/rename, saved-only history, PDF and resource reading. Source and rendered
refresh cases both retain their reading offsets; the new component regression fails before the
rendered-reader repair. Isolated production-mode builds leave shared deployment assets untouched.
[[follow-runtime-quality-2026-10-25]] records the full Linux checks. Physical-device font and
installed-window acceptance remain separate.

Linux file-manager acceptance uses the authenticated endpoint and acknowledged FileManager1 calls.
Native Finder/Windows desktop invocation remains unverified here. Physical notification and window
chrome acceptance remains in [[follow-runtime-quality-2026-10-25]].

## Undecided interaction proposals

These remain proposals, not implemented requirements:

- A command-palette entry that discovers existing actions without duplicating their policy.
- Discoverable keyboard access to thinking and slash-command choices, with IME-safe handling.
- Clearer attachment-upload progress that preserves durable retry and draft ownership.
- Visual differentiation of project groups.
- A quieter idle composer and less decorative chrome around short messages or reasoning blocks.

Assess each against its workflow before implementation. Preserve action availability, reading
behavior and the accepted layout. The separate holistic Files layout remains in [[file-browsing]];
it does not authorize a new left tree or split reader.
