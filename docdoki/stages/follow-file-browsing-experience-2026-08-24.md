---
scope:
  - docdoki/specs/resource-preview.md
  - docdoki/specs/workbench.md
  - src/components/Nav.tsx
  - src/components/ResourcesPane.tsx
  - src/styles.css
  - tests/web/nav-render.test.tsx
  - tests/web/resources-pane.test.tsx
  - tests/browser/workbench.spec.ts
---

# File browsing experience

## Objective

Make workspace discovery and contextual file inspection feel like one coherent flow without turning INSΠRE into a file editor or a second IDE.

## Status

Deferred after an assessment of the current `v0.2.0` interface on 2026-08-24. No interaction or visual design is selected yet.

## Current strengths

- The Host exposes a session-bound, bounded, lazy directory index rather than granting arbitrary browser filesystem access.
- The workspace tree can open any indexed project file in the existing preview surface and shares Git decorations with Changes.
- The contextual pane already handles conversation-referenced files, bounded historical paging, safe text/Markdown/HTML/media previews, errors, refresh, and independently resizable list and preview regions.
- Desktop panes resize and narrow layouts become off-canvas drawers, so the underlying workbench structure does not need replacement.

## Observed friction

Real-browser inspection at 1440×1000 and 820×900 confirmed that the weakness is information architecture and navigation continuity rather than preview correctness:

- The collapsed lower-left entry is labelled only with the project basename. Beside the session group carrying the same name, it does not clearly announce a workspace file browser.
- Expanding it assigns a fixed lower half of the navigation column to a narrow tree. There is no file search or quick jump, no adjustable split from Sessions, and expanded directories turn keyboard or pointer traversal into a long list.
- The left tree owns all workspace files while the right `Files` mode owns only files referenced by the conversation. Selecting an arbitrary tree file opens its preview on the right, but that file does not join or select a row in the referenced-file index. The preview heading shows only the basename, with the full path relegated to a tooltip, so selection and location lose continuity once the tree is out of view.
- At 820px, selecting a workspace file while the Sessions drawer is open leaves that drawer visible and opens the Files drawer at the same time. The two modal surfaces occupy nearly the entire viewport instead of producing one clear navigation transition.
- Tree disclosure state is component-local and can be lost when responsive drawer composition remounts the navigation surface.

## Questions to settle before implementation

1. Which surface should own authoritative full-workspace navigation: the left navigation region, the contextual pane, or one shared projection presented in both places?
2. Should conversation-referenced files remain a distinct contextual index, and if so how should its label and relationship to workspace browsing be made explicit?
3. What is the smallest useful discovery model for large repositories: filter/search, recent paths, directory tree, or a combination?
4. On narrow screens, what exact transition should occur from workspace selection to preview so only one drawer is active and returning preserves context?

## Constraints

- Preserve session-bound realpath/index authorization, bounded directory reads, ignored-path handling, and the existing resource-preview safety limits.
- Preserve the distinct semantics of conversation references and Git Changes; visual unification must not merge their data authorities.
- Keep the surface read-only. Editing, file mutation, terminal emulation, and a complete IDE project manager remain out of scope.
- Do not add a second eager repository index or materialize an unbounded tree in the browser.

## Acceptance direction

- The entry point communicates `Files` without relying on a duplicate project label.
- A user can locate a known path in a large workspace without manually expanding and traversing every ancestor.
- Selection has one visible path identity and coherent active state from discovery through preview.
- Switching between workspace files, referenced files, and Changes is understandable without conflating their meanings.
- Narrow navigation-to-preview flow leaves only the intended top drawer active and has an obvious return path.
- Disclosure, selection, keyboard navigation, resize behavior, and responsive transitions are covered in a real browser.
