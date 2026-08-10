# Design notes — Trace proof

## Fidelity to the direction

**Neutral, not re-warmed.** Both token sets are the prompt's values verbatim:
drafting-film `#f1f3f1` / carbon `#101311` benches, softened graphite surfaces,
and the vermilion signal family (`#d94b2b` light / `#ff8062` dark). No cream,
tan, or teal anywhere; the signal appears as a 3px selected-row block, focus
rings, the running lamp, the gauge arc, and the one filled control (send).
On light, small accent text and links use `signal-deep` rather than the 3:1
graphics `signal`, per the role discipline.

**The grid is real and masked.** The body canvas paints the 8px minor / 40px
major flat line pattern; every reading surface (nav, topbar, plates, code
figures, composer, pane, dialog) is an opaque `surface`/`surface-inset` ground,
so the grid shows only in open bench regions — transcript margins, gutters,
around the reading column. Grid density halves on narrow viewports.

**Rules carry structure.** The topbar ends in a baseline rule; nav rows,
explorer rows, and pane rows sit on 1px ledger rules with folio headers whose
counts occupy the same right-hand column as the ages; card headers close with
a full-width rule; the composer docks flush under a 2px `rule-strong` edge with
`radius: 0`; the search rail is a reserved 44px row closed by a 2px base rule
that pushes the transcript down instead of overlaying it.

**Two voices.** Mono owns every piece of chrome and machine data — folios, age
columns, topbar path/git, status tags, card headers, table headers, code,
meter, palette-style mode tabs — with `tabular-nums` so figures hold still.
Sans SC owns prose, titles, the composer input, and dialog copy. The wordmark
is mono `insπre` with the π in italic signal. Letter-spacing is `0` globally;
nothing sets below 12px.

**Specimen tags, not tinted edges.** Thinking and tool plates are squared
(`radius: 0`) with a 6px squared index tag and a 14px icon in the block's
semantic hue (violet / steel blue / error). The failed `bash` tile in the
compact batch is the error witness, paired with a glyph, never color-only.

**Instrument motion.** Transitions run 60–200ms, mostly color/opacity. The
live lamp blinks in `1.2s steps(2)`; terminal lamps rest as 1px rings.
`prefers-reduced-motion` collapses everything and freezes the lamp lit.
Elevation is flat: Level-2 surfaces (dialog) get one hard offset shadow and a
flat 55% scrim — no blur, no soft stacks, no gradients except the permitted
transcript top fade mask.

## Product semantics preserved

Only concepts insπre already exposes are drawn: curated nav sections
(置顶 / folders / 隐藏 / load-older), running-settled-stopped lamps, topbar
identity with clickable path and git summary that opens Changes, runtime and
extension status tags, the Details-style round folio (Pi · model · time ·
end-reason), thinking/tool plates and the Compact batch, `@` file reference
chips, model/thinking/context-meter composer controls, the Files / Changes /
History pane, and the settings overlay with thinking-card, tool-card, and
completion-attention preferences. No timestamps, counters, or panels were
invented; user turns carry no folio because the product exposes none.

## Prototype concessions

- Real IBM Plex faces are not embeddable without shipping font files; the
  stacks request them first and fall back to system mono/sans with CJK
  coverage. Metrics stay close enough to judge the two-voice split.
- KaTeX is represented by a static display-math fragment in a math-italic
  serif stand-in; layout role (ruled display block, horizontal containment)
  matches the spec.
- Pane/search/git interactions mutate presentation only; there is no data
  layer, by design.

## Accessibility checks

- Token text pairs follow the prompt's measured contrast roles; light `faint`
  is used only on `surface`/`canvas` grounds.
- `:focus-visible` draws a 2px squared signal outline with 2px offset on every
  interactive element; fields use border + flat wash, no halo.
- State is never color-only: lamps pair with labels/titles, git rows pair name
  color with letter marks, the meter pairs hue with a percentage, the failed
  tile pairs hue with a glyph.
- Dialog traps Tab and restores the opener on close; Escape ordering is
  dialog → search rail → drawer. The mobile drawer also has an explicit
  in-header close (`#nav-close`) that returns focus to `#nav-toggle`; the
  scrim and row selection remain secondary close paths. Coarse-pointer media
  and the <900px layout raise every control to the 44px floor.
- Mobile identity degrades by priority, never to zero: below 900px the
  extension tag is demoted first and the session title takes an explicit
  `min-width: 100px`; below 640px the project/git meta and status tags yield
  entirely. At a 390px-class viewport the topbar is opener (44px) + truncated
  title (≥100px) + four 44px actions, so identity stays visibly present.
