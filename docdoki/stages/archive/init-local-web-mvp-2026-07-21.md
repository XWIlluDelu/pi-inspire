---
scope:
  - .agents/tools/**
  - .gitignore
  - README.md
  - package.json
  - package-lock.json
  - index.html
  - vite.config.ts
  - vitest.config.ts
  - tsconfig*.json
  - server/**
  - shared/**
  - src/**
  - tests/**
  - docdoki/**
---

# Local web MVP

## Objective

Deliver the first Linux local-web version of insπre: a daily-use Pi conversation workbench with reliable streaming, formula-capable rich rendering, existing-session continuity, complete composer input, and an extensible shell.

## Current state

- Working: a token-protected loopback host runs the pinned Pi RPC runtime, discovers the normal Pi session store, serializes session replacement, projects validated state and events, and serves the production client.
- Working: the Kimi-designed React workbench provides welcome and active-conversation flows, session search and switching, light and dark themes, a command palette, contextual details, virtualized history, independent thinking and tool cards, extension dialogs, and responsive keyboard-accessible controls.
- Working: one defensive Markdown authority renders GFM, highlighted code, tables, links, task lists, inline mathematics, and display mathematics while rejecting raw active HTML and unsafe URLs.
- Working: the composer submits text, project-file references, pasted, dropped, or selected images, ordinary files, steering input, and queued follow-ups while preserving failed drafts.
- Working: host, reducer, rendering, preference, composer, accessibility, modal-key ownership, and interaction checks cover the implementation; production mock and existing-session Pi smoke paths also work.
- Modified files: application and test sources under `server/`, `shared/`, `src/`, and `tests/`; root package, TypeScript, Vite, HTML, README, Git ignore, agent-tooling, and DocDoki files.

## Decisions

- Pi RPC remains the first process boundary: one owned worker per active writable session keeps credentials and privileged tools in the host while preserving Pi’s settings, resources, and JSONL history.
- The production host binds to loopback and generates an ephemeral launch token; the browser retains it only for the tab and removes it from the visible URL.
- Kimi owns the front-end design and implementation. The resulting original palette and components follow the visual contracts without copying reference assets or source.
- Session listings retain slim metadata rather than full conversation search text, and long transcripts use browser virtualization to remain practical with the existing history.
- The tested Pi dependency stays pinned to 0.80.10; [[dependency-boundaries]] records the upstream shrinkwrapped advisories and the supported upgrade path.

## Handoff

This stage is complete. The standing implementation contracts and later relay direction now live in the specs; future work should open a new stage for a distinct objective rather than resume this MVP stage.
