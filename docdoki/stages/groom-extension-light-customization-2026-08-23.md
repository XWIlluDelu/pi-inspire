---
scope:
  - README.md
  - docs/**
  - docdoki/specs/pi-integration.md
  - docdoki/specs/tool-presentations.md
---

# Extension compatibility and light customization

## Objective

After the core product has received a systematic review and its readability, maintainability, reuse, and decoupling have been improved, evaluate a bounded path for users to adapt their existing Pi Extensions to INSΠRE without redesigning the whole interface.

## Current state

- Deferred. The product review and architectural cleanup take precedence; no DIY implementation is selected.
- INSΠRE remains neutral toward third-party Extensions. It already maps serializable Pi RPC interactions generically and provides declarative Tool Presentation, while terminal-only components do not become Web components and dedicated buttons or panels have no stable frontend extension point.
- The shared “Extension Compatibility & Light Customization” proposal is useful problem framing, not an approved API, file plan, PR sequence, or commitment to build a plugin system.
- The scope is deliberately limited to the current documentation authorities. Any later implementation stage must redraw its code scope against the post-cleanup architecture rather than inherit speculative file ownership from the proposal.

## Next actions

- [ ] Wait until the core review and readability, maintainability, reuse, and decoupling work is complete enough to expose stable owners.
- [ ] Re-audit the then-current Pi RPC, Host, browser, and Tool Presentation boundaries instead of assuming today’s layout remains authoritative.
- [ ] Use representative Todo, quota/usage, and custom or overridden Tool extensions to separate documentation gaps, reusable source-level adaptation patterns, and genuine missing product capability.
- [ ] Define a compatibility matrix, semantic placement rules, visual and interaction conventions, data ownership, upgrade boundaries, and focused examples for light DIY.
- [ ] Decide from those cases whether documentation and source recipes are sufficient or whether bounded Widget/Status presentation, diagnostics, declarative UI contributions, or a versioned bridge are justified.
- [ ] Open or re-scope a focused implementation stage only after that design decision; keep whole-page redesign and arbitrary React, CSS, or executable frontend injection out of scope unless separately authorized.

## Decisions

- This is a non-urgent follow-up after core quality work, not part of the current product review or cleanup.
- Existing Pi Runtime behavior remains authoritative. A Web adaptation must not duplicate Extension state or pretend that TUI component factories are serializable.
- The linked proposal is retained only as design input. Its concrete four-phase implementation is intentionally unsettled.

## Handoff

Do not implement this stage yet. When the prerequisite core work is complete, begin by checking the current contracts and three representative Extension cases, then narrow the product commitment before proposing files or APIs.
