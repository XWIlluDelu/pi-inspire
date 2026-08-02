---
scope:
  - server/session-catalog.ts
  - server/app.ts
  - shared/contracts.ts
  - src/api.ts
  - src/store.ts
  - src/components/Nav.tsx
  - src/styles.css
  - tests/server/**
  - tests/web/**
---

# Incremental session-list loading

## Objective

Make older unpinned history reachable incrementally while preserving search, curation, grouping, ordering, and latest-wins response handling.

## Completed state

- [x] Kept the host authoritative for a deterministic newest-first catalog order, filtered total, and validated bounded offset/limit. Page responses retain their requested/accepted offset and never infer it from browser state.
- [x] Split the browser's chronological base pages from its separately hydrated union of pinned ids, hidden ids, pinned working directories, selected sessions, and live background sessions.
- [x] Made the next chronological offset exactly `response.offset + response.sessions.length`. Identity deduplication preserves first server order but does not alter the cursor, so curated rows and duplicate response identities cannot skip history.
- [x] Added latest-wins offset-zero reset semantics for initial load, query changes, explicit refresh, and relevant curation changes. Search is server-filtered across every page; stale first-page, older-page, and curation responses cannot replace the current query or preference owner.
- [x] Added a coalesced explicit load-older operation. It appends in server order, disables duplicate requests while in flight, retains confirmed pages after failure, and exposes a same-offset retry. Retry ownership distinguishes page append, reset, explicit refresh, preserve-loaded-extent, and single-session hydration operations so both behavior and UI copy remain truthful.
- [x] Preserved the consumed base extent across background settlement, rename, new-session, and fork refresh hints by refetching that extent from offset zero. Arbitrarily large extents are fetched atomically as bounded sequential pages under one latest-wins generation; a mid-sequence failure retains the confirmed extent and retry repeats the exact preservation target. Explicit refresh still forces the catalog and restarts with only page zero.
- [x] Kept selected, newly created, forked, and live background sessions reachable through bounded id hydration without advancing or reordering the base cursor. The full deduplicated 100-pin/500-hidden plus selected/live union is chunked within the 600-id host bound; cwd unions are chunked within their bound. Authentication loss follows the shared auth path. Any other chunk or cwd failure retains confirmed base/curated rows, exposes a retryable warning, and cannot commit a partial hydration union. A standalone live-session lookup failure owns an id-scoped hydration-only retry: success merges that row without refetching or collapsing loaded base pages, while query/list generations invalidate stale ownership.
- [x] Added the compact keyboard-native `Load older sessions` control below chronological groups and before Hidden. Its live status reports `Showing N of total`, and the same surface renders loading, retry, narrow/touch target, and all-loaded states without infinite scroll.
- [x] Added host, catalog, store, and rendered-navigation coverage for more than three pages, off-page curation, duplicate identities, cursor/display divergence, active search reset, preference races, out-of-order reset/older responses, coalescing, retained errors and retry, explicit refresh, settlement preservation beyond the per-page cap, exact preservation retry, 600-plus-active id chunking, partial hydration/cwd/auth failures, 240-row standalone hydration failure/retry, hydration auth/stale invalidation, new/fork hydration, truthful retry labels, end rendering, ARIA, keyboard use, and narrow viewports.

## Decisions

- Pagination improves browser usability; it does not create a durable search index or change Pi session authority.
- Curated and live rows classify and supplement the chronological page set but never advance its cursor.
- Background refresh may spend more than one bounded request to revalidate the already consumed extent; it never treats the rendered union length as that extent.
- Infinite scroll is deliberately excluded. History expansion remains an explicit user action with a visible result count.

## Verification

- `npx vitest run tests/web/session-pagination.test.ts tests/web/session-pagination-render.test.tsx tests/web/store.test.ts tests/web/nav-render.test.tsx tests/server/session-catalog.test.ts tests/server/app.test.ts --reporter=dot`
- `npm run check`
- `npm run build` (passes with the existing Vite chunk-size advisory)
