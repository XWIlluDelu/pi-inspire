---
scope:
  - server/session-{metadata,catalog,search,search-worker}.ts
  - server/app.ts
  - src/api.ts
  - src/controllers/session-catalog-controller.ts
  - src/components/{Nav,NavSessions}.tsx
  - src/styles/navigation.css
  - tests/server/session-catalog.test.ts
  - tests/web/{session-catalog-controller,nav-render}.test.{ts,tsx}
  - tests/browser/workbench.spec.ts
  - docdoki/specs/{session-continuity,workbench}.md
---

# Native-compatible session search

## Outcome

The sidebar search reaches session name, cwd, ID, and complete retained user/assistant text;
bounded ordinary catalog metadata, project/Pin/Hidden navigation, explicit pagination and drafts
remain intact. Contracts: [[session-continuity]] and [[workbench]].

## Design and boundary

- Nonempty queries scan one session's complete retained text at a time. No persistent content index
  or whole-catalog conversation cache is introduced. Ordinary listing still uses bounded metadata.
- The search worker loads the installed Pi selector's pure internal parser/matcher. Pi 1.0's
  `dist/core/session-manager.js` establishes text collection; its
  `dist/modes/interactive/components/session-selector-search.js` supplies fuzzy tokens,
  whitespace-normalized quoted phrases, case-insensitive `re:` regex, and zero matches for
  invalid/empty regex. This module is not a root SDK export: missing/incompatible internals fail
  search without preventing listing or Host startup. Checkout Pi 0.87 uses the same matcher.
- JSONL remains authority. A scan reads its admitted complete prefix while same-inode append may
  continue under the existing one-writer rule. Equal-size observations require unchanged stat
  version; observed truncation, replacement/rebinding, and header identity changes fail the query.
- JSONL parsing and native fuzzy/regex matching run outside the Host event loop. HTTP cancellation
  terminates retired search workers; a 30-second deadline bounds expensive expressions. Browser
  request generations remain authoritative even if a transport ignores cancellation.
- Up/Down/Enter stays in the existing input and follows visible grouped order. Highlighting owns a
  query-scoped session ID, not an array index or the opened-session state. Paging/refresh/curation
  preserves that identity; changed-query pending results cannot open the former selection. Modified
  text-editing keys and IME Enter/Escape keep their ownership. Movement never loads pages implicitly.

## Evidence

- `tests/server/session-catalog.test.ts`, `native full-content catalog search`: isolated v3 JSONL
  compares catalog membership with the actual installed Pi loader and selector across body-only,
  assistant-only, retained branch, late text, ID/cwd/name, abbreviation, multi-token, phrase,
  cross-field regex, invalid/empty regex, and non-text exclusion cases. It checks query pagination
  and unchanged bounded ordinary listing. The group passed with installed Pi **1.0** through an
  explicit `INSPIRE_TEST_PI_COMMAND` override and separately with the checkout's **0.87.0**.
  The authority case checks cancellation, a continuously appending 5 MB session, same-size rewrite,
  and replaced identity; its final focused run uses installed Pi 1.0.
- `tests/web/session-catalog-controller.test.ts`: existing generation/pagination/curation regression
  groups passed; the latest-query case now includes exact phrase/regex forwarding and aborted old
  requests while still rejecting late responses.
- `tests/web/nav-render.test.tsx`: integrated keyboard cases passed for explicit page append,
  identity-preserving curation order, query ownership while pending, and IME/native-229/modifier
  boundaries. Existing navigation rendering/curation cases passed alongside them.
- Fresh `npm run build:web`, followed by the two `session search keyboard selection` cases in
  `tests/browser/workbench.spec.ts` under Chromium: desktop **1280×900** and narrow **390×844**
  passed. They exercise Find a session `/resume` from the start surface, explicit paging,
  highlighted identity and Enter, composition Enter/Escape, independent active/start text drafts,
  a retained attachment, Pin/Hidden/Restore, narrow drawer close, and scoped navigation Axe checks.
  Screenshots: `output/playwright/session-search-desktop.png` and
  `output/playwright/session-search-narrow.png`; both inspected. Browser catalog pages are isolated
  mock responses, deliberately containing titles that do not match the query, not evidence of
  installed Pi content matching.
- Scoped formatting and diff checks passed. Review reproduced and corrected active-writer search
  failure; the complete-prefix and equal-size rewrite regressions retain that evidence.
