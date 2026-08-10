<role>
You are a senior frontend engineer, product designer, interaction designer, visual-systems designer, and typography specialist. Your task is to redesign the frontend of **insπre**, the graphical workbench for Pi Coding Agent, into a more mature, distinctive, and product-ready visual experience.

This is a real design upgrade, not a maintenance pass and not a request to preserve the current visual system unchanged.

Preserve the product's meaning:

- Pi remains the runtime and session authority.
- Conversation remains the primary workspace.
- Navigation, transcript, composer, Files, Changes, History, settings, command palette, notices, and recovery states retain their current jobs.
- Security, persistence, streaming, conflict, lifecycle, and accessibility semantics remain truthful.
- Do not invent new features, routes, settings, states, or marketing content.

The visual system is editable. You may redesign the palette, surface topology, typography hierarchy, spacing, radii, component anatomy, navigation chrome, composer, activity blocks, code/table presentation, overlays, responsive composition, motion, and brand expression. The existing design documents and CSS are evidence about the product, not the visual target you must copy.

Before writing code:

1. Read `docdoki/northstar.md`, `docdoki/spec_abstract.md`, and the relevant specs to understand product invariants and workflows.
2. Inspect `src/styles.css`, `src/App.tsx`, and every component that owns an affected surface.
3. Run the current mock in a real browser and capture light/dark desktop and phone baselines.
4. Separate behavior that must remain from presentation that should change.
5. Identify the exact old CSS and component treatment that the new design replaces; do not leave two competing visual systems.

Do not ask routine discovery questions. Ask only when product evidence cannot resolve a decision that would change behavior or scope. Otherwise proceed autonomously.

Implement the complete design direction as one coherent system:

- Rewrite the design tokens and visual contract to the new target.
- Reuse the current React and plain-CSS architecture.
- Use semantic custom properties rather than local raw colors.
- Use Lucide icons where an established icon exists.
- Remove superseded styles and component markup.
- Keep unrelated runtime and architecture untouched.
- Update `docdoki/specs/design-system.md` and `visual-language.md` when the implemented design contract changes.
- Verify the result with real-browser screenshots, responsive checks, accessibility checks, focused tests, and the repository's decisive final check.

When complete, report the design direction, the surfaces transformed, the most important before/after decisions, and the exact verification evidence. Do not claim success from code inspection alone.
</role>

<design-system>
# Design Style: Editorial Instrument

## Design philosophy

### Core principle

**A technical workbench should feel edited, not decorated.**

Editorial Instrument combines the disciplined hierarchy of Swiss editorial design, the exact geometry of precision instruments, and the efficiency of contemporary professional software. It gives insπre stronger structure, clearer surface ownership, and a more authored visual identity without turning the product into a themed dashboard.

The upgrade should be visible immediately. The new insπre uses a dark graphite instrument frame around a bright document plane, more decisive typography, flatter and sharper controls, stronger alignment, fewer pills, a docked command deck, dark code slabs, and reserved rails for transient controls. It should still be calm after hours of use.

### Emotional qualities

Composed, exact, authoritative, lucid, tactile, contemporary, focused, trustworthy, quietly distinctive.

### Operational qualities

Fast to scan, stable under streaming, comfortable for long reading, explicit about state, efficient with keyboard and pointer, resilient on narrow screens, and visually coherent across normal and failure paths.

### Visual references

- A meticulously typeset scientific journal translated into interactive software.
- A precision measurement instrument with clear controls and readouts.
- A mature editorial production tool where content remains primary.
- Contemporary industrial design: dark housing, light working plane, deliberate materials.

These are reference qualities, not motifs. Do not add decorative equations, laboratory imagery, measurement ticks, fake hardware screws, or scientific wallpaper.

## What this design is NOT

- Not the current interface with slightly adjusted teal values.
- Not a generic light SaaS dashboard with pale cards everywhere.
- Not a consumer chat application with large message bubbles.
- Not a terminal or IDE clone.
- Not monochrome editorial luxury, beige paper, or fashion-magazine styling.
- Not cyberpunk, glassmorphism, neumorphism, neo-brutalism, or retro computing.
- Not a marketing page: no hero feature copy, pricing cards, testimonials, stats bands, or final CTA.
- Not decorative minimalism: whitespace does not replace useful state or controls.
- Not a card collection: page regions and sections are not floating cards.

## The new design DNA

### 1. Graphite frame, paper document plane

In light mode, the left navigation becomes a deep graphite instrument frame. The center workspace is a cool white document plane. The context pane is a precise inspection surface that sits between them in tone. This strong material contrast replaces the current nearly uniform pale shell and makes navigation, reading, and inspection recognizable at a glance.

Dark mode uses the same ownership model without simply inverting colors: the frame becomes near-black, the document plane becomes a dark mineral surface, and raised/inset levels remain distinct through controlled value steps.

### 2. Editorial hierarchy instead of card hierarchy

Assistant content reads as a composed technical publication. Hierarchy comes from measure, type scale, rules, indentation, and semantic rails. Repeated card shells are reduced. Sections use open layouts and one structural boundary at most.

### 3. Instrument controls, not friendly pills

Controls are compact, rectangular, and optically exact. Most use 4px corners. Pills are reserved for true status capsules and small categorical chips. Icon buttons keep stable square bounds. Selected, focused, running, and failed states do not change component geometry.

### 4. A command deck for the composer

The composer becomes a docked command deck rather than a floating chat bubble. Text entry remains dominant, while model, thinking, resources, context, and send controls form a stable lower instrument strip. The deck feels attached to the workspace and ready for sustained work.

### 5. Semantic index rails

Thinking, tools, extension output, warning, and failure blocks use a narrow semantic rail, a compact index glyph, and a short label. Color appears in these small witnesses, not in large filled panels. The rail system becomes a recognizable insπre signature.

### 6. Dark code slabs

In light mode, code blocks use a charcoal slab with light syntax text. This creates a deliberate visual anchor inside long technical documents and clearly separates executable/machine material from prose. In dark mode, code becomes a deeper inset plane rather than another raised card.

### 7. Reserved command rails

Search, banners, and other persistent controls receive explicit space in the layout. Transcript search becomes a reserved command rail within the conversation header zone, never a floating pill that covers a user turn or search result.

### 8. Alignment as brand expression

Shared header heights, fixed metadata columns, aligned icon boxes, stable trailing actions, tabular numbers, and consistent baseline relationships carry more identity than decoration. The interface should look calibrated even when no accent color is visible.

## Substantive departures from the current interface

The implementation must make all of these visible:

1. Replace the all-light navigation shell in light mode with a graphite frame.
2. Replace broad soft rounding and frequent pills with sharper instrument geometry.
3. Replace the floating transcript-search pill with a reserved search rail that cannot cover content.
4. Replace the floating-chat impression of the composer with a docked command deck and stable control strip.
5. Replace light code containers with dark code slabs in light mode.
6. Increase the reading and control type scale while reducing dependence on 11-12px text.
7. Flatten settings, command palette, and context sections so they no longer read as cards nested inside an overlay or pane.
8. Replace the large decorative π watermark with a more controlled brand lockup and one structural calibration rule.

These are design requirements, not optional ideas.

## Color system

### Light theme

```text
frame                 #171c1a   graphite navigation housing
frameRaised           #202724   hover/selected frame surface
frameInset            #101412   deep frame input/inset
frameLine             #303a36   frame boundaries
frameInk              #edf2f0   primary text on frame
frameBody             #c8d1cd   ordinary frame text
frameMuted            #9fada7   secondary frame text

canvas                #f1f4f2   workbench background
document              #ffffff   transcript/document plane
surface               #f8faf9   controls and quiet panels
surfaceRaised         #ffffff   anchored menus and raised details
surfaceInset          #e8eeeb   selected rows, fields, code-adjacent chrome
line                  #d5ded9   ordinary rules
lineStrong            #aebbb5   active/structural rules
ink                   #18201d   strongest text
body                  #33403b   reading and control text
muted                 #5d6b65   secondary text
faint                 #65736d   weakest text, still AA on document

accent                #07877f   focus, identity, selection edge
accentText            #08766f   links and small accent text
accentHover           #009b91
accentFill            #08766f   filled primary controls
accentActive          #075f5a
accentTint            rgba(7, 135, 127, 0.09)
onAccent              #ffffff

reasoning             #7656b2
reasoningTint         rgba(118, 86, 178, 0.08)
tool                   #3d63b8
toolTint               rgba(61, 99, 184, 0.08)
success                #2d7b4b
warning                #946200
error                  #b43d38
```

### Dark theme

```text
frame                 #090c0b
frameRaised           #151b18
frameInset            #050706
frameLine             #28312e
frameInk              #f2f5f4
frameBody             #cbd3cf
frameMuted            #929f99

canvas                #101513
document              #151b19
surface               #1d2421
surfaceRaised         #252e2a
surfaceInset          #0a0e0c
line                  #303a36
lineStrong            #4a5751
ink                   #f1f5f3
body                  #d1d8d5
muted                 #9aa6a0
faint                 #89968f

accent                #55ded2
accentText            #55ded2
accentHover           #78e8df
accentFill            #45cfc4
accentActive          #2da99f
accentTint            rgba(85, 222, 210, 0.10)
onAccent              #071d1a

reasoning             #b8a3ec
reasoningTint         rgba(184, 163, 236, 0.10)
tool                   #82ace0
toolTint               rgba(130, 172, 224, 0.10)
success                #65c98f
warning                #e2b35d
error                  #e88981
```

### Color rules

- Neutral surfaces occupy at least 90% of each screen.
- The graphite frame is a structural material, not a dark-theme preview.
- Teal is the only decorative/interactive brand hue. Use `accentText` for links and small text in light mode; `accent` is primarily a focus/graphic role there.
- Reasoning, tool, success, warning, and error colors are semantic witnesses only.
- No broad teal panel fills, colored prose, rainbow navigation, or decorative semantic color.
- Functional fades and masks may use gradients when they solve a spatial problem. No ornamental gradients, mesh backgrounds, glow fields, or gradient text.
- All text and UI-graphic contrast must pass WCAG AA in both themes.

## Typography

### Font system

Retain IBM Plex because it already solves the product's mixed Chinese/Latin/technical requirements, but give it a new hierarchy:

- UI and reading: `IBM Plex Sans SC`, system sans fallback.
- Code and machine data: `IBM Plex Mono`, Sans SC CJK fallback.
- Brand only: `IBM Plex Serif` italic for `insπre`; do not use serif for ordinary headings or prose.
- KaTeX owns mathematical glyphs.

Keeping the family is not permission to keep the current scale or spacing unchanged.

### New type scale

```text
micro       12px     short metadata only
small       13px     secondary UI, code headers, compact rows
ui          15px     navigation, controls, composer controls
reading     16px     transcript prose and user text
h3          18px
h2          22px
h1          28px
brand       42px     welcome wordmark only
```

### Type rules

- Running text uses 16px/1.68 with a readable measure of approximately 68-78 characters.
- UI uses 15px/1.4; do not solve density by dropping below 13px.
- Weights are 400, 500, and 600 only.
- Letter spacing is `0` everywhere.
- Numeric columns, ages, counts, percentages, and context values use tabular figures.
- Headings use space and rule relationships, not oversized weight.
- Code uses 13px/1.6 on desktop and remains at least 13px on mobile.
- Truncation may hide only low-priority metadata. Operational labels wrap or disclose their full value.

## Spacing and geometry

### Base system

Use a 4px unit with this scale:

```text
4, 8, 12, 16, 20, 24, 32, 40, 48, 64
```

### Radius system

```text
inline       3px
control      4px
container    6px
overlay      10px
pill         999px, status/chip only
```

### Boundary system

- Ordinary rule: 1px `line`.
- Active structural rule: 2px `accent` or `lineStrong`.
- Semantic activity rail: 3px semantic hue.
- Major region boundaries come from material change, not extra borders.
- Resting surfaces use no shadow.
- Anchored menus may use a restrained 0 8px 24px shadow.
- Dialogs may use 0 24px 64px shadow plus a functional scrim.
- Dark mode uses value steps and borders before shadow.

Do not put cards inside cards. A page section, pane section, or overlay section is not automatically a card.

## Layout strategy

### Desktop

```text
navigation frame     clamp(248px, 18vw, 280px)
collapsed rail       52px
topbar                52px
reading plane         max 840px
context pane          clamp(400px, 38vw, 760px)
composer deck         same axis and max width as reading plane
```

The navigation frame runs full height and visually owns its header. The center topbar and transcript share the light/dark document material. The context pane has its own inspection surface and a strong internal header, but does not look like a separate app.

### Document composition

- Transcript content is centered within the document plane.
- Assistant prose uses the full reading measure.
- User turns may be narrower but should not become tiny speech bubbles.
- Activity blocks align to the document axis and never exceed its width.
- The composer deck aligns exactly with the transcript measure and sits in a reserved bottom zone.
- Search occupies a reserved rail below or within the topbar; it never overlays transcript rows.

### Responsive recomposition

Below the point where the center reading plane would become cramped:

- Navigation becomes a graphite drawer with a visible internal close control, focus containment, and a scrim.
- Context becomes a full-height inspection drawer or sheet.
- Topbar uses explicit priority tiers: session identity, essential state, essential actions; project path and branch text yield before title.
- Search becomes a full-width row.
- Composer controls reflow into two stable rows; send/abort remains fixed at the trailing edge.
- Code and math scroll locally without causing page-level overflow.
- Touch hit areas are at least 44x44px even when visible icons remain 16px.

Verify 1536x1000, 1280x800, 900x900, 768x1024, 390x844, and 360x800.

## Brand expression

### Welcome surface

The welcome surface is a functional start screen, not a landing hero.

- Keep the reticle and italic `insπre` wordmark as the first product signal.
- Increase the wordmark to the 42px brand role and pair it with one 1px horizontal calibration rule terminating in a 6px teal square.
- Remove the giant decorative π watermark.
- Keep one concise tagline and the fully functional composer deck.
- Recent sessions and project selection appear as useful workbench content, not feature marketing.
- The graphite navigation frame remains visible on desktop so the product identity begins as a workbench, not a blank page.

### Repetition rule

The calibration rule and brand lockup appear only on welcome and rare full-empty states. Do not repeat reticles, π marks, rules, or teal squares as decoration throughout the app.

## Component treatments

### Navigation frame

- Deep graphite background in light and dark themes.
- Project headers use `frameBody`, medium weight, and stable disclosure geometry.
- Session rows are 36-40px high with fixed icon, title, age/status, and action columns.
- Hover uses `frameRaised`; active selection adds a 2px teal leading rail and a restrained raised surface.
- Running state uses one breathing teal point; terminal attention is static.
- Row actions occupy reserved space and never shift the title.
- Search uses the frame inset material with a visible border and 15px input text.
- The collapsed rail keeps the graphite material and uses tooltips for unfamiliar icons.

### Topbar

- Treat the topbar as an editorial masthead for the current session.
- Session title is primary; project and Git are compact mono metadata; status and commands remain visually separate.
- Use thin vertical rules between semantic groups only when spacing alone is insufficient.
- Replace excessive pills with small squared status capsules or icon+text readouts.
- Fixed actions use 32px visual bounds on desktop and 44px hit areas on touch.
- Nothing in the topbar may collide or compress below its legible minimum.

### Transcript search rail

- Reserve a 44px row below the topbar when search is present.
- Use one rectangular field, scope menu, result count, and previous/next controls.
- The rail may collapse to an icon when inactive on wide screens, but expansion reserves space rather than floating over content.
- Search results use a restrained accent tint and visible current-result marker.

### User turns

- Use a lightly tinted, low-radius rectangular field with a 2px accent edge or top rule.
- Maximum width 82%; padding 12-16px; 16px reading text.
- Avoid cartoon bubbles, tails, avatars, and oversized empty padding.
- Copy/fork actions sit in a stable action gutter and remain accessible on touch.

### Assistant document flow

- No answer card around the assistant response.
- Use 28/22/18px headings, stronger paragraph rhythm, editorial list indentation, and 24px separation between major blocks.
- Short horizontal rules may separate prompt/response groups but never every paragraph.
- Links use accent text and a visible underline on hover/focus.
- Tables, code, math, task lists, and activity blocks form one coherent document rhythm.

### Thinking and tool blocks

- Resting block: 6px radius, `surface` background, 1px line, 3px semantic rail.
- Header: 38px minimum, 16px icon box, 13px label, one-line summary, bounded status, chevron.
- Expanded body is separated by one rule, not another nested card.
- Compact tools become rectangular index tiles: icon + short verb + status mark, not tiny icon-only pills.
- Selected tool detail opens in a single shared detail plane below the batch.
- Running blocks may breathe at the rail or status point only; the panel itself never pulses.
- Failure changes rail, icon, and recovery action; it does not flood the panel red.

### Code blocks

Light theme:

```text
background       #171c1a
header           #202724
border           #303a36
text             #edf2f0
muted            #9fada7
selection        rgba(85, 222, 210, 0.18)
```

Dark theme uses `surfaceInset` with `lineStrong`.

- 6px radius, one header bar, language label at left, copy at right.
- No macOS traffic-light decoration.
- Horizontal scrolling stays inside the code slab.
- Syntax colors are restrained and accessible; avoid rainbow highlighting.

### Tables

- Open editorial table, not a card.
- 1px horizontal rules; one stronger rule under the header.
- Header uses 13px/600 and `surfaceInset` only when needed for dense comparison.
- Numeric columns align right with tabular figures.
- No decorative zebra striping.
- Wide tables scroll within a clearly bounded region.

### Composer command deck

- Use a 6px container with a stronger top edge and subtle raised surface.
- Textarea is open and quiet, 16px, auto-growing, with no inset inner card.
- Staged files/images appear in one horizontal attachment shelf with stable dimensions.
- Lower control strip uses grouped rectangular controls separated by spacing or 1px rules.
- Model and thinking controls show full meaningful labels; resource controls use icons with tooltips.
- Context gauge is a compact numeric readout with a small ring, not a decorative badge.
- Send/abort uses one stable 40px visual square and a 44px touch target.
- Focus highlights the deck boundary and active field without double rings.
- Busy, queued, conflict, offline, and recovery states preserve the deck's geometry.

### Context pane

- Use a strong 52px inspector header aligned with the main topbar.
- Files, Changes, and History are rectangular mode tabs with a clear underline/rail, not pills.
- Lists follow the navigation's fixed-column discipline on a light/dark inspection surface.
- File/diff content appears as a document sheet without being wrapped in another card.
- Metadata uses mono only where it is machine data.
- Loading, missing, unauthorized, ambiguous, truncated, and failed states retain the same inspector anatomy.

### Settings

Desktop settings become a composed two-zone dialog:

- Left: narrow section index on the overlay surface.
- Right: form content with section headings, rules, and aligned label/control columns.
- Remove stacks of section cards inside the dialog.
- Inputs are rectangular, 36-40px high, with visible labels and concise consequence copy.
- Destructive controls live in one separated terminal section.
- On mobile, collapse to one scrollable column with a sticky title/close row.

### Command palette

- One 600-680px overlay with 10px radius.
- Search field is flush with the top; result groups are open lists divided by labels/rules.
- Selected row uses accent tint plus a 2px leading marker.
- Command, target, and shortcut metadata align to stable columns.
- Do not wrap every result in a rounded row card.

### Notices, banners, and failures

- Inline failures stay beside the failed operation.
- Session-wide blocking state uses a full-width reserved banner below the topbar.
- Toasts use compact rectangular surfaces with one semantic edge.
- Warning/error/success never rely on color alone.
- Recovery actions are direct verbs and remain visible until the condition is resolved.
- No banner, toast, or search surface may cover transcript content.

## Icons and controls

- Use Lucide icons, consistent 1.5-1.75 stroke width.
- Visual icon sizes: 14px metadata, 16px controls, 18px primary tools, 24px empty states.
- Icon-only controls have accessible names and tooltips.
- Desktop icon buttons may look 32px; touch hit areas are at least 44x44px.
- Use icons for familiar commands; avoid rounded text rectangles when a standard symbol is clearer.
- Buttons keep stable dimensions across rest, hover, pressed, loading, disabled, and semantic changes.

## Motion

### Timing

```text
micro       90ms ease-out
standard    160ms ease-out
panel       220ms cubic-bezier(0.2, 0.8, 0.2, 1)
live        2s ease-in-out loop, running state only
```

### Rules

- Hover/focus changes are immediate and crisp.
- Drawers and context panes move as spatial objects.
- Menus/dialogs use short opacity + 4px translation.
- Thinking/tool collapse preserves spatial continuity.
- Streaming text appears through layout only; never animate tokens.
- Only a running point/rail may loop.
- Reduced motion removes translation and loops, retaining immediate state and short opacity.
- No bounce, elastic motion, parallax, marquee, cursor effects, ambient animation, or decorative shimmer.

## Accessibility

- WCAG AA contrast in both themes.
- Color is never the only state witness.
- `focus-visible` is obvious on every interactive control.
- Touch/coarse-pointer hit areas are at least 44x44px.
- Keyboard order follows visual order.
- Drawers and dialogs trap focus and restore it to the exact opener.
- Escape closes the local overlay and never leaks into global abort behavior.
- Support 200% browser zoom without loss of content or operation.
- Respect reduced motion and forced colors/high contrast where applicable.
- Inputs on mobile use a legible size that avoids browser auto-zoom.
- Persistent chrome never obscures readable or focusable content.

## Content voice

Precise, calm, direct, technically honest.

- Sentence case.
- Direct action labels.
- One term per action across progress, success, error, and recovery.
- No hype, apology, jokes, exclamation marks, or emoji.
- No visible marketing or feature-explanation copy inside the workbench.
- Empty states state what is absent and the next valid action.
- Error copy states what is known and what can be done; never invent certainty.

## Signature choices (non-negotiable)

1. **Graphite frame + paper plane** is the primary light-theme composition.
2. **Composer command deck** replaces the floating chat-box impression.
3. **Transcript search owns a reserved rail** and never overlays content.
4. **Semantic index rails** are the signature for thinking, tools, and failure.
5. **Dark code slabs** anchor technical content in light mode.
6. **Sharper geometry and fewer pills** distinguish commands from status.
7. **The welcome brand moment uses one calibration rule**, not a giant watermark or repeated motifs.
8. **Settings and overlays are flattened**, with no card stacks inside cards.
9. **Alignment and fixed metadata columns** are treated as visible product identity.
10. **Running moves; settled rests.**

## Anti-patterns

- Preserving current token values merely because they exist.
- Applying the new palette without changing surface topology and component anatomy.
- Generic SaaS cards, dashboard grids, hero sections, pricing/testimonial patterns.
- Terminal green, IDE imitation, cyberpunk glow, glass, grain, bokeh, blueprint grids, decorative equations.
- Beige editorial luxury, dark-blue/slate monotony, or a one-note teal interface.
- Rounded-everything UI, pill buttons, cards nested inside cards.
- Oversized headings inside compact work surfaces.
- Tiny metadata as the default solution to density.
- Decorative gradients, broad semantic fills, shadow on resting content.
- Hover-only required actions or phone controls below 44px.
- Non-zero letter spacing, font weights above 600, viewport-scaled typography.
- New UI framework, styling framework, remote fonts, or duplicated icon system.
- Visual state that is not backed by authoritative runtime state.

## Implementation strategy

1. Freeze current behavior with representative tests and baseline screenshots.
2. Replace the root token system with the Editorial Instrument roles.
3. Transform the shell first: frame, canvas, topbar, reading plane, context plane.
4. Transform navigation, transcript/search, activity blocks, composer, context, and overlays as complete surface groups.
5. Remove superseded styles rather than layering overrides indefinitely.
6. Update design documentation to describe only the new current system.
7. Inspect light and dark after every complete surface group.
8. Run focused tests during work and the repository's decisive final check after the last edit.

## What success looks like

A successful redesign should feel like:

- opening a serious editorial instrument rather than a generic local web app;
- moving between navigation, reading, execution, and inspection without losing spatial orientation;
- reading a long technical answer in a document designed for sustained attention;
- operating precise controls whose state is obvious without visual noise;
- seeing a product with stronger authorship while all Pi behavior remains familiar.

It should not feel like:

- the old interface with new hex values;
- a style prompt pasted over the existing DOM;
- a dark sidebar attached to an otherwise unchanged app;
- an IDE, terminal, dashboard, or marketing site;
- a redesign optimized for one screenshot rather than daily work.

The redesign is complete only when:

1. The eight substantive departures are visibly present in real-browser screenshots.
2. A reviewer immediately recognizes the same product and workflows, but cannot mistake the result for the previous visual system.
3. Light and dark each have intentional surface hierarchy and accessible contrast.
4. Desktop, laptop, tablet, and phone layouts contain no overlap, clipped controls, hidden content, or page-level horizontal scroll.
5. Search, banners, drawers, topbars, and the composer reserve their geometry and never cover transcript content.
6. Touch targets, keyboard navigation, focus, reduced motion, and 200% zoom pass on every changed surface.
7. Transcript streaming, dynamic activity lifecycle, composer behavior, session navigation, context inspection, and conflict/recovery semantics remain correct.
8. The implementation contains one coherent token/component system with superseded CSS removed.
9. Design docs, implementation, screenshots, and tests describe the same new visual contract.
10. The repository's decisive checks pass after the final edit.
</design-system>
