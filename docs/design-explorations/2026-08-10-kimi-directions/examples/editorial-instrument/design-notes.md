# Design notes — Editorial Instrument

This prototype is a design proof of the Editorial Instrument direction for the
insπre workbench. It keeps Pi as runtime and session authority, the conversation
as the primary workspace, and navigation / transcript / composer / Files /
Changes / History / settings in their current jobs. Only the visual system and
component anatomy change. All copy is operational and specific; nothing is
promotional.

## Surface ownership

- **Graphite frame / paper plane / inspection surface.** The navigation is a
  deep graphite housing (`frame` tokens) in both themes; the center is a bright
  document plane in light mode and a dark mineral plane in dark mode; the
  resources pane sits between them in tone. Region boundaries come from material
  change, not stacked borders — the frame and the document each carry a single
  1px edge rule.
- **Masthead topbar.** Session title is primary; project path and Git summary
  are compact mono metadata buttons; status capsules and the fixed action
  cluster stay visually separate. Identity yields first on narrow widths
  (project path, then status, before the title truncates).
- **Context pane.** A 52px inspector header aligned with the topbar, rectangular
  Files / Changes / History mode tabs with an underline rail, fixed-column
  resource rows (icon / path / age), and a preview sheet separated by one
  structural rule — not a card.

## The eight substantive departures, as implemented

1. **Graphite frame in light mode** — `frame #171c1a` navigation with
   `frameRaised` hover, `frameInset` search field, and a 2px teal leading rail
   on the selected session row.
2. **Sharper geometry, fewer pills** — controls are 4px-radius rectangles;
   999px radius survives only on the one muted status capsule and the running
   point. Buttons keep stable dimensions across states.
3. **Reserved search rail** — a 44px row below the topbar, sharing the document
   axis; it takes layout space (`hidden` toggling), so it can never cover a
   transcript row or a result.
4. **Docked command deck** — the composer is attached to the bottom zone with a
   stronger 2px top edge; the textarea is open and quiet; model, thinking,
   project files, attachments, context gauge, and send form one stable strip.
   At phone widths the strip wraps into two compact rows — model, thinking,
   and project files on the first; attachments, the context gauge, and the
   trailing send square on the second — and the whole deck zone measures under
   240px at 390×844 with every target at 44px.
5. **Dark code slabs** — the TypeScript block is charcoal (`#171c1a`) with a
   header bar (language left, copy right) and restrained syntax hues inside the
   light document; dark theme makes it a deeper inset plane instead.
6. **Raised type scale** — UI at 15px, reading at 16px/1.68 with a ~74ch
   measure, 13px secondary UI, and a hard 12px floor for every visible code
   and metadata role (`code` computes as `max(12px, 0.875em)`, and `pre code`
   inherits the block's 13px). Tabular figures for ages, counts, token
   numbers, and the context gauge. Letter spacing is 0 everywhere; weights are
   400/500/600 only.
7. **Flattened settings** — one two-zone dialog: a narrow section index and
   open sections with headings, rules, and aligned label/control rows; the
   destructive reset lives in a single terminal section. No nested cards.
8. **Controlled brand** — the italic serif `insπre` lockup appears once, in the
   frame header, which carries no host, port, or other runtime metadata. No
   watermark, no repeated reticles or teal squares.

## Signature mechanics

- **Editorial index witnesses.** Activity anatomy is built from thin rules,
  labels, and small glyphs, not colored container edges. Thinking and tool
  plates open their headers with a 14×2px index dash in the semantic hue
  (violet `reasoning`, blue `tool`), followed by the glyph and a semibold
  label; the expanded body separates with one 1px rule. Compact tools are
  rectangular index tiles (glyph + verb + target + status mark); running adds
  a 2px teal baseline under the tile, failure a 2px red baseline, an × mark,
  and the exit code. The failure strip repeats the dash + glyph grammar and
  adds an inline Retry verb without flooding the panel.
- **Running moves; settled rests.** Only the teal running point breathes
  (2s loop, in the nav row and the running tool tile). Everything settled is
  static. Reduced motion removes the loop and all translations.
- **Witness colors.** Success, warning, and error appear only as small marks:
  diff line tints, the failed tile's mark and exit code, the failure strip.
  Teal is the single interactive hue; it never fills panels.
- **Alignment as identity.** Shared 52px header heights across frame, topbar,
  and inspector; fixed right-hand metadata columns in nav and resource rows;
  38px session rows; aligned deck controls.

## Content and realism

The transcript is a plausible Pi work session in the `pi-coding-agent` project:
a Chinese/Latin user prompt with an `@`-referenced project file chip, an
expanded thinking plate, an expanded Edit plate showing a unified diff (typed,
tinted lines), an assistant answer with a timing-constant table, a math
fragment, and a code slab, followed by a compact tool batch containing a
running typecheck, a failed `npm test` with its failure strip and Retry, and a
round-end metadata rule. The resources pane shows the same files the
conversation touched, plus a Changes list with +/− counts and a History stub —
all concepts the product already exposes.

## Accessibility and resilience

- Every icon-only control has an accessible name and a tooltip; the seven
  required selectors carry correct `aria-pressed` / `aria-expanded` state.
- Escape closes settings → search → drawer, in z-order; the dialog contains Tab
  and restores focus to the exact opener.
- Hit areas are 32px visually on desktop and 44px under coarse pointers or
  narrow viewports; user-turn copy stays reachable on touch (gutter action is
  static below the message).
- `prefers-reduced-motion` collapses transitions and the breathing loop while
  keeping immediate state changes.
- Light and dark themes are complete token sets on `data-theme`; both keep AA
  contrast for text and state graphics. Horizontal scrolling is confined to
  code, diff, and table bounds; the page never scrolls sideways.

## Scope limits (deliberate)

This is a static proof: the deck's send action clears the draft instead of
talking to a runtime; search prev/next are static; model/thinking menus and the
command palette are represented by their triggers only. No feature, route, or
setting was invented beyond what the insπre specs describe.
