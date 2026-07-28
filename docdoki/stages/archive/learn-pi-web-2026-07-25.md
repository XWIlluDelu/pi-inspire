---
scope:
  - src/**
  - server/mock.ts
  - tests/web/**
  - docdoki/specs/workbench.md
  - docdoki/specs/conversation.md
  - docdoki/specs/composer.md
---

# Learning from pi-web

## Objective

Adopt useful interaction techniques from pi-web without copying its Next.js,
Electron, inline-style, or monolithic-component architecture.

## Current state

- Completed: unified typed diff rendering, boundary pane resizing, and one
  in-memory unsent composer draft per session are integrated into inspire's own
  component and store architecture.
- The comparison also clarified later possibilities around file and command
  completion, transcript navigation, forks, streaming resilience, and contextual
  workspace tabs. Those are optional proposals, not active implementation work,
  and now live in [[enhancement-proposals-2026-07-22]].
- The current navigation and resource work has its own active stage,
  [[follow-navigation-resource-polish-2026-07-27]]. Git tabs remain deferred
  until their product purpose and mutation boundary are settled.

## Decisions

- Techniques and product capabilities may transfer; pi-web's packaging,
  per-component inline styling, and large monolithic components are not models
  for inspire.
- Diffs remain unified rather than split because the reading column cannot
  support two useful code columns without excessive wrapping.
- Resize and scroll affordances share a pane edge by z-order: the scroll thumb
  wins on its own hit area and resizing owns the remainder.
- Optional future work belongs in the reusable enhancement backlog until a
  human selects it into a distinct, scoped active stage.
