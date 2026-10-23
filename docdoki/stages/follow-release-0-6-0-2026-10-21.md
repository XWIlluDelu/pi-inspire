---
scope:
  - README.md
  - CHANGELOG.md
  - package.json
  - package-lock.json
  - docs/**
---

# Tag 0.6.0

## Objective

Publish the verified 0.6.0 source as an annotated tag, with user documentation and application
screenshots. Production activation is an operator action.

## Released source

Annotated tag [v0.6.0](https://github.com/XWIlluDelu/pi-inspire/tree/v0.6.0), created on 2026-10-21,
resolves to `f67d6eef659ca4500bf39167c8460813d5d2a85d`. It follows `v0.5.5`; the tag remains fixed
as `main` develops. The published artifact is the source tag. Local installation uses
`release:verify` → `npm pack` → tarball installation.

[CI run 39574685523](https://github.com/XWIlluDelu/pi-inspire/actions/runs/39574685523) passed all
seven jobs for that source, including Linux/macOS/Windows installed-package verification. The
release-time production dependency audit reported zero advisories. Package checks used the
committed prepack mechanism and lockfile dependencies; the tarball includes the changelog,
screenshots, licenses and production runtime.

The eight README screenshots came from one isolated production build with synthetic content.
The mobile capture used a touch/coarse-pointer context at 390×844 CSS pixels. Images were checked
for readable content, correct version and private-data exposure.

## Current maintenance

[CHANGELOG](../../CHANGELOG.md) records the version's capabilities and upgrade requirements.
[[follow-project-quality-2026-10-21]] records subsequent integration into `main`. [[spec_abstract]]
links to current contracts, including the updated attachment-retention policy.

Use [Host operations](../../docs/host.md) for installation and activation. An incompatible terminal
daemon still requires an explicit operator decision to end its terminal work before replacement.
