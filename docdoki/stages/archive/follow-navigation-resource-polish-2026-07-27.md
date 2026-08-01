---
scope:
  - shared/contracts.ts
  - shared/resource-references.ts
  - server/app.ts
  - server/preferences.ts
  - server/project-files.ts
  - server/resources.ts
  - src/api.ts
  - src/store.ts
  - src/components/Nav.tsx
  - src/components/ResourcesPane.tsx
  - src/resources.ts
  - src/styles.css
  - tests/server/**
  - tests/web/**
---

# Navigation and resource polish

Closed 2026-07-27 in one round. Long-lived navigation became curatable and
dense, the recent-file list became a bounded honest projection, and missing or
ambiguous references became recoverable instead of silently wrong.

## Outcome

- Curation is preference-only. `pinnedProjectCwds` and `hiddenSessionIds` join
  `pinnedSessionIds` and `navCollapsedGroups` in the preference schema, and
  `POST /api/sessions/pin` was deleted: every curation change is one
  field-scoped `PATCH /api/preferences`, which makes pin/hide mutual exclusion
  atomic and lets one rollback path serve every control. `SessionSummary.pinned`
  and the unused `PreferencesStore.update(mutator)` went with it.
- Navigation partitions into individual pins, pinned folders, ordinary folders,
  and Hidden, with precedence hidden > individual pin > folder pin, so a session
  files into exactly one section. Folder pins use the exact cwd identity that
  already defines groups and collapse. Curated identities hydrate past the first
  catalog page: pinned and hidden ids through `/api/sessions/by-id` (cap raised
  to 600) and pinned folders through `/api/sessions/by-cwd`, bounded to the
  newest 40 per folder, so a folder pinned as a whole cannot vanish because none
  of its sessions is recent.
- An ordinary row is one dense line (28.1px, down from ~40px) carrying a single
  number: the title at the left and a compact activity age right-aligned in a
  fixed 46px column, with the owning project shown only where a section crosses
  folders. Folder headers drop to a lighter type tier and put their session
  count in that same 46px column, so counts and ages read down one rule; the
  exact timestamp and the message count are tooltip facts. Pin and hide occupy
  exactly that column on hover or focus — nothing moves — and under
  `hover: none` they take their own space beside the age. Hidden is a drawer:
  closed by default, opened on demand, and search reveals matching hidden
  sessions inside it rather than returning them to their folders.
- Optimistic writes stay truthful: `savePrefs` applies locally, persists in the
  serialized queue, and on refusal restores the last host-confirmed value for
  the fields no newer local change has claimed (reference-equality test), then
  reports the failure. Restoring the pre-write screen value instead would show
  an unpersisted preference whenever two writes fail in a row.
- The files pane is a bounded recent-first projection: `MAX_RESOURCE_ROWS = 8`,
  with the walk in `collectSessionResourceReferences(messages, limit)`
  short-circuiting from the newest message; authorization callers stay
  unbounded. At the cap the pane says what it is showing instead of implying
  the rest is gone.
- A bare name resolves through the owning workspace's project index only on
  exactly one basename match, and the descriptor reports the path actually
  opened; several matches return 409 with `matches`, which the pane renders as
  choices. A reference carrying its own directory part is never recovered, and
  recovery never borrows citation authority to cross the workspace realpath
  boundary.
- A reference is marked unavailable only when the resolve step refuses it (404
  or 403), and the mark clears when it later resolves; a transfer that fails
  after a successful resolve stays a transfer failure.
- The project index subtracts `git ls-files -d`, and a preview that finds an
  indexed file missing calls `invalidateProjectIndex(cwd)` so the next scan
  stops offering it.
- Docs reconciled: [[workbench]] (four sections, mutual exclusion, dense row,
  Hidden drawer, rollback), [[session-continuity]] (curation metadata and
  hydration by id), [[resource-preview]] (bounded projection, bare-name
  recovery and ambiguity, unavailable marking, stale-index hygiene),
  [[design-system]] (single-line row anatomy and the section spacing step), and
  the `spec_abstract.md` design map.

## Decisions kept

- The row carries one number, not two. The per-session message count left the
  row entirely — it was the second number competing for the same edge — and the
  age owns a fixed column that the actions can take without shifting anything.
  Four minimal HTML mockups (quiet column, two strict columns, time rail, title
  only) were built and compared before the human chose the quiet column.
- 8 rows, not 10, chosen by measurement rather than taste: `.res__row` stride
  28.125px under a 40% `max-height` list with 16px padding and a ~20px note
  leaves ~8.6 rows at a 700px viewport, so 8 stays inside the rail at ordinary
  heights and the preview keeps dominance.
- Density comes from row composition, not smaller type: `11.5px` remains the
  floor. Shrinking the relative time was rejected; a scroll-height cap alone was
  rejected because it still builds an unbounded list; treating every path-shaped
  word as an existing file was rejected because prose mentions are provisional.
- Git status, diff, staging, and commit surfaces stayed out of scope. The
  retained read-only Changes work now lives in
  [[groom-git-inspection-2026-08-01]], while the evidence-gated proactive
  mention check lives in [[groom-evidence-gated-maintenance-2026-08-01]].

## Verified

`npm run check` (25 files, 226 tests) and `npm run build` green after the final
edit, with new coverage for curated preference isolation, refused-write
rollback to the confirmed value under consecutive failures, pinned+hidden
hydration, pinned-folder hydration by cwd with its per-folder bound, unique
recovery, 409 ambiguity, deleted-path subtraction with rescan, bounded vs
unbounded extraction, and rendered pin/hide/folder-pin/keyboard/active-session
interaction. The built app was exercised against the mock host in both themes
at desktop and narrow widths.

A review pass after the first close found the two defects now fixed above: a
pinned folder with no session in the first page disappeared entirely, and a
second consecutive refused write restored a value that had never been
persisted.

One unexplained observation: during that screenshot pass a folder pin appeared
to clear itself once on the host. It did not reproduce — a follow-up pass
confirmed the pin surviving bootstrap, render, hover, and idle with its stored
value intact — so it is recorded here as an observation, not a known defect.
