---
purpose: Neutral PWA chrome and installed identity, their rendering/update boundary, and verification evidence.
---

# Neutral PWA chrome

## Decision and implementation

The previous HTML and manifest fixed title-bar hints to Amber orange even when the application used Jade. Under [[design-system]], window chrome now uses the same neutral light/dark pair for both palettes. `public/theme-init.js` sets the page metadata before CSS/React paint from the existing validated visual cache; `applyBrowserTheme` in `src/visual-preferences.ts` applies the Host-authoritative resolved theme and system-theme updates. Tests keep the two small pre-bootstrap/runtime mappings aligned. Manifest theme and launch background use the neutral light fallback.

Installed icons keep the Open Reticle geometry and carbon tile but replace orange details with silver; the brackets stay white. `npm run icons:build` (`scripts/render-app-icons.mjs`) regenerates all four PNGs from the two SVG masters through the project's Playwright Chromium, without another image dependency. Ordinary icons keep transparent rounded corners; maskable and Apple touch icons remain full-bleed. Manifest and touch-icon URLs advance to `v=4`; app identity, start URL, scope, and manifest location remain stable. Existing service-worker network-only handling for manifest/launcher assets remains unchanged. In-app identity and the tab favicon are not changed.

## Browser boundary

[MDN's PWA color guide](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/How_to/Customize_your_app_colors) describes page `theme-color` overriding the manifest fallback in supporting browsers. It is a browser hint, not CSS ownership of OS window borders. Installed icons are manifest/OS assets rather than live theme components; [Chrome's manifest update guide](https://web.dev/articles/manifest-updates) documents browser-controlled delayed update behavior. Versioned URLs do not promise immediate replacement of already installed launcher icons. Platform/browser differences remain; restarting the installed app or reinstalling may be necessary to see a cached icon change.

## Verification

- Node 22.19.0: the theme-init and App suites passed 35 tests, including pre-bootstrap cache/system/fallback resolution, mapping parity, neutral manifest/HTML defaults, and real App command-palette theme changes updating metadata.
- Typecheck, lint, format check, and the production web build passed.
- An isolated mock Host serving the production build was checked with Chromium: system light/dark changes updated metadata to the expected colors, and switching to Jade kept the same neutral pair.
- All four served PNGs decoded at their intended sizes (192, 512, 512, 180). Canvas pixel inspection confirmed transparent ordinary corners, opaque carbon maskable/touch corners, and silver centers. The ordinary 192px icon was visually inspected.

These checks do not establish installed native title-bar appearance or OS icon-refresh timing on Linux, Windows, macOS, Android, or iOS. No daily-use Host restart or native-app reinstall was performed.
