---
scope:
  - PROJECT_REVIEW.md
  - shared/**
  - server/**
  - src/**
  - tests/**
  - package.json
  - package-lock.json
  - inspire
  - scripts/**
  - LICENSE
  - vite.config.ts
  - tsconfig.server.json
  - tsconfig.release.json
  - README.md
  - docdoki/specs/**
  - docdoki/notes/**
---

# Project hardening

## Objective

Resolve every correctness, performance, and durability issue established by `PROJECT_REVIEW.md` without broad refactoring or parallel authorities, then produce and verify the standalone npm release shape requested by the user.

## Current state

- Complete: projected message changes are classified independently from physical JSONL changes; semantic appends preserve loaded transcript history, while compaction, navigation, and rewrites renew the opaque view generation.
- Complete: open/new/fork perform fallible snapshot, projection, identity, and runtime-metadata reads before their commit point. Once ownership or selection commits, the validated response is returned even if post-commit catalog, event, or observer work fails.
- Complete: one shared attachment contract owns count, per-file, aggregate raw, raw-image, encoded-image, RPC outbound, and derived inbound-event limits. Multipart data streams to a private process cache, aggregate excess aborts in flight, prompt encoding is sequential, and shutdown cleanup follows HTTP drain.
- Complete: one `{session, view, revision}` resource citation index supplies ordered references, normalized citation authority, and embedded coordinates to list/probe/resolve/revalidation. The browser mounts eight recent rows plus one cursor-bound 64-row historical page and exposes loading/retry/newer/earlier states.
- Complete: Git status polling schedules a full four-second interval only after the request chain settles; explicit refresh and tool-completion hints coalesce into at most one immediate successor.
- Complete: missing preference fields still migrate to defaults, but malformed JSON, invalid roots, invalid fields, and unknown fields leave the saved file byte-for-byte unchanged. Bootstrap exposes the configured path and warning; every preference write returns 409 until the user repairs or removes the invalid file.
- Complete: the frozen evaluator accounts for the bounded resource-list request and witnesses Dynamic tools through either their ordinary card or compact accessible identity. The final isolated batch accepted 21 clean browser samples in 22 attempts and activated no maintenance suspect.
- Complete: the repository now builds a standalone Linux npm CLI package rather than a Pi resource package. The tarball carries the MIT project license, generated notices for the 96 package identities actually bundled into the browser, separate SIL OFL font texts, prebuilt browser and Node host, exact Pi 0.84.1 runtime, launcher, and screenshots; it excludes tests and TypeScript source and requires no postinstall build.

## Verification

- `NODE_ENV=test npm run check`: 59 test files and 654 tests passed with TypeScript project references.
- `npm run release:verify`: the exact tarball passed `npm publish --dry-run` without metadata correction, then its production-only install passed; canonical `inspire` bin metadata, MIT project license, generated bundled-software notices, font licenses, and all required runtime files were present; source-only files were absent; npm's bin symlink resolved; authenticated mock start/status/health/stop passed; a real Pi worker loaded the compiled bridge and created an empty session; exact Pi runtime was 0.84.1.
- Final isolated evaluator: 21 accepted samples, one frame-gap-contaminated attempt discarded, exact `/api/resources/list` count of one per sample, `no-performance-change`, zero activated suspects. Changes p95 178.60 ms, History 116.30 ms, Files React 0.70 ms, projection 17.17 ms, Git status 11.00 ms.
- Production build instrumentation scan: no benchmark globals, wrappers, or profiler artifacts in generated text assets.
- Chromium acceptance: desktop 1440x900 and mobile 390x844 conversation, Files, History, and navigation surfaces had no horizontal overflow or incoherent overlap; console reported no errors or warnings. The empty-current-page resource-index failure path has a focused retry regression test.
- Dependency gates: production and full-tree `npm audit` reported zero advisories; npm registry, manifest, lock root, lock node, installed package, and release smoke all agreed on Pi 0.84.1.

## Decisions

- Keep each fix at its semantic owner. Do not create a second transcript, resource, attachment, preference, or Git authority.
- Presentation pagination never weakens complete citation authorization.
- Corrupt preferences are usable only as an explicitly warned in-memory projection; automatic repair, backup copies, and unrelated normalization writes were rejected as redundant or lossy.
- The official Pi package format applies to resource bundles, not to this application that embeds Pi. Inspire intentionally has no `pi` manifest or `pi-package` keyword and retains Pi as an exact runtime dependency.
- Upstream Pi and the dominant actively maintained Pi web/GUI peers use MIT; PizzaPi uses Apache-2.0, and no-license peers grant no reuse rights. Inspire's recorded references transfer product behavior rather than implementation, so no peer license is inherited. MIT was selected for ecosystem consistency; Vite derives third-party notices from the actual browser module graph, and missing license text fails the build.
- No speculative code splitting, cache layer, subscription split, exponential retry policy, or broad runtime/store decomposition was authorized by the final evidence.

## Handoff

The implementation and local release artifact are complete. Version `0.1.0` is published from the exact verified `inspire-pi-gui-0.1.0.tgz` tarball (5,329,772 bytes; SHA-256 `df603e9c53e472b668218fd89bbc7a201c2ef3d84a1ef3f4bd85ac22c31e09e7`) only after npm authentication; its Git tag, npm registry version, GitHub Release attachment, and checksum witness must all identify that same release.
