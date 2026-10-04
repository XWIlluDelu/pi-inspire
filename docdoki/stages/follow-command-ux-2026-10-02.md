---
scope:
  - shared/commands.ts
  - shared/contracts.ts
  - src/**
  - server/**
  - tests/**
  - docdoki/specs/{composer,workbench,pi-integration}.md
  - docs/pi-commands.md
---

# Command usability refinement

## Outcome

The optional palette, first-layer argument assistance, export/download and help are implemented.
[[follow-pi-native-capability-review-2026-10-02]] tracks remaining native coverage.
Contracts: [[composer]], [[workbench]], [[pi-integration]]. Shell execution is recorded separately in
[[follow-shell-input-2026-10-02]].

- The palette opens from the topbar or Ctrl/Command+K at every width, without a duplicate sidebar
  entry. It starts with a compact set of actions and recent sessions. Exact titles/aliases retain
  priority; literal task words in descriptions outrank weak name-only subsequences. Duplicate native
  destinations share aliases. Find a session
  and `/resume` focus the existing full sidebar catalog search, including from the start surface.
- Graphical actions open their controls. Export uses the shared format/download dialog; resource
  commands and Compact use transient preparation with `ComposerInput`. Both preserve message
  drafts/artifacts on success and rejection.
  The seeded invocation's initial caret sits after its trailing space; later edits keep their own
  selection. Editable command text determines dispatch: extensions run immediately; templates/skills expose
  genuine Steer/Queue. Escape returns to search. The palette field searches actions, not invocations.
- Composer offers `/model` and supported `/thinking` candidates, inserting rather than submitting.
  Free-text arguments have usage hints; resource prompts retain inline path search. Pi's public RPC
  omits extension completion callbacks/template argument hints, so no candidates are guessed.
- Typed `/export` keeps Pi's HTML default, single quoted/unquoted path parsing and exact `.jsonl`
  suffix rule. HTML contains the whole tree; JSONL contains the active ancestry and original native
  entries, including images, Bash flags and extension metadata. Source aliases are refused.
- Download receipts bind opaque authenticated IDs to generated private snapshots and their session.
  Subsequent output-file changes cannot alter a download; expiry/eviction or Host restart requires
  another export. Storage allocation failure is retryable and every acquired source handle closes.
- Shortcut help describes actual browser/IME/touch/history/completion/terminal controls. Changelog
  loads the installed Pi version's matching release notes through the safe Markdown renderer.

Picker focus transfers only after the palette releases its modal ownership. This resolves the observed
hidden-portal focus failure and opener restoration stealing focus; picker opening/search/Escape retain
one focus owner.

## Evidence

- Focused command, palette, Composer, model/branch, runtime and authenticated export/resource tests
  passed. The corrected catalog handoff covers active/start surfaces, unloaded search results, narrow
  drawer mount and retained draft/artifacts. Generated-export tests cover directory-failure retry,
  source-handle lifetime and immutable authenticated downloads.
- Installed Pi **1.0.0**, explicitly selected with `INSPIRE_TEST_PI_COMMAND`, passed
  `tests/server/{generated-exports,session-export.integration,pi-native-command-inventory}.test.ts`.
  The isolated export fixture compares native JSONL serialization, whole-tree HTML and unchanged source
  bytes/worker state; it uses no network model. The current regression also checks incremental entry
  reads and export before source materialization. A separate installed-Pi probe exported a 37.7 MB,
  600-entry session in 26 ms while keeping its worker available; the former aggregate `get_entries`
  reply exceeded the RPC frame cap and retired that worker.
- Fresh-build `tests/browser/command-ux.spec.ts` passed in Chromium at 1280×900 and 390×844 touch widths:
  ranked discovery, focused catalog/picker handoffs, command preparation, native argument insertion,
  template Queue, IME/touch Return, shortcut/release-note scrolling and a downloaded/parsed JSONL file.
  Drafts and uploaded files survive these flows; scoped Axe checks had no serious/critical findings.
  These recorded UI runs used Pi 0.87.0 fixtures; installed-Pi authority comes from the preceding gate.
- Browser regressions cover `cost` → Session information, immediate typing after a seeded command,
  selected `@` path → typed prose, and the New session action at desktop/390px touch widths.
- With 1,080 native-catalog model candidates, bounded completion rendering reduced added DOM nodes
  from 4,324 to 45. Three production Chromium measurements changed input-to-second-frame latency
  from 62–113 ms to 25–30 ms; at 4× CPU slowdown, 379–423 ms became 29–30 ms. The browser regression
  covers keyboard insertion beyond the initial view, exact filtering/Tab and 320px scroll/click.
- Typecheck and scoped lint passed at acceptance. Screenshots remain under
  `output/playwright/command-ux-*`; their version label reflects the browser fixture's Pi installation.

## Unassigned refinements

The following presentation proposals remain undecided:

- Preparation currently adds a confirmation to every resource command, even extensions that need
  no arguments, and to plain compact. Narrow preparation to operations needing editing or choice.
- Low-frequency actions lack a visible, understandable browse route. Typing `/` already reveals
  the full palette inventory, and Composer `/` lists commands. Evaluate a visible lightweight browse
  route without restoring the crowded default list.
- The prepared editor uses fixed Ctrl/⌘+Enter while ordinary Enter inserts a newline, unlike the
  default Composer. Make that interaction evident and consistent where appropriate.

The palette searches actions/sessions; `/model openai` is not an executable palette invocation.

## Remaining scope

Generic extension argument completion needs a native interface or explicit adapter. Settings and
statistics have been reviewed; their remaining gaps are in
[[follow-pi-native-capability-review-2026-10-02]]. `/import`, `/share`, `/bug` and `/trust` remain
guidance-only. Login/logout, Clone and common models have graphical routes.
