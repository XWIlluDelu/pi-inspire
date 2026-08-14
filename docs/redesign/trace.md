# Trace — Laboratory Field Manual

## Status

This is a direction-level reference prompt, not an implementation specification or an approved redesign.

It preserves the useful core of the Trace exploration while leaving concrete layout and component choices open. Use it as a style and decision aid, then reinterpret it against the current product and feedback.

---

## Product boundary

insπre is a local, browser-based workbench for Pi Coding Agent.

It is a three-region workbench:

- session navigation
- a dominant conversation surface
- an on-demand context/resource pane

The transcript contains typed user, assistant, thinking, tool, and activity content. The composer owns message text, references, attachments, model and thinking controls, steering, and follow-ups. Resource preview, command palette, settings, dialogs, banners, notices, git state, and Pi runtime state are product semantics.

Any redesign changes **how the same truth is drawn**, not what the product is allowed to say or do.

Do not add visible features, metadata surfaces, shortcuts, settings, timestamps, counters, or controls merely to make the visual system feel complete.

---

## Why Trace exists

The current interface is calm and competent, but it can feel too light, too soft, and too close to a generic quiet tool page.

Trace exists to push the product toward something more:

- square
- composed
- intentional
- mature
- less decorative
- less soft
- less “floating widget”
- more like a real workbench surface

The useful question behind Trace is:

> How can a Pi-rendering workbench feel more structured and more mature without turning into a laboratory prop or a marketing page?

---

## Design philosophy

**Measure, don't decorate.**

Prefer explicit structure, exact state, and readable hierarchy over ambient styling.

The interface should feel:

- calm for long reading
- scannable when state changes
- honest about which information is human prose and which is machine output
- visually disciplined without becoming cold or generic

Desired qualities:

- measured
- matte
- legible
- neutral
- exact
- quiet under sustained use

The design should make alignment and boundaries visible only where they help location, comparison, or verification.

---

## Directional DNA

### 1. Squared geometry

Use square or nearly square geometry as the primary visual signature.

Avoid pills and soft consumer-chat bubbles as the default language.

Controls, tags, dialogs, cards, and image surfaces should feel precise and aligned rather than inflated.

Squared does not mean brittle: hit targets, focus states, touch usability, and comfortable spacing remain product requirements.

### 2. Neutral instrument material

Move away from the current cool-green paper plus teal identity toward a more neutral drafting-film / graphite material family.

The interface should feel matte and quiet rather than warm, creamy, glowing, glassy, or heavily tinted.

Color should be concentrated in a small number of semantic witnesses rather than spread across panels.

### 3. One restrained signal voice

Use one restrained signal color family for interaction and live state.

It should mark:

- focus
- selection
- active state
- links
- live work

Use it in small exact doses.

Do not turn it into a broad brand wash, a banner ground, or a decorative gradient stop.

Status and annotation hues remain semantic witnesses, not general chrome colors.

A yellow-led accent language is acceptable here, so long as it stays restrained, intentional, and clearly tied to interaction rather than decoration.

### 4. Two honest type voices

Separate machine data from human prose more clearly than the current system does.

A monospaced voice may own instrument-like metadata such as:

- paths
- ages
- model identifiers
- git state
- counts
- table headers
- code

A humanist sans voice should own:

- prose
- session titles
- composer input
- dialog text

Do not monospace long-form prose.

CJK readability is a hard product constraint.

### 5. Explicit structure, used selectively

Prefer visible boundaries where they clarify regions, rows, state, and attachment.

Use rules, alignment, and spacing as structural evidence rather than relying only on background-step inference.

Do not apply lines uniformly everywhere. If every row, card, pane, and header has the same rule strength, the result becomes noisy rather than measured.

### 6. State as instrument reading

Pi state should be immediately findable and never carried by color alone.

Live work, attention, success, warning, failure, and settled states need stable shape, glyph, label, and placement channels.

Live state may feel sampled or instrument-like, but terminal states should be still.

Avoid breathing halos, per-token animation, decorative pulses, and motion that calls attention after the state has settled.

---

## What this direction is not

- not the current teal/paper system with soft pill chips
- not a warm beige, brown, or orange theme
- not Aurora Mesh, Glassmorphism, glow, blur, or ambient gradient fields
- not a Linear/Vercel-style ambient dark mode
- not terminal pastiche: no phosphor green, scanlines, ASCII ornament, or monospaced prose
- not Swiss-red brutalism or a pure black-and-white poster
- not a landing page, hero, pricing, testimonial, or marketing template
- not a license to draw every boundary or to make the interface look like a generic debugger

---

## Encouraged design ambition

This direction may be ambitious.

It is allowed to aim for:

- a high-end, award-worthy level of visual polish
- a more distinctive composition than a generic tool page
- a more refined use of geometry, spacing, and typography
- a workbench that feels like it was designed with intent rather than assembled from defaults
- a more artful, more experimental, more memorable result when that helps the product feel truly designed

Treat the browser as a real design canvas, not only as a container for controls.
Aim for the quality bar of award-winning product and interface work, not just for something merely serviceable.
Feel free to be bolder in service of a more mature, elegant, and unmistakably intentional result.

But that ambition must still serve the product.
Do not confuse ambition with noise.
The goal is not to decorate more; the goal is to make the interface feel more deliberate, more mature, and more complete.

---

## What the designer must decide later

This document deliberately does **not** prescribe the following:

- exact color values or token names
- exact dimensions, spacing, breakpoints, radii, or line thickness
- whether the composer floats, docks, or uses another structure
- where model, thinking, attachment, context, or send controls appear inside the composer
- whether transcript search uses a floating control, reserved row, or another placement
- what controls belong in the topbar
- how large the workspace explorer or context pane should be
- whether a grid, ruled rows, specimen tags, lamps, folios, or ledger patterns are appropriate
- how cards, code blocks, tables, settings, palette, dialogs, or resource previews are anatomized
- which files, tokens, components, tests, or docs should be edited
- which validation artifacts or delivery sequence should be used

Those decisions belong to a future design task grounded in the current product and explicit feedback.

---

## Guardrails for future interpretation

- Preserve the current product's information architecture and interaction semantics.
- Do not shrink or redefine functional components to fit the visual metaphor.
- Do not move controls merely to make the layout look more instrument-like.
- Do not add new visible controls or metadata.
- Keep long-form reading and CJK text comfortable.
- Keep code, tables, math, attachments, and resource previews usable at real content sizes.
- Keep focus visible, targets comfortable, keyboard flow intact, and motion respectful.
- Prefer fewer, stronger structural decisions over many small decorative witnesses.
- If a Trace-like technique creates fatigue, remove the technique rather than adding more rules to control it.
- Use these guardrails as orientation, not as a substitute for judgment; leave room for the designer to make a stronger solution when the product benefits from it.

---

## Success question

A future interpretation succeeds only if it can answer:

> What product problem does this Trace-derived choice solve better than the current interface, and can that improvement survive real content, real states, both themes, narrow viewports, and long sessions?

If the answer is only “it looks more like Trace,” the choice should not be adopted.
