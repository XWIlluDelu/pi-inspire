---
purpose: The single current visual contract for Inspire: Amber/Jade palette roles, typography, geometric scale, responsive workbench anatomy, and bounded interaction motion implemented by shared CSS tokens.
covers:
  - index.html
  - public/favicon.svg
  - public/app-icon.svg
  - public/app-icon-maskable.svg
  - public/app-icon-192.png
  - public/app-icon-512.png
  - public/app-icon-maskable-512.png
  - public/apple-touch-icon.png
  - public/theme-init.js
  - src/styles.css
  - src/assets/fonts/**
  - src/assets/licenses/**
  - scripts/import-ibm-plex-sans-sc.mjs
  - scripts/verify-release-package.mjs
  - server/preferences.ts
  - shared/contracts.ts
  - src/**/*.tsx
  - tests/web/styles-contract.test.ts
  - tests/web/app.test.tsx
  - tests/web/overlay-and-palette.test.tsx
  - tests/web/theme-init.test.ts
  - tests/browser/workbench.spec.ts
---

# Design system

## Goal

Give INSΠRE a coherent, medium-density scientific-workbench character while
keeping conversation content dominant. `src/styles.css` is the executable token
source; this spec states the roles, values whose identity matters, and component
anatomy that must remain stable rather than duplicating every declaration.

## Identity and palette

- **Visible lockup:** `INSΠRE`; **natural-language and accessible name:**
  `Inspire`; **technical identifiers:** existing `inspire` and `pi-inspire`
  names. The wordmark is IBM Plex Sans SC with a highlighted `Π`, not a second
  display family.
- The Open Reticle is the compact identifier: opposing square ink brackets,
  four detached accent datum ticks, and a centered square aperture. Its small
  and display masters compensate independently; the transparent 16px favicon
  is a pixel-fitted optical master. Launcher assets place the mark on a carbon
  tile: ordinary PWA PNGs preserve transparency outside the rounded tile so a
  desktop shell cannot paint white corner wedges, while maskable and Apple
  touch assets use the full-bleed carbon master and rely on the operating
  system's own mask.
- Palette and luminosity are independent. **Amber** (琥珀) is the default and
  persists as `amber`; **Jade** (青玉) is the optional alternative and retains
  the compatibility identifier `teal`. Light, Dark, and System select
  luminosity independently of either palette.
- Amber's identity accent is `#D95A00` in light and `#FF781F` in dark. Jade's
  is `#007D78` in light and `#52D2C9` in dark. A browser-local visual cache may
  paint a saved theme/palette before React starts, but host preferences remain
  authoritative after bootstrap.
- Each palette supplies distinct canvas, rail/navigation, context, reading
  stage, surface, inset/control, activity, and code roles. Amber uses warm
  paper/carbon neutrals; Jade uses its own cool neutral ladder. Components use
  roles such as `--bg-surface`, `--hairline`, `--accent`, `--accent-fill`, and
  `--accent-tint`, never locally invented palette values.
- Success, warning, error, tool-info, and thinking-violet are semantic roles,
  not alternate brands. Navigation state combines its positioned status mark
  and accessible state with color: working spins in the warning role,
  completion uses success, failure uses error, and recovery remains visibly
  distinct. Color alone never carries a product state.

## Type, geometry, and spatial hierarchy

- IBM Plex Sans SC owns interface controls, reading text, Chinese/Latin flow,
  and the wordmark. Flux Mono SC owns code, paths, identifiers, timestamps,
  shortcut labels, and machine-oriented data. KaTeX keeps its bundled glyphs.
- The shared type scale is 11.5px, 12.5px, 14px, 15.5px, 17px, 21px, and 26px;
  600 is the maximum product weight. CJK running text has no tracking, while
  short uppercase Latin labels may use restrained tracking.
- The 4px spacing scale is the only general rhythm. Geometry is intentionally
  precise: 2px inline corners, 3px controls, 4px resting surfaces, and 6px
  overlays. `999px` is reserved for genuinely round/capsule affordances such
  as status geometry and scroll thumbs, not ordinary cards or inputs.
- Neutral surface steps, hairlines, and whitespace express depth. Resting
  surfaces avoid theatrical shadow; raised menus, notices, and dialogs use
  the shared shadow roles. The reading stage is a content field, not one giant
  card.
- Desktop is a three-region workbench: a 220–272px navigation column (48px
  collapsed rail), a centered 820px reading/composer field, and a contextual
  pane clamped from 340px to 760px. The 52px topbar aligns the regions without
  turning the page into a dashboard of boxed panels.

## Component grammar

- The navigation header carries the optical reticle and wordmark; the collapsed
  rail carries only the mark. A selected session uses a restrained accent edge
  and tint, while project/session hierarchy, curation, and runtime state remain
  legible without duplicating a session into a separate status group.
- Assistant prose is an open document flow. User turns, thinking/tool/custom
  activity, code, tables, math, notices, and the composer each use their own
  compact structure, but all inherit shared surfaces, borders, type, and
  semantic roles. Activity cards communicate kind and outcome through both
  iconography and their bounded semantic edge.
- The composer is a single reading-width instrument with attachment/reference
  work above the writing field and a quiet metadata toolbar below. Model,
  thinking, project files, attachments, context usage, and send/abort stay
  aligned to that toolbar; at the 390px target they remain on one row rather
  than promoting model or effort controls to a second row. A constrained model
  label truncates inside its trigger rather than painting across adjacent
  controls. The detailed input, delivery, and ownership contract lives in
  [[composer]].
- Files, Changes, and History share the contextual pane rather than creating a
  fourth workbench column. File/resource safety and diff semantics belong to
  [[resource-preview]]; branch behavior belongs to [[session-continuity]].
- Command Palette, Settings, extension dialogs, pickers, and destructive
  confirmation use the shared overlay grammar: a 6px surface, hairline,
  elevated shadow, restrained scrim with a 2px backdrop blur, and a short
  0.97→1 pop-in. Modal focus/keyboard ownership is behaviorally centralized in
  `useModalFocus`; a visual overlay never leaves shell shortcuts active below
  it.

## Responsive, motion, and accessibility

- Below the narrow-workbench breakpoint, navigation and contextual work become
  independent off-canvas drawers instead of squeezing both side regions around
  phone-sized conversation content. Fixed narrow surfaces honor all four safe
  insets; a drawer starts beneath the center topbar so its own close/open
  control remains reachable.
- Motion explains a transient surface, disclosure, or live work. Shared
  durations are 90ms micro, 150ms standard, and 180ms panel; active work may
  spin and the composer may retain a quiet static semantic halo, but terminal
  states do not breathe or flash. Short card/palette entrance and disclosure
  transforms are permitted. Reduced-motion mode removes nonessential animation
  and collapses transitions to a negligible duration.
- Text meets WCAG AA contrast, and graphical focus/status cues meet their UI
  contrast threshold. `:focus-visible` uses the shared 2px accent outline;
  controls retain named roles, native semantic structure, visible keyboard
  focus, and focus restoration after overlay close. Touch layouts allocate
  compact controls in flow rather than overlapping pseudo-targets, while the
  390px composer toolbar remains one row.

## Checks

- `tests/web/styles-contract.test.ts` verifies declared CSS variables, the
  permanent brand/surface/activity token families, traffic-light navigation
  roles, all-edge narrow safe-area use, and the absence of composer pulse or
  completion-flash keyframes.
- Theme bootstrap and overlay ownership have focused web tests; mock-host
  browser coverage checks desktop and narrow workbench behavior, including the
  390px one-row toolbar, non-overlapping touch controls, and accessibility
  paths.
- A visual change is evaluated in both luminosity modes and both palettes when
  its affected role appears in each; it does not create a second component
  architecture or a local exception token.

## Non-goals

- The system does not reproduce a reference application's palette, typography,
  artwork, or component identity.
- It does not use a teal default, a mixed Amber/Jade surface ladder, a legacy
  mixed-case lockup, large decorative brand motifs, persistent breathing,
  completion celebration, or a second responsive component structure.
