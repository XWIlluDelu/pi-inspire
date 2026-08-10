# Independent design rationale

## What the product actually is

insπre is a local, browser-based workbench for Pi Coding Agent: a three-region shell (curated session navigation left, dominant conversation center, on-demand context pane right), a streaming transcript of typed user/assistant/thinking/tool content, one composer covering text, file references, images, attachments, steering, and follow-ups, a defensive session-bound resource preview, a command palette, a settings overlay, and Pi state that must always read as truth (running / retrying / compacting / queued / stopped / failed; attention and completion; git working-tree state; context occupancy). The browser holds no conversation authority and no credentials; Pi's JSONL records are canonical. Any redesign is a re-skinning of this exact instrument panel — not a new product, not a landing page.

## Critique of the current visual system

The shipped system — cool-green paper neutrals, teal accent, IBM Plex Sans SC everywhere, hairline-separated cards, soft 4–12px radii, background-step region separation, tinted user bubbles, breathing live-chips — is competent and calm, but it has converged on the generic center of "quiet AI chat tool": the same soft paper, the same teal, the same pill chips, the same floating rounded composer that half the industry ships. Its own spec calls it "reference grammar without reference identity," which in practice means its identity is the *absence* of identity. Specific weaknesses as a scientific workbench:

1. **No measurement grammar.** A tool whose mission is "inspect Pi rendering" shows no instrument character: no ruled structure, no tabular discipline, no signal channel. Regions float apart on background steps; rows hover in unstructured whitespace.
2. **One type voice does everything.** Sans SC owns chrome, metadata, prose, and labels, so machine data (paths, ages, model ids, git state) and human prose share a texture and must be separated by size and color alone.
3. **Soft geometry blurs state.** Pills, 12px bubbles, and tint fades make state markers decorative; a running chip and a settled chip differ mainly by a slow halo.
4. **The teal/paper pairing is the single most common "calm AI tool" signature.** It reads as a theme of someone else's product.

## The chosen direction: Trace — a laboratory field manual

**Trace** recasts the workbench as a measuring instrument and its transcript as a field notebook. Neutral **drafting-film and carbon/graphite** neutrals replace the cool-green paper; a single **signal vermilion/coral** trace line replaces teal as the one accent; geometry goes **squared** (0–2px radii, pills abolished); regions are separated by **explicit 1px rules** over a faint **graph grid**; and the type system splits into two honest voices — **IBM Plex Mono owns all chrome and machine data** (the instrument's engraved labels), while **IBM Plex Sans SC keeps only human prose** (session titles, transcript body). Motion becomes instrument motion: near-instant state changes and a stepped sampling lamp instead of smooth breathing.

The palette is deliberately *neutral*, not a rotated color theme: surfaces are near-achromatic drafting grays with a barely-there green-gray cast, and all chromatic energy is concentrated in one small vermilion signal family plus tiny blue/violet/status witnesses. This keeps Trace clearly distinct from the current cool-green + teal system (no green paper, no teal accent, no tint-driven hierarchy) while avoiding the beige/brown/orange one-note trap of simply re-warming the old scheme.

Why this fits the mission better than the baseline: the product's name is "inspect Pi rendering." A field-manual/grid/ledger language makes inspection the visual metaphor — ruled margins, folio metadata, specimen-tagged cards, plotted signal color — while staying at medium density and remaining readable for hours. Neutral graphite surfaces carry no tint fatigue over long sessions, and the squared/ruled discipline makes *state* (the thing this product exists to show) maximally legible.

Position against the corpus: Trace borrows the Swiss/International grid discipline and the Industrial/Terminal respect for machine data, but it is not Swiss (softened graphite neutrals instead of black/white starkness, one vermilion signal instead of red, not uppercase-heavy), not Terminal (prose stays in a humanist sans; no phosphor pastiche), and explicitly not Aurora Mesh or Glassmorphism (no ambient glow, no blur materials, no gradient color fields — those would fight the measured, matte character).

Substantive departures from the current interface (each visible in a screenshot diff):

1. **Palette rotation to neutral** — drafting-film/graphite neutrals + one small signal-vermilion accent family replace cool-green paper + teal; blue/violet/status semantic hues survive only as small witnesses.
2. **Squared geometry** — radius scale collapses from {4,6,8,12,pill} to {0,2}; chips become squared tags; the pill shape is abolished except the circular status *lamp* glyph.
3. **Ruled structure over background steps** — 1px rules separate workbench regions and navigation rows; a graph-grid canvas appears; the topbar gains a baseline rule; the composer docks flush with a 2px top rule instead of floating as a rounded card.
4. **Two-voice typography** — mono takes over chrome/metadata (nav rows' age column, card headers, topbar git/project meta, composer meta row, palette rows, chips, table headers); sans keeps prose and titles; the serif is retired and the wordmark is reset in mono + KaTeX π.
5. **Specimen-tag cards** — thinking/tool cards lose the 3px tinted left edge and chevron card look; they become squared plates with a full-width mono header rule and a small squared color index tag carrying the semantic hue.
6. **Instrument motion** — the ease-out fade/scale/breathe vocabulary is replaced by near-instant state changes, a 1.2s stepped status lamp for live work, and simple opacity settles; terminal states are perfectly still.
7. **Ledger transcript structure** — user bubbles become squared signal-wash entries; assistant rounds may be separated by a ruled folio line in mono instead of a bare hairline; transcript search moves from a floating pill into a reserved ruled rail.

Retained with changed roles: IBM Plex Sans SC stays for reading (CJK coverage is a hard product constraint) but loses chrome; the semantic annotation hues stay but move from edges to index tags; the transcript top fade stays as a functional mask; Pi state chips, git grammar, context gauge, card density lifecycle, and every workflow are untouched. The prompt below is the complete, self-contained directive.

# Kimi K3 upgrade prompt

<role>
You are an expert frontend engineer, UI/UX designer, visual design specialist, and typography expert. Your task is to re-direct the visual design of **insπre**, an existing local web workbench for Pi Coding Agent (React + plain CSS, tokens centralized in `src/styles.css`, design docs in `docdoki/specs/visual-language.md` and `docdoki/specs/design-system.md`), moving it to the **Trace** design system defined below.

This is a visual and interaction redesign of an existing product, not a rebuild and not a marketing site. Before writing any code:

- Build a mental model of the current system: read the design docs, the token blocks and component styles in `src/styles.css`, `src/App.tsx`, and the representative components (`Nav.tsx`, `Transcript.tsx`, `Composer.tsx`, `CommandPalette.tsx`, `Settings.tsx`, `ResourcesPane.tsx`), and inspect current screenshots.
- Inventory what is **product semantics** and must not change: the three-region workbench and its collapse/drawer behavior; session navigation sections, pinning/hiding, pagination, and workspace explorer; the typed transcript (user bubbles, assistant document flow, thinking/tool/generic cards and their Dynamic/expanded/collapsed/Compact/hidden lifecycle); the composer and its attachment, reference, completion, model, thinking, and context-gauge controls; the resource preview's Files/Changes/History modes; the command palette, settings overlay, extension dialogs, banners, and notices; every Pi runtime state, attention state, and git presentation; the light/dark theme pair.
- Treat trust and truth boundaries as fixed: Pi remains the runtime and record authority; defensive rendering, sandboxed previews, and all host/browser separation stay exactly as they are. You are changing how the same truth is drawn, never what is drawn, never adding features, routes, settings, runtime states, metadata surfaces, or copy. Do not surface any datum the product does not already authoritatively expose (no new timestamps, counters, or provenance labels).

Then:

- Rewrite the token layer in `src/styles.css` to the Trace tokens below (both themes), and rewrite `docdoki/specs/visual-language.md` and `docdoki/specs/design-system.md` so they describe Trace as the single design authority. Components reference CSS custom properties for every recurring semantic fact — color, type size, radius, duration, elevation.
- Restyle component anatomy where Trace requires it (squared geometry, tags instead of pill chips, specimen-tag card headers, ruled navigation, docked composer, reserved search rail) by editing the existing classes and components in place, keeping their naming conventions, DOM structure, behavior, and accessibility wiring intact.
- Preserve or improve accessibility at every step: WCAG AA contrast in both themes, visible focus on every interactive element, pointer targets of at least 44×44px wherever the pointer may be coarse, and full usability at 200% browser zoom.
- Verify both themes by screenshot after each component area; light is tuned first, dark checked immediately after.

Explain your reasoning briefly as you go. Scope is exactly this visual redesign plus the docs and tests it directly changes: remove the styles and tokens this change supersedes (no commented-out leftovers), but do not perform unrelated cleanup, refactors, dependency churn, or design-contract drift beyond what the redesign touches.
</role>

<design-system>
# Design Style: Trace — Laboratory Field Manual

## Design Philosophy

### Core Principle

**Measure, don't decorate.** Trace draws the insπre workbench as a piece of laboratory equipment: a neutral drafting-film bench ruled like graph paper, machine data engraved in monospace, human prose set in a quiet sans, and exactly one signal color — the vermilion trace line of a plotter — marking everything that is interactive or alive. Ornament is abolished; structure is made visible. Every rule, folio, and tag exists because it helps the user locate, compare, or verify something in a long technical session.

### Operational & emotional qualities

**Measured, matte, legible, honest, neutral, exact.** The interface should feel like a well-kept field notebook beside a bench instrument: calm for hours of reading, instantly scannable when something changes, and plain about what is machine data versus human words. The neutrals are near-achromatic drafting grays with a faint green-gray cast — film, not paper; the only warmth in the system arrives in small, exact doses of signal vermilion. Precision comes from the grid, the rules, and the mono instrument layer. Nothing glows, floats, or shimmers. State is drawn, not suggested.

### What this design is NOT

- ❌ The current teal-on-cool-paper system with soft radii and pill chips — that is the baseline being replaced, not the target.
- ❌ A rotated warm theme: no cream, tan, beige, or brown grounds, and no orange-tinted neutrals. The surfaces are neutral graphite; the vermilion accent is a plotted line, not a palette wash.
- ❌ Aurora Mesh / Glassmorphism: no mesh gradients, no glow shadows, no backdrop-blur materials, no translucent color fields.
- ❌ Linear/Vercel-style ambient dark mode: no floating gradient blobs, no mouse-tracked spotlights, no layered soft shadows.
- ❌ Terminal pastiche: prose is never monospaced; there is no phosphor green, no ASCII ornament, no scanlines.
- ❌ Swiss-red starkness: the neutrals are softened drafting grays, not pure black-and-white; the single accent is vermilion, used in small doses, never brutalist blocks of color.
- ❌ A marketing template: there is no hero, no pricing, no testimonial pattern anywhere in this product; do not import landing-page grammar.
- ❌ Decorative: every line, tag, and texture below has a stated job.

### The DNA of Trace

#### 1. Graph-paper canvas
The application canvas carries a faint squared grid — 8px minor / 40px major lines in ink at very low alpha — visible in the open regions of the workbench (welcome surface, empty transcript margins, pane gutters) and always suppressed beneath cards, code, tables, and reading surfaces. The grid is the bench: it makes alignment visible and gives empty space a measured quality instead of a blank one. It is a flat pattern, not a gradient and not a glow.

#### 2. Ruled structure
Regions, rows, and blocks are separated by explicit 1px rules (`rule` tokens), not by background-step inference alone. The topbar ends in a baseline rule; navigation rows sit on row rules like a ledger; card headers close with a full-width rule; the composer docks against a 2px top rule; the transcript search rail is a reserved ruled row. Rules are the product's idea of honesty: the structure you see is the structure that is there.

#### 3. Two type voices, honestly assigned
**IBM Plex Mono** is the instrument voice: navigation metadata and age columns, section folios, card headers, topbar project/git identity, composer meta row, chips/tags, table headers, code, palette rows, the context gauge, and every piece of machine data the product already exposes. **IBM Plex Sans SC** is the notebook voice: session titles, transcript prose, composer input, dialog body text, and headings. IBM Plex Serif is retired; the wordmark is reset in mono with the π in KaTeX math italic. CJK always falls back to Sans SC inside mono contexts, exactly as code already does.

#### 4. One signal trace
A single signal-vermilion family marks interaction and live state: focus rings, selection, links, active markers, the running lamp, the gauge, and the one filled control style. It is a plotted line, not a wash of brand paint — it appears in small, exact doses against the matte neutrals. Semantic annotation and status hues (think violet, tool-info steel blue, success, warning, error) survive only as small witnesses: specimen tags, status glyphs, and required status fills — never prose, never chrome text, never panel grounds beyond the named washes.

#### 5. Squared geometry
The radius scale collapses to two values: `0` (plates, rules, image tiles) and `2px` (controls, tags, dialogs, bubbles). The pill is abolished — chips become squared mono **tags**. The single surviving circle is the status **lamp**: a 7px dot glyph used for running/attention/presence, read as an instrument lamp, not a shape.

#### 6. Ledger transcript
The conversation reads as a field notebook: assistant answers flow as an open document on the reading column; user entries are squared signal-wash blocks; thinking/tool activity mounts as squared **plates** whose headers are mono rows closed by a rule, with a 6px squared **specimen tag** carrying the block's semantic hue at the header's left edge. Folio styling uses only metadata the product already authoritatively exposes — the assistant round's model/time/end-reason detail, session ages, counts, and state.

#### 7. Instrument motion
State changes are near-instant (60–140ms, mostly opacity and color). Live work is shown by a stepped **sampling lamp** — a 1.2s `steps(2)` blink at reduced opacity swing — not a smooth breathing halo. Panels slide once, quickly, on a short ease-out. Streaming text never animates per token. Terminal states are perfectly still. `prefers-reduced-motion` collapses everything to opacity.

---

## Design Token System

### Colors — Light theme (primary tuning target)

```
canvas:        #f1f3f1   drafting-film bench
surface:       #fafbf9   notebook sheet, cards, plates
surface-raised:#ffffff   floating surfaces only (palette, menus, dialogs)
surface-inset: #e8ece9   recessed wells: code figures, explorer, hover
rule:          #d4dad6   1px structural rules, hairlines
rule-strong:   #b2bcb6   emphasized rules, composer top rule base, borders under stress
ink:           #1d2320   headings, primary text
body:          #303935   reading text
muted:         #5e6a64   secondary text (5.4:1 on surface)
faint:         #65716b   weakest text that is still text (4.9:1 on surface; surface/canvas grounds only, never on surface-inset)
signal:        #d94b2b   trace vermilion: focus rings, selection edge, running lamp, gauge, icons (3.7:1 on canvas — 3:1 graphics role, not small text)
signal-hover:  #c64426
signal-fill:   #b93b20   filled controls; white on-signal text passes 5.7:1
signal-deep:   #a9361d   small accent text and links on light (6.3:1 on surface — the text role)
signal-active: #8f2f19
signal-wash:   rgba(217, 75, 43, 0.07)   selection wash, user-bubble ground, drop target
on-signal:     #ffffff
success:       #3e7a44   (5.0:1 on surface)
warning:       #8f6400   (≥4.5:1)
error:         #b03225   (6.1:1; deeper and redder than signal — never interchangeable)
on-status:     #ffffff
info:          #3d6391   tool-activity annotation (steel blue witness, 5.9:1)
think:         #7e539e   reasoning annotation (violet witness, 5.6:1)
think-wash:    rgba(126, 83, 158, 0.06)
error-wash:    rgba(176, 50, 37, 0.07)
warning-wash:  rgba(143, 100, 0, 0.08)
git-modified:  = warning    identifier-list text only, ≥4.5:1
git-untracked: = success
git-conflict:  = error
selection:     rgba(217, 75, 43, 0.20)
grid-line:     rgba(29, 35, 32, 0.045)   major 40px
grid-minor:    rgba(29, 35, 32, 0.028)   minor 8px
```

### Colors — Dark theme (same component architecture, same hue family)

```
canvas:        #101311   carbon bench
surface:       #181d1a   plates and cards
surface-raised:#222824   floating surfaces only
surface-inset: #090c0a   recessed wells: code figures
rule:          #303833   structural rules
rule-strong:   #48534d   emphasized rules
ink:           #f0f3f1
body:          #d0d7d3
muted:         #99a49e   (6.5:1 on surface)
faint:         #89958e   (5.4:1 on surface; safe on inset as well)
signal:        #ff8062   raised trace coral: text-safe on dark (6.8:1 on surface) — focus, links, lamp, and the small-accent-text role
signal-hover:  #ff9578
signal-fill:   #f36a4a   filled controls carry near-black on-signal text (6.3:1)
signal-deep:   #ff8062   equals signal; contrast already ample for text
signal-active: #e05f42
signal-wash:   rgba(255, 128, 98, 0.10)
on-signal:     #1d0b06
success:       #9cc69a
warning:       #dcae5c
error:         #e8645a   (deeper red than the coral signal; always paired with its glyph)
on-status:     #1d0b06
info:          #93afd2
think:         #c0a9de
think-wash:    rgba(192, 169, 222, 0.10)
error-wash:    rgba(232, 100, 90, 0.11)
warning-wash:  rgba(220, 174, 92, 0.11)
git-modified:  = warning
git-untracked: = success
git-conflict:  = error
selection:     rgba(255, 128, 98, 0.26)
grid-line:     rgba(240, 243, 241, 0.05)
grid-minor:    rgba(240, 243, 241, 0.03)
```

**Roles and discipline.** Every accent use maps to a named role, and the graphic and text roles are not interchangeable: `signal` (identity/state **graphics**: focus ring, selection edge, lamp, gauge, checked state; on light it is a 3:1 graphics color, on dark it is also text-safe), `signal-fill` (the only filled control background; text is `on-signal`), `signal-deep` (small accent **text** and links on light surfaces — on light, `signal` itself must never be used for small text), `signal-wash` (selection rows, user-bubble ground, drop targets). Neutral surfaces carry ≥95% of every screen. The annotation hues (`think` violet, `info` steel blue) and status hues are small witnesses only — specimen tags, 14px icons, status glyphs, lamps — never prose, never chrome text, never panel fills; the one scoped exception remains identifier-list git text via the `git-*` aliases. All text/background pairs meet WCAG AA (4.5:1 body, 3:1 large text and UI graphics) in both themes; verify the muted/faint/semantic pairs by measurement, not by eye, against both `surface` and `surface-inset` (light `faint` fails on `surface-inset` and is therefore restricted to `surface`/`canvas` grounds).

**Gradients and effects.** Decorative gradients, glows, blurs, and ambient color fields are banned: they contradict the matte, measured character. Functional fades survive only where they explain hierarchy or prevent collision: the transcript's top scroll-under fade mask, and text-overflow fades. The graph grid is a flat line pattern, not a gradient.

### Typography

**Families**

- **Instrument (mono):** `"IBM Plex Mono", "IBM Plex Sans SC", ui-monospace, monospace` — all chrome and machine data as enumerated in DNA §3. Weights 400 and 500 only.
- **Notebook (sans):** `"IBM Plex Sans SC", system-ui, sans-serif` — prose, titles, dialog text. Weights 400/500/600; 600 remains the loudest weight in the product.
- **Math:** KaTeX fonts untouched; formula glyphs are never restyled, only spaced.
- **Retired:** IBM Plex Serif. The wordmark is `"IBM Plex Mono"` 500 lowercase `insπre` with the π set in the KaTeX math-italic face in `signal`; the reticle app mark keeps its geometry and moves to signal-on-ink.

**Scale** — a mature legibility floor; nothing visible sets below 12px:

```
text-micro:    12px    mono instrument labels, folios, tag text
text-sm:       13px    mono meta rows, nav rows, card summaries, code
text-base:     15px    controls, composer meta, UI text
text-reading:  16px    transcript body, composer input
text-h3:       18px    content headings (sans 600)
text-h2:       22px    content headings (sans 600)
text-h1:       28px    content headings (sans 600)
text-wordmark: 20px
leading-ui: 1.45   leading-reading: 1.62   leading-mono: 1.55
```

**Rules.** Letter-spacing is `0` everywhere, on every element, in every locale — tracking is not part of this system (micro-labels differentiate through mono, size, case, and color instead). Mono contexts that render CJK fall back to Sans SC exactly as code does today. Numeric machine data (ages, counts, percentages, token figures, the gauge) sets with `font-variant-numeric: tabular-nums` so columns of figures hold still. Transcript headings map h1→`text-h1`, h2→`text-h2`, h3→`text-h3`, deeper levels clamped, all sans 600.

### Radius, borders, elevation

```
radius-none: 0     plates, code figures, tables, image tiles, rules
radius-1:    2px   buttons, inputs, tags, dialogs, palette, bubbles, menus
lamp:        7px circle glyph — the only circle
rule:   1px solid var(--rule)
rule-emphatic: 2px solid var(--rule-strong)   composer top edge, search rail base, major bench seams
```

Elevation is nearly flat — this is a bench, not a stack of cards:

- **Level 0 (resting):** 1px `rule` border, no shadow. Plates, composer, nav rows, code figures.
- **Level 1 (anchored/transient):** `0 1px 0` hard offset rule in `rule-strong` — jump-to-latest, banners. No blur, no soft shadow.
- **Level 2 (floating):** `surface-raised` + 1px `rule-strong` border + one hard offset shadow `4px 4px 0 rgba(ink, 0.10)` (light) / `4px 4px 0 rgba(0,0,0,0.45)` (dark). Menus, pickers, notices, tags-in-flight.
- **Overlay (modal):** the Level-2 surface over a flat 55% ink scrim. No backdrop blur: the bench dims; it does not fog.

### Motion tokens

```
tick:     60ms linear         lamp state, focus ring appearance
micro:    100ms ease-out      hover color/border changes
standard: 140ms ease-out      card body collapse, menu settle
panel:    200ms ease-out      nav/context slide
sample:   1.2s steps(2) infinite   the live lamp only
```

---

## Surface & Layout Strategy

### The bench grid

- Left navigation keeps its current width behavior (default clamp 220–272px, collapsible to a 48px rail) and its resizable boundary, but the boundary is now drawn: a 1px `rule` with the resize handle riding it. The same rule separates the context pane.
- Center column: transcript and composer content constrained to a 760px reading column, centered. The topbar (48px) ends in a 1px baseline rule across all three regions — the bench's horizon line.
- The graph grid paints the `canvas` of the welcome surface, the transcript's outer margins, and empty pane states. It is always masked away beneath `surface` and `surface-inset` elements so text never fights the grid.
- Whitespace philosophy is unchanged — medium density, progressive disclosure — but separation now prefers rules over background steps: nesting depth stays at one surface level, and the grid plus rules carry the structure that soft shadows used to fake.

### Navigation

- Folder and session rows sit on **row rules**: every row has a 1px `rule` bottom border, so the list reads as a ledger. Section separation is a double rule (1px + 1px with a 3px gap), never a pill or a tint block.
- Folder headers become **folios**: mono `text-micro` 500, uppercase for Latin, `muted`, with the session count right-aligned in tabular figures in the same fixed column the ages occupy. Session rows stay single-line sans `text-sm` `ink` with the mono tabular age column at right. Curation actions still take over that column on hover/focus without moving text.
- The visible-session marker changes shape: a 3px squared `signal` block flush at the row's left edge plus a flat `signal-wash` across the full row — no fade, no gradient. A collapsed folder hiding the visible session carries the same block on its header row. Running/attention indicators are **lamps**: 7px circles in `signal`/`success`/`warning`/`error`; the running lamp samples (`motion.sample`), settled lamps rest under a 1px ring of their hue.
- The workspace explorer keeps its position and behavior; its tree rows follow the same ledger rules and git decoration grammar (colored name + letter mark, directory rollup dot), now drawn in the squared lamp idiom.

### Topbar

The 48px instrument header: session title in sans 600 (the rename affordance, unchanged), project location and git summary in **mono `text-micro`** `faint` — branch, change count, and stale/conflict coloring keep their exact current semantics, only the voice changes from sans-mixed to mono. Runtime and extension status are squared mono **tags** (below). Actions stay fixed at the right as 28px squared icon buttons (44px on coarse pointers). The model is never shown here, exactly as before. Identity degradation tiers keep their current breakpoints and order; only the drawing changes.

### Transcript

- **User entries** keep their right-aligned, compact, max-85% placement and hover-revealed actions — redrawn as squared `radius-1` blocks on a flat `signal-wash` ground with a 1px `rule` border. They expose **no new metadata**: the folio/ledger treatment is limited to data the product already authoritatively shows, and user turns currently carry no visible timestamp, so none is drawn. Extra leading space still groups a prompt with its response.
- **Assistant flow** stays an open left-aligned document on the reading column. The Details round header keeps exactly its current content ("Pi", model, time, end reason) but sets as a mono `text-micro` row closed by a 1px rule; the Divider preference draws a 24px `rule-strong` segment centered in the turn gap with no other change in meaning.
- **Thinking / tool / generic plates.** One squared anatomy replaces the tinted-edge card: `surface` ground, 1px `rule` border, `radius-none`, and a 34px mono header row — a 6px squared **specimen tag** in the block's semantic hue (`think` violet / `info` steel / `error` / `rule-strong` for unknown), the 14px tool-type icon in the same hue, a mono 500 label, a one-line mono summary that ellipsizes, the status glyph, and the disclosure chevron — closed by a full-width 1px rule. Expanded bodies are inset wells (`surface-inset`); thinking bodies add `think-wash`. The semantic color-coding of the old 3px left edge moves entirely into the specimen tag and icon; nothing else about card identity, density lifecycle, dwell minima, Compact batches, or reduced-motion switching changes. Compact tiles are the same plate shrunk: 30px squared tiles carrying specimen tag + icon + status glyph, with the detail panel opening beneath the row exactly as it does now.
- **Code figures.** Fenced code becomes a figure plate: `surface-inset` ground (dark: deeper inset), 1px `rule`, `radius-none`, a mono `text-micro` header row (language label + copy action) closed by a rule, code at `text-sm`/`leading-mono` with tabular figures. Syntax highlighting derives from the theme palette with at most five hue roles: `signal-deep`/`signal` for keywords, `warning`-adjacent for strings, `muted` for comments, `info` for literals, `ink`/`body` for the rest. Diff rendering keeps its typed added/removed/context tinting, re-grounded on the new washes.
- **Tables.** Header row in mono `text-micro` 500 `muted` over a 2px `rule-strong` baseline; body rows separated by 1px `rule`; no zebra, no outer box — a ruled ledger table.
- **KaTeX** keeps its margins, padding, and scroll containment; glyphs are never restyled.
- **Conversation search** leaves its floating placement behind: when active it occupies a **reserved 44px ruled rail** across the top of the transcript column (squared, `surface` ground, closed by a 1px `rule` base), with mono input and the same scope/count/navigation anatomy, keyboard flow, and result-jump behavior it has today. The rail reserves its own layout height and never overlays any turn, result, or the reading column; the transcript below it reflows exactly as if a header row had appeared. When search is inactive the rail is absent and the layout returns to its current form.

### Composer

The composer stops floating and **docks**: it sits flush at the bottom of the center column at reading-column width, separated from the transcript by a 2px `rule-strong` top edge — the instrument console bolted to the bench. Ground is `surface`, border `rule` on the remaining three sides, `radius-none`. Attachment chips become squared mono tags; image tiles stay 64px squared `radius-none` with the same corner removal action and the same viewer (flat scrim, crisp shadowless image, identical zoom/pan/dismiss behavior). Model and thinking controls keep their quiet dropdown anatomy and menu behavior, restyled squared with mono values. The context gauge keeps its ring-plus-percent form, thresholds, and tooltip, drawn in `signal`/`warning`/`error`. Focus draws a 2px `signal` outline on the whole dock; drop targeting fills `signal-wash` with a dashed `signal` border. The welcome-surface composer uses the identical docked anatomy on the graph-grid canvas, its project-address row embedded exactly as now.

### Tags (replacing chips)

Every former pill chip becomes a **tag**: `radius-1`, mono `text-micro` 500, 2px×8px padding, 1px border in the variant hue at 40%, ground in the hue at 8% (muted variant: `surface-inset` + `rule`). Live states (running, retrying, compacting, reconnect, live tool) prepend a 7px sampling lamp in their hue instead of a breathing halo; terminal states rest. Tags enter by simple opacity over `motion.micro`. The mock badge keeps its warning variant.

### Palette, settings, dialogs, notices

- **Command palette, settings overlay, extension dialogs, confirmations** are Level-2/Overlay plates: `surface-raised`, `radius-1`, 1px `rule-strong` border, the hard offset shadow, over the flat scrim. Palette rows set in mono; group headers are mono `text-micro` uppercase folios; the active row takes a flat `signal-wash` with a 3px squared `signal` block at its left edge. Widths, focus trapping, nesting, Escape semantics, and settings sectioning are unchanged.
- **Toasts** are squared Level-2 plates with a specimen tag in their semantic hue; **banners** are full-width ruled strips on `error-wash`/`warning-wash` grounds under the topbar. All triggers, persistence, and recovery semantics unchanged.
- **Empty states** keep their icon/title/hint stack, set with the mono folio for the hint.
- **Scroll rails** become instrument sliders: a 4px squared thumb in ink at 30% resting on the pane boundary rule, rising to full strength on scroll/hover and settling after idle, with the same drag behavior, accessibility hiding, and boundary priority.

### Focus & keyboard

`:focus-visible` draws a 2px `signal` outline with a 2px offset, squared, on every interactive element in both themes; no focus styling on plain mouse click. Text fields use the shared field grammar: border settles on `signal` with a flat `signal-wash` interior — no halo blur. Wrappers light up only for the field they carry.

---

## Signature Choices (non-negotiable)

1. **The graph grid is real.** Welcome surface, transcript margins, and empty panes show the 8px/40px grid at the specified alphas; it is masked under every reading surface.
2. **Rules carry structure.** Topbar baseline, region seams, navigation row rules, card-header rules, composer top rule, search rail base — all drawn, all `rule`/`rule-strong`, no implied separation by shadow.
3. **Two voices, no third.** Mono owns chrome and machine data; sans owns prose and titles; serif is gone. A screen that mixes them arbitrarily has failed.
4. **One signal hue, neutral everything else.** The vermilion trace is the only interactive color; it never becomes a panel fill, a banner ground, or a gradient stop, and the neutrals stay neutral — no cream, tan, or brown grounds.
5. **Squared everything.** No radius above 2px, no pills; the lamp is the only circle.
6. **Specimen tags, not tinted edges.** Semantic block color lives in the 6px tag and 14px icon of plate headers; the old 3px left-edge card grammar is retired.
7. **The lamp samples.** Live state blinks in `steps(2)`; nothing breathes, pulses, or glows smoothly.
8. **Tabular machine figures.** Ages, counts, gauge, and token figures never cause lateral jitter.
9. **Letter-spacing 0 everywhere** — no tracked labels in any locale.
10. **Flat scrims.** Overlays dim the bench; they never blur it.
11. **The search rail reserves its row.** Transcript search occupies a reserved 44px ruled rail; it never floats over or underlaps any turn or result.

## Anti-Patterns (what to avoid)

- ❌ Reintroducing teal, cool-green paper, pill chips, or the 3px tinted card edge "because one component looked better that way." Trace is a whole system; partial application reads as a bug.
- ❌ Drifting the neutrals warm — cream, tan, beige, brown, or orange-tinted surfaces recreate the one-note theme this direction exists to avoid. The bench is graphite; only the trace is vermilion.
- ❌ Glows, mesh gradients, ambient blobs, backdrop blur, soft multi-layer shadows, gradient text — the Aurora Mesh/Glassmorphism/Modern-Dark vocabulary is banned here.
- ❌ Monospaced prose or transcript body text — that is Terminal pastiche and it harms long reading.
- ❌ Pure black `#000` grounds or stark white reading surfaces; the neutrals are softened drafting grays by design (`surface-raised` `#ffffff` is reserved for floating plates only).
- ❌ New features or metadata dressed as styling: no added panels, stats, badges, timestamps, routes, settings, or hero/marketing blocks. The redesign draws only the truth the product already exposes.
- ❌ Shadows on resting surfaces; borderless floating cards; radius improvisation outside `{0, 2px}`.
- ❌ Per-token streaming animation, breathing halos, or any looping motion that is not the sampling lamp or a spinner.
- ❌ Tracking/letter-spacing as a hierarchy device; weight 700+; visible text below 12px or outside the scale.
- ❌ Color as the only carrier of state — lamp, glyph, and label channels stay paired exactly as the product already requires.

## Responsive Behavior

- All breakpoints, drawer behaviors, degradation tiers, and layout thresholds keep their current values; only the drawing changes. Squared geometry, rules, and the two-voice type system persist at every width.
- **Coarse pointers:** every interactive target — icon buttons, nav curation actions, tags, menu rows, palette rows, composer controls, gauge, send/abort — presents at least **44×44px** on touch/coarse-pointer media (the touch layout may keep visual density via padding while the hit area meets the floor). Existing touch accommodations (visible turn actions, 40px+ pagination control, wrapped composer meta rows) remain and are measured against the 44px floor.
- **Zoom:** the full workbench remains usable at **200% browser zoom** — no clipped controls, no overlapping or unreachable regions, no lost focus targets; horizontal scrolling is confined to code figures, tables, and math as it is today.
- Below 900px the navigation drawer and its scrim adopt the same ruled, squared treatment; below the composer wrap breakpoint the meta row stacks as it does today with mono labels kept legible.
- The graph grid remains visible on the welcome surface at all widths; on narrow viewports it continues under the same masking rules.

## Accessibility

- Every text/background pair meets WCAG AA in both themes (4.5:1 body, 3:1 large text and UI graphics). On light, `signal` is a 3:1 graphics role only; small accent text and links use `signal-deep`. Light `faint` is restricted to `surface`/`canvas` grounds. Verify `muted`, `faint`, and the semantic hues by measurement against both `surface` and `surface-inset`.
- Focus is always visible: the 2px squared `signal` outline with 2px offset, or the field focus grammar for text inputs. Focus order, trapping, restoration, and combobox/listbox semantics are preserved untouched from the current implementation.
- State is never color-only: lamps pair with glyphs and labels; git state pairs name color with letter marks; the gauge pairs hue with a percentage. This matters doubly in dark theme, where signal coral and error red are near neighbors.
- `prefers-reduced-motion` collapses all transitions to opacity and freezes the sampling lamp to a steady lit state; live state remains fully legible without motion.
- Scroll rails stay hidden from the accessibility tree; wheel and keyboard scrolling remain native.

## Implementation Guidance (React + plain CSS)

1. **Tokens first.** Replace the `:root` / `[data-theme="dark"]` custom-property blocks in `src/styles.css` with the Trace tokens above (renaming is allowed if every consumer is updated in the same pass; e.g. `--accent*` → `--signal*`, `--hairline*` → `--rule*`). Delete retired tokens (pill radius, breathe halo, serif wordmark faces) in the same commit that removes their consumers.
2. **What must be a token, and what may stay local.** Every *recurring semantic fact* is a custom property and is referenced by variable only: all raw colors (including alphas and washes), the type scale, the radius scale, the elevation recipes, and the motion grammar. There is no parallel token system and no per-component color, size-scale, radius, or duration invention. Stable component geometry — a card header's 34px height, the lamp's 7px glyph, the 64px image tile, the 44px rail and hit-area floors, paddings that exist once — may remain as local `px` values where it always has, and genuinely local, evidence-backed optical corrections (a 1px nudge that you can justify in a comment or screenshot) are permitted. Raw hex/rgb color literals and off-grammar durations in component styles are not permitted; grep for those before considering the token pass done.
3. **Anatomy edits stay in place.** Squared geometry, tag restyle, plate headers, ruled nav rows, docked composer, reserved search rail, and mono voice changes are edits to the existing classes in `src/styles.css` and the existing JSX in `src/components/**`. Do not restructure component trees, rename public behavior, or touch store/events/server code. The card density lifecycle, Compact batch logic, completion, palette, modal-focus, and search behavior code should not need logic changes — only the classes and placement they render change appearance.
4. **Fonts.** Drop the Plex Serif `@font-face` blocks and assets with the wordmark restyle (mono `insπre` + KaTeX π). Keep the integrity-pinned Sans SC and Mono deliveries exactly as they are; add no new font dependency. If the wordmark restyle touches `Wordmark.tsx` or the icon SVGs, keep the reticle geometry and swap only color/letterforms.
5. **Docs are the contract.** Rewrite `docdoki/specs/visual-language.md` and `docdoki/specs/design-system.md` to describe Trace as written here, including the token table, so the docs, tokens, and components agree with one authority. Update `spec_abstract.md`'s front-end paragraph to the new voice (drafting-film/graphite neutrals, signal vermilion, two type voices, squared ruled surfaces). Do not drift any other contract, and do not broaden into repository-wide cleanup.
6. **Verification.** After the token pass and after each component area, capture light and dark screenshots of: navigation + transcript with thinking/tool plates, Compact tool batch, code figure + table + math, composer dock (idle/focused/drop-target), active search rail mid-transcript, palette, settings overlay, welcome surface, and a phone-width drawer layout. Compare against this system's signatures, and run the existing web test suite; appearance-only changes should not require behavior-test changes beyond intentional class/structure assertions.

## What Success Looks Like

A correct Trace implementation of insπre:

- Reads in a screenshot as a **bench instrument with a field notebook open on it** — ruled, squared, neutral, measured — and could not be mistaken for the old teal/paper build, for a warmed beige/orange variant of it, or for any generic AI chat surface.
- Makes Pi state the loudest thing in the room: the sampling lamp, specimen tags, and mono status folios are findable in under a second on any screen.
- Lets a two-hour technical reading session pass without fatigue: prose in quiet sans on a neutral sheet at a 16px floor, code in inset figures, machine data in steady tabular mono.
- Keeps every existing workflow, state, metadata surface, and boundary bit-for-bit truthful; a user of the old build loses nothing but the old skin.
- Passes AA contrast in both themes, 44px coarse-pointer floors, 200% zoom, and reduced-motion, verified by measurement and screenshot.

It fails if it merely retints the old soft system, if the neutrals drift warm, if mono leaks into prose, if any glow or blur returns, if the grid becomes decoration on top of text, if the search rail overlays content, or if a single product behavior had to change to accommodate the look.
</design-system>
