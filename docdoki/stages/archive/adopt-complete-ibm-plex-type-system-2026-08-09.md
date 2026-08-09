---
scope:
  - src/styles.css
  - src/assets/fonts/**
  - src/assets/licenses/**
  - scripts/import-ibm-plex-sans-sc.mjs
  - scripts/verify-release-package.mjs
  - inspire
  - README.md
  - docdoki/spec_abstract.md
  - docdoki/specs/design-system.md
  - docdoki/specs/visual-language.md
  - docdoki/notes/reference-applications.md
---

# Adopt complete IBM Plex type system

## Objective

Restore the product's original IBM type direction across interface, Chinese and Latin reading text, serif brand roles, and monospaced machine data without making remote and multi-device browsers download complete CJK fonts per weight.

## Current state

- Working: IBM Plex Sans SC 400/500/600 is vendored from the exact official `@ibm/plex-sans-sc@1.1.0` archive as 216 untouched Unicode-range WOFF2 faces per weight.
- Working: IBM Plex Serif remains the wordmark/error serif and IBM Plex Mono remains the code/data face; IBM Plex Sans SC supplies Chinese fallback after Mono. No Noto or MOTO runtime family remains.
- Verified: the importer authenticates the npm archive before extracting it, reproduces the same manifest, copies only official split WOFF2 files, and generates the bounded `@font-face` sheet. No IBM telemetry package or runtime dependency is installed.
- Verified: the release gate pins 654 IBM font files across source and production-only installation. The 648 Sans SC WOFF2 files occupy 17,255,936 bytes; the release tarball is 19,253,824 bytes across 770 files (21,165,118 bytes unpacked).
- Verified: cold English workbench rendering requested one Sans SC face per UI weight plus one Mono and one Serif face — 5 requests / 135,296 encoded bytes. A three-weight Chinese/Latin sample including rare Han expanded that to 32 requests / 1,120,220 encoded bytes; all three `document.fonts` checks passed.
- Verified: Chromium desktop light/dark and 390px mobile screenshots show coherent IBM typography, no page overflow, and zero browser warnings/errors. Source launch prints eight build lines rather than hundreds of per-font asset rows.

## Next actions

- [x] Verify the importer is byte-reproducible and the release gate independently pins every source and installed IBM font asset.
- [x] Remove all Noto runtime files, licenses, and references; align the living typography and license documents.
- [x] Run full tests, build and release-package gates, and measure the final source/tarball payload.
- [x] Use real Chromium to verify actual IBM family ownership, three UI weights, CJK coverage, desktop/mobile themes, request count/bytes, overflow, and console output.
- [x] Archive this stage after the final worktree and DocDoki audit.

## Decisions

- Use the complete official split distribution: 648 WOFF2 files, not the three complete 3.8–4.0 MiB faces and not a locally modified subset.
- Preserve the official bytes and Reserved Font Name `Plex`. Any local glyph deletion or recomposition would become an OFL Modified Version and could not retain that name.
- Package size and browser transfer are separate concerns. The npm/GitHub artifact carries all supported splits; the browser requests only the ranges intersecting rendered text and caches them normally.
- Do not add `@ibm/plex-sans-sc` as a dependency: its published package has a telemetry postinstall and 123 MiB unpacked surface not needed at runtime.
- The one-off importer accepts the exact npm tarball, verifies its published SHA-512 integrity, and is not part of ordinary build or startup.

## Handoff

Completed locally on 2026-08-09. The product now uses IBM Plex Sans SC / Serif / Mono exclusively; the official Sans SC split keeps ordinary browser transfer bounded while the install artifact carries complete supported coverage. The 654-test suite, TypeScript/Vite build, production-only release verifier, real Pi startup, license/provenance checks, source-launch output, and real-Chromium visual/transfer gate all pass.

Future IBM Plex Sans SC updates must start from a newly reviewed official package identity and integrity, regenerate the whole split directory, and deliberately renew the release verifier's manifest digest. Do not locally subset or recombine the faces while retaining Reserved Font Name `Plex`.
