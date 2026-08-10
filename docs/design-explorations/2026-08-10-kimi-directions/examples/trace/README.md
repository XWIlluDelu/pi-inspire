# Trace — Laboratory Field Manual (insπre visual example 2)

A static, executable design proof of the **Trace** design direction applied to the
insπre workbench (the local browser workbench for Pi Coding Agent). It re-skins the
existing product semantics — three-region shell, typed transcript, docked composer,
session-bound resource preview, settings overlay — as a ruled, squared, neutral
measuring instrument. It is not a production implementation and not a landing page.

## Run

Open `index.html` directly in a browser. No build step, server, package install,
font download, or network request is involved; everything is local HTML/CSS/JS
(the favicon is an empty `data:` declaration, so even local serving logs no 404).

## What is demonstrated

- **Drafting-film / carbon bench** — near-achromatic graphite neutrals in both
  themes, with a real 8px/40px graph grid painted on the canvas. The 760px
  reading/document plane carries an opaque neutral ground, so the grid stays
  visible only in the transcript's outer margins and gutters — never behind
  prose, tables, math, tool bodies, or user text.
- **One signal trace** — vermilion/coral marks only interaction and live state:
  focus rings, the selected-row block, the running lamp, the gauge, the filled
  send control. Semantic hues (think violet, tool steel blue, status colors)
  survive only as small witnesses: specimen tags, icons, glyphs.
- **Two type voices** — a mono instrument voice owns chrome and machine data
  (folios, nav age columns, topbar git/project meta, card headers, table headers,
  code, the gauge); a Sans SC notebook voice owns prose and titles.
- **Ruled structure** — topbar baseline rule, ledger row rules in navigation and
  panes, card-header rules, a 2px composer dock rule, and a reserved 44px ruled
  search rail that takes layout height instead of floating over the transcript.
- **Specimen-tag plates** — thinking/tool cards are squared plates with a 6px
  color index tag and a mono header row; compact tool batches are 30px squared
  tiles, including one failed `bash` call as an error witness.
- **Instrument motion** — near-instant state changes and a 1.2s `steps(2)`
  sampling lamp for live work; `prefers-reduced-motion` freezes the lamp lit and
  collapses all transitions to opacity.

## Interactions

| Control | Behavior |
|---|---|
| `#theme-toggle` | Switches light/dark, updates `aria-pressed`; exactly one sun/moon icon is visible per theme |
| `#tool-toggle` | Expands/collapses the `read` tool plate, updates `aria-expanded` |
| `#search-button` / `#search-close` | Opens/closes the reserved search rail with focus management |
| `#settings-button` / `#settings-close` | Opens/closes the settings dialog, traps and restores focus |
| `#nav-toggle` / `#nav-close` | Opens/closes the navigation drawer (narrow viewports); the in-drawer close restores focus to the opener |
| topbar git summary | Opens the context pane on the Changes mode |
| pane mode tabs | Switch Files / Changes / History lists |

Escape closes the dialog, then the search rail, then the drawer. All interactive
elements expose visible `:focus-visible` rings; coarse pointers and narrow
viewports get 44×44px hit targets. On phone-width viewports the topbar degrades
by priority — extension tag first, then project/git meta and status tags — so
the session title keeps a visible, truncated share (≥100px) at 390px.

## Content realism

The transcript is a plausible Pi session about a reference-index cache key:
a user prompt in Chinese/Latin mix, an expanded thinking plate, an expanded
`read` tool plate with a TypeScript figure, a compact tool batch with a failing
test run, a diff figure, a ruled ledger table, a display-math fragment, and
round folios carrying only metadata the product already exposes (model, time,
end reason). The composer shows a staged `@` file reference chip, model and
thinking controls, a 42% context meter, and the filled send action.

## Files

- `index.html` — the workbench markup
- `styles.css` — Trace tokens (light + dark) and component anatomy
- `app.js` — interaction wiring (no dependencies)
- `design-notes.md` — how the proof maps to the Trace prompt
