---
purpose: Neutral PWA chrome and installed identity, their rendering/update boundary, and verification evidence.
---

# Neutral PWA chrome

## Decision and implementation

The previous HTML and manifest fixed title-bar hints to Amber orange even when the application used Jade. Under [[design-system]], window chrome now uses the same neutral light/dark pair for both palettes. `public/theme-init.js` sets the page metadata before CSS/React paint from the existing validated visual cache; `applyBrowserTheme` in `src/visual-preferences.ts` applies the Host-authoritative resolved theme and system-theme updates. Tests keep the two small pre-bootstrap/runtime mappings aligned. Manifest theme and launch background use the neutral light fallback.

Installed icons keep the Open Reticle geometry and carbon tile but replace orange details with silver; the brackets stay white. `npm run icons:build` (`scripts/render-app-icons.mjs`) regenerates all four PNGs from the two SVG masters through the project's Playwright Chromium, without another image dependency. Ordinary icons keep transparent rounded corners; maskable and Apple touch icons remain full-bleed. Manifest and touch-icon URLs advance to `v=4`; app identity, start URL, scope, and manifest location remain stable. Existing service-worker network-only handling for manifest/launcher assets remains unchanged. In-app identity is unchanged; the transparent tab favicon received the neutral-color follow-up below.

## Transparent tab favicon follow-up

The tab/favicon now keeps its 16px pixel geometry, fully transparent background and original alpha coverage while replacing orange ticks/aperture with quartz gray `#63676C` in light browser chrome and the existing installed-icon silver `#B9C0C7` in dark browser chrome. Ink/white brackets remain unchanged; this does not recolor the in-app logo or alter installed-icon PNGs. `index.html` advances the favicon URL to `v=3`. The service worker handles the favicon like the other mutable browser/PWA icons rather than serving an unversioned shell-cache copy; a color-only asset update need not change the hashed JavaScript entry.

Verification: `browser-icon.test.ts` and `theme-init.test.ts` passed 12 tests on Node 22.19.0, including the stale service-worker icon regression. Chromium rasterization at 16px confirmed the expected light/dark center pixels and identical before/after alpha at every pixel. The 16px, 32px and enlarged comparison was visually inspected in `output/playwright/neutral-favicon.png`. This establishes asset rendering, not immediate replacement in browser-owned tab/history caches.

## Launcher sizing

Ordinary launcher icons now apply the transparent inset specified in [[design-system]]. At an equal 64px canvas, the previous tile occupied 64×64px while the local Papirus Chrome and VS Code icons occupied 56×56px. Scaling the complete tile and mark to 81.25% gives Inspire a 52×52px visible tile, compensating for the solid background's greater visual weight without changing internal proportions or palette. Only the ordinary manifest icon URLs advance to `v=6`; maskable, Apple touch, and favicon assets remain unchanged.

Verification: regenerated PNGs have visible bounds (alpha ≥ 0.5) of 156×156px with 18px insets at 192px, and 416×416px with 48px insets at 512px. Maskable and Apple touch PNGs remain fully opaque and byte-identical to the previous assets. The production web build passed. The before/after comparison at 64px was visually inspected on light and dark backgrounds in `output/playwright/launcher-icon-sizing.png`.

## Browser boundary

[MDN's PWA color guide](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Customize_your_app_colors) describes page `theme-color` overriding the manifest fallback in supporting browsers. It is a browser hint, not CSS ownership of OS window borders. Installed icons are manifest/OS assets rather than live theme components; [Chrome's manifest update guide](https://web.dev/articles/manifest-updates) documents browser-controlled delayed update behavior. Versioned URLs do not promise immediate replacement of already installed launcher icons. Platform/browser differences remain; restarting the installed app or reinstalling may be necessary to see a cached icon change.

## Verification

- Node 22.19.0: the theme-init and App suites passed 35 tests, including pre-bootstrap cache/system/fallback resolution, mapping parity, neutral manifest/HTML defaults, and real App command-palette theme changes updating metadata.
- Typecheck, lint, format check, and the production web build passed.
- An isolated mock Host serving the production build was checked with Chromium: system light/dark changes updated metadata to the expected colors, and switching to Jade kept the same neutral pair.
- All four served PNGs decoded at their intended sizes (192, 512, 512, 180). Canvas pixel inspection confirmed transparent ordinary corners, opaque carbon maskable/touch corners, and silver centers. The ordinary 192px icon was visually inspected.

These checks do not establish installed native title-bar appearance or OS icon-refresh timing on Linux, Windows, macOS, Android, or iOS. No daily-use Host restart or native-app reinstall was performed.
