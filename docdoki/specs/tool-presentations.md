---
purpose: Typed tool-presentation rules turn Pi tool calls and results into compact, truthful Web cards while preserving a universal raw fallback.
covers:
  - src/tool-presentations/
  - src/components/transcript-cards.tsx
  - src/styles.css
  - tests/web/tool-cards.test.tsx
  - tests/web/tool-presentations.test.ts
---

# Tool presentations

## Goal

Make common tool activity immediately legible without coupling the browser to Pi's imperative terminal renderers or hiding the underlying call when a semantic rule cannot safely interpret it.

## Checks

- The existing tool card remains the only owner of disclosure, Dynamic/Compact lifecycle, status, copy, resource actions, motion, accessibility, and failure styling. A presentation rule replaces only its summary and expanded body.
- Rule definitions have namespaced ids and remain separate from exact tool-name mappings. INSΠRE ships project-wide Pi rules and mappings; a later user configuration layer can add declarative rules and replace mappings without modifying a shipped rule definition.
- Resolution applies the user mapping for a tool name when present, otherwise the shipped mapping. After selecting that one mapping, a missing, throwing, or shape-incompatible rule returns directly to generic raw rendering; it never tries a second semantic rule.
- Rules are pure projections of the persisted/RPC-visible call name, arguments, result content, result details, and lifecycle state. They do not read files, access the network, or infer extension provenance.
- Resolving a collapsed card remains cheap. Potentially large blocks are built only when the card body mounts, code bodies initially project at most 400 numbered lines, and explicit expansion can reveal the complete source. Unified edit patches remain complete because the patch is the content being inspected.
- Shipped mappings cover Pi's native `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools. They present file/range metadata, numbered source or image previews, requested writes, authoritative applied patches, terminal command/output, grouped matches, and file or directory lists rather than argument JSON.
- Successful native `edit` cards use Pi's persisted `details.patch`; they never reread the workspace or compute a replacement diff in the browser. Pending or failed edits may show the explicitly labelled requested replacements without claiming file coordinates or application success.
- Native truncation and result-limit metadata becomes a separate notice rather than being mixed into source, terminal, search, or list content. Complete copy actions still retain the original full arguments and result projection.
- Unknown tools, malformed calls, unexpected result shapes, and failed rule execution retain the generic inspectable raw card. No selected-rule failure is swallowed or reinterpreted as another tool.

## Current boundary

The immutable registry already models shipped and user rule/mapping layers so the mapping semantics are testable. This phase exposes only the shipped Pi-native layer. Loading user-level declarative rule files and mappings, including FFF rules, is a later phase.

## Non-goals

- Pi `renderCall` and `renderResult` return terminal components and are not reused as Web renderers.
- INSΠRE does not auto-detect which extension owns an overridden tool name; an informed user owns that mapping.
- Arbitrary user JavaScript, React components, HTML, and tool-origin inference are outside the rule format.
