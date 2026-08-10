# insπre visual example — Editorial Instrument

A self-contained design proof of the **Editorial Instrument** direction applied to
the insπre workbench (the graphical front end for Pi Coding Agent). It renders the
actual workbench first screen: graphite navigation frame, masthead topbar, reserved
search rail, a realistic technical transcript, docked command deck, and the
on-demand Files / Changes / History resources pane.

## Run

Open `index.html` directly in any modern browser. There is no build step, no
server, no network request, and no external dependency — HTML, CSS, and JS
only (the favicon is an empty `data:` declaration, so a local static server
produces no 404).

## What to look at

- **Graphite frame, paper plane** — the left navigation is a dark graphite
  instrument housing in light mode; the transcript sits on a white document
  plane; the resources pane is a tone between the two.
- **Editorial document flow** — the assistant answer is open typography
  (16px/1.68, ~74ch measure) with rules, an open table with tabular numerals, a
  math fragment, and mixed Chinese/Latin copy; no answer card.
- **Editorial index witnesses** — thinking (violet) and tool (blue) plates open
  with a thin 2px index dash, a semantic glyph, and a semibold label; status is
  a small glyph plus a tabular time. Compact tool tiles carry verb, target, and
  a status mark; running adds a breathing teal point over a 2px teal baseline,
  failure a red baseline, an × mark, and the exit code. The failure strip uses
  the same dash + glyph grammar with an inline Retry. No colored container
  edges anywhere.
- **Dark code slab** — the TypeScript block uses a charcoal slab with a header
  bar inside the light document.
- **Compact tool batch** — rectangular index tiles with verb, target, and status
  mark, including a running tile (breathing teal point) and a failed tile.
- **Reserved search rail** — `#search-button` opens a 44px rail below the topbar;
  it reserves layout space and never covers transcript rows.
- **Docked command deck** — the composer is attached to the workspace axis:
  open textarea, staged file-reference shelf, and a lower strip with model,
  thinking, project files, attachments, context gauge, and a 40px send square.
  On phones the zone stays within 240px at 390×844 with at most two control
  rows and 44px hit areas.
- **Flattened settings** — `#settings-button` opens a two-zone dialog with a
  section index and aligned label/control rows; no cards inside cards.

## Required interaction selectors

| Selector | Behavior |
|---|---|
| `#theme-toggle` | Switches light/dark theme, updates `aria-pressed`. |
| `#tool-toggle` | Expands/collapses the Edit tool plate, updates `aria-expanded`. |
| `#search-button` / `#search-close` | Opens/closes the reserved search rail; focus moves into the field and back. |
| `#settings-button` / `#settings-close` | Opens/closes the settings dialog; focus is contained while open and restored to the opener. |
| `#nav-toggle` | Opens/closes the graphite navigation drawer (narrow viewports), with scrim and internal close. |

Escape closes settings, then search, then the drawer, in that order. All controls
have visible `:focus-visible` outlines, and `prefers-reduced-motion` removes
transitions and the running-point loop.

## Responsive

- **1440×1000** — three-region workbench: nav frame, transcript + deck, resources pane.
- **≤1180px** — the resources pane yields first.
- **≤899px (e.g. 390×844)** — navigation becomes an off-canvas drawer; topbar
  metadata yields before the title; deck controls wrap into two stable rows with
  the send square fixed at the trailing edge; all hit areas are ≥44px; only code,
  diffs, and tables scroll horizontally, inside their own bounds.

## Files

- `index.html` — structure and content (real operational copy, no marketing).
- `styles.css` — the Editorial Instrument token system (light + dark) and components.
- `app.js` — the interactions listed above; local state only.
- `design-notes.md` — design decisions and their trace to the direction document.
