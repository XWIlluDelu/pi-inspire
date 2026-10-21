---
scope:
  - README.md
  - CHANGELOG.md
  - package.json
  - package-lock.json
  - docs/**
---

# Prepare 0.6.0

## Objective

Prepare an accurate 0.6.0 candidate, user documentation and real application screenshots.
This stage does not authorize a tag, npm publication or GitHub release.

## Current state

- The existing release baseline is annotated tag `v0.5.5`. The documented distribution path is
  `release:verify` → `npm pack` → tarball installation; there is no release workflow to replace.
  The public npm registry currently returns 404 for `inspire-pi-gui`.
- Package and lockfile metadata remain at 0.5.5. Version synchronization awaits a fixed candidate
  boundary and includes the tarball example in `docs/host.md`.
- README already describes most current capabilities. Targeted documentation now corrects the
  System → Host restart location, stopped/failed replies, terminal preference scope and
  non-destructive connection recovery. Existing protocol-upgrade, Trash recovery and attachment
  migration instructions remain relevant.
- [[follow-project-quality-2026-10-21]] records CI and the terminal recovery/lifecycle corrections.
  The reviewed range since v0.5.5 includes portable Host lifecycle, authenticated terminal IPC,
  native Trash/attachment continuity, external-writer fencing, Pending recovery and responsive
  reading/input behavior. Release notes must distinguish strengthened behavior from capabilities
  already present in 0.5.5.
- All eight current README images predate the latest responsive/reading changes; Settings still
  shows an older version and control layout. Replace all eight together only after the 0.6.0
  candidate is fixed. Terminal-fix QA images are not release screenshots.

## Release gates and next actions

- [ ] Fix the candidate source boundary, then synchronize package.json, both root lockfile version
  entries and the documented tarball name. Do not treat a local build as the running Host version.
- [ ] Finish the Windows Settings CI closure and confirm the final candidate's CI and three-platform
  installed-package checks. Earlier green jobs are evidence for their own source, not an untested tip.
- [ ] Prepare a concise changelog from the final v0.5.5..candidate diff, retaining upgrade requirements
  and actual capability limits. Do not invent an npm publication process.
- [ ] Build that candidate and capture the existing eight filenames with a real isolated application
  and synthetic content; keep the mobile image at 390px. Inspect every image's pixels, text, version
  and privacy. Do not hand-edit version labels or use generated UI.
- [ ] Obtain the separate release/tag go-ahead after these gates. Production Host restart remains an
  operator action; terminal migration that ends PTYs requires explicit approval.
