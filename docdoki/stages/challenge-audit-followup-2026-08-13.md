---
scope:
  - .github/workflows/ci.yml
  - biome.jsonc
  - package.json
  - scripts/check-import-boundaries.mjs
  - scripts/size-report.mjs
  - scripts/build-release.mjs
  - scripts/import-ibm-plex-sans-sc.mjs
  - scripts/verify-release-package.mjs
  - scripts/vite-license-notices.ts
  - server/resources.ts
  - server/runtime.ts
  - server/preview-projection.ts
  - shared/contracts.ts
  - src/App.tsx
  - src/store.ts
  - src/controllers/resource-controller.ts
  - src/controllers/git-controller.ts
  - src/controllers/branch-controller.ts
  - src/controllers/composer-controller.ts
  - src/controllers/session-catalog-controller.ts
  - src/controllers/session-selection-controller.ts
  - src/resource-preview.ts
  - src/components/ActivityBar.tsx
  - src/components/AppTopbar.tsx
  - src/components/EarlierBranchBanner.tsx
  - src/components/Nav.tsx
  - src/components/Transcript.tsx
  - src/components/transcript-activity.ts
  - src/styles.css
  - tests/browser/workbench.spec.ts
  - tests/server/resources.test.ts
  - tests/server/import-boundaries.test.mjs
  - tests/web/branch-controller.test.ts
  - tests/web/branch-tree.test.tsx
  - tests/web/composer-controller.test.ts
  - tests/web/git-controller.test.ts
  - tests/web/session-catalog-controller.test.ts
  - tests/web/session-selection-controller.test.ts
  - tests/web/session-pagination-render.test.tsx
  - tests/web/store.test.ts
---

# Audit follow-up

## Objective

Reconcile the external reviews with the current implementation, repair confirmed
correctness gaps, and begin the requested behavior-preserving decomposition
without creating a second browser store or Pi runtime authority.

## Current state

- The identity-bound deletion and resource serving repairs remain in force.
  Session deletion never restores quarantine bytes through a public catalog
  pathname. Resource serving pins each resolved inode with an unstreamed anchor
  descriptor, opens the current pathname with `O_NOFOLLOW`, and rejects a
  symlink or inode-reused replacement while permitting an in-place rewrite of
  the still-authorized object.
- Resource availability uses the exact session/view/revision/API-transport
  generation and capped 16-reference requests. A successful batch now keeps its
  standing if a later batch fails; only the failed batch becomes retryable
  `unknown`. Transport replacement cancels resource list/probe/preview work,
  clears transient resource authority, and prevents an old 401 from undoing a
  successful fresh pairing.
- Session navigation has one curated location per session. Its canonical row
  dot reports working, unseen completion/failure, or recovery; there is no
  duplicate runtime-derived navigation group or hidden-attention aggregate.
- Earlier-branch context now renders above the center transcript, not only in
  the History pane. Return and fork actions refresh the authoritative branch
  tree before acting, so the banner adds no browser-owned branch authority.
- Queue activity is deliberately minimal: the activity bar reports a concise
  queued count outside its live status region, while the transcript's labelled
  pending steering/follow-up rows retain the complete Pi-projected text. There
  is no redundant queue inspector or imaginary queue-management control.
- The first behavior-preserving extraction series is active: `AppStore` still
  publishes the only browser snapshot and coordinates cross-domain writes, but
  `ConnectionController` owns browser transport/backoff; `ResourceController`
  owns resource pagination/probes/preview lifecycle; `GitController` owns Git
  status/diff requests, polling, cancellation, and visible-surface scheduling;
  `BranchController` owns tree/action request lifecycles; `ComposerController`
  owns session-partitioned attachments/project files and delivery;
  `SessionCatalogController` owns catalog pagination/hydration/retry
  generations; and `SessionSelectionController` owns open/new/deselect request
  ownership. `resource-preview` owns pure resource presentation; `transcript-activity`
  owns dynamic card grouping; `AppTopbar` owns topbar presentation; and
  `PreviewProjection` owns the read-only runtime preview adapter. These
  collaborators have narrow host interfaces and do not own canonical session
  state. Controller tests characterize request ownership independently of
  AppStore.
- Bootstrap is latest-wins: each `init()` retains its generation and API
  identity, and only the still-current request can apply a snapshot, open a
  socket, load launch preferences, or turn a 401 into pairing state. A newer
  bootstrap invalidates old branch actions/tree loads, resource requests, and
  any in-flight open/new/deselect owner rather than leaving a stale control
  actionable.
- Static quality coverage includes product source, server, shared protocol,
  tests, and every maintained build/release script. Biome checks format, unused
  bindings, hook dependency hygiene, floating promises, import cycles, and
  invalid ARIA role/property combinations; a separate TypeScript-resolved
  import-boundary check guards shared/server/browser and controller/component
  direction, including NodeNext `.js` source specifiers. The package-size report
  prepares the release build, packs with lifecycle scripts disabled, and rejects
  a tarball missing required release artifacts or an empty asset category. It
  remains a separate non-blocking CI job. Its font field is explicitly named
  `coldStartFontCandidates` because it is a static package heuristic; browser
  test evidence records actual page font transfer separately. Main-branch CI
  also runs the packaged release verifier as its own job. That verifier isolates
  `HOME`/XDG and `PI_CODING_AGENT_DIR`, pins an offline loopback-only smoke
  model through temporary Pi configuration, and starts a real packaged Pi RPC
  worker without reading runner credentials or contacting a provider.

## Current validation

The accepted remote baseline is
`d17b7ca`, whose `quality`, `size-report`, and `release-verify` jobs passed in
GitHub Actions run
[`31804910122`](https://github.com/XWIlluDelu/pi-inspire/actions/runs/31804910122).
The corresponding local worktree passed the expanded quality gate: Biome
format/lint and import-boundary checks, TypeScript, 67 ordinary Vitest files /
714 tests, 1 serial launcher test, production Vite build, and 3 mock-host
Playwright scenarios. `npm run size:report`, `npm run release:verify`, and
`git diff --check` also passed.

The new release verifier first exposed two runner-specific but real
compatibility gaps: npm 10 emits a direct `npm publish --dry-run --json` record
where npm 12 may emit a package-name-keyed record, and an unconfigured Pi
runtime reports `unknown/unknown` rather than a viable model. The verifier now
accepts array/direct/keyed npm manifests with fixtures, isolates a deterministic
local-only smoke model, and the product projects Pi's absent-model sentinel as
no model instead of attempting a worker that must fail. Both fixes were
validated by the exact remote run above.

A subsequent local, uncommitted transport-ownership fence closes the resource
probe re-pairing race: an old API's pending 401 cannot clear a fresh pairing
that preserved the same session/view/revision. Its focused store test and full
local gate passed with 67 ordinary Vitest files / 715 tests, 1 serial launcher
test, and 3 Playwright scenarios; this paragraph must be replaced with an exact
remote-SHA result when the change is shipped.

## Next actions

- [x] Repair the availability multi-batch failure overwrite and characterize
  success-then-failure retry behavior.
- [x] Move earlier-branch context into the center surface, retain one canonical
  navigation row per session, and keep queue display to a count plus transcript
  pending rows.
- [x] Start the behavior-preserving extraction series at connection, resource,
  transcript activity, topbar, and preview-projection boundaries.
- [x] Expand format/lint/import-boundary coverage and make size evidence an
  independent non-blocking CI job.
- [ ] Continue the F6 series one proven domain at a time: runtime worker and
  projection coordination. Git, branch, composer, session catalog, and session
  selection browser collaborators are now extracted. Each migration needs
  characterization coverage and must leave `AppStore`/`RuntimeController` as
  facades.
- [ ] Add the next small set of high-value browser scenarios for project-file
  focus recovery, resource history virtualization/HTML network isolation, and
  earlier-branch recovery.
- [ ] Decide explicitly whether repository branch protection should require the
  `quality` GitHub job and require PR merges. That is shared GitHub governance,
  not a source-only change to apply implicitly.

## Decisions

- Complete-file formatting is an explicit migration step, not a claim that
  formatting a few scripts is repository quality closure.
- A static font-candidate total must never be described as actual cold-start
  transfer. Browser transfer data and static package inventory remain separate
  metrics, and static inventory must come from the same prepared release shape
  that `npm pack --ignore-scripts` is asked to measure.
- One authority does not require one implementation file. Collaborators may own
  bounded lifecycle logic through a facade-provided interface; they may not
  retain parallel canonical snapshots, session stores, global event buses, or
  persistence authority.
- Session deletion stays an existing independent adapter; it is not a future
  extraction target.
