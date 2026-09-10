---
purpose: Record the Files/Git separation, independent workspace authority, and synthetic verification.
---

# Filesystem and Git separation

## Decision and repair

The user rejected Git tracking/ignore rules as file-visibility rules: Files represents the project filesystem; Changes represents Git. Hidden visibility covers dot names and native Windows/macOS hidden attributes, not `node_modules`, `dist`, Git ignored files, or tracking state. Visibility, discovery completeness, and permission are independent.

- `server/project-files.ts` no longer invokes Git. Tree levels enumerate real directories on demand, including empty directories, with at most 10,000 inspected entries per response. Search uses bounded breadth-first discovery (20,000 files, 10,000 queued directories, a five-second cooperative walk budget). Directory identity is checked before/after enumeration; contained directory links are navigable and canonical identities stop cycles. Unrepresentable POSIX filenames cannot alias real replacement-character names. Incomplete/capped/unreadable discovery is explicit.
- The directory tree, search, established composer picker/`@`, and prospective New session search expose filesystem-only hidden visibility. An established workspace shares its cwd-scoped toggle across Files and composer entry points. Visibility changes retire old directory/search work while preserving the query, expansion and selected preview. New session owns its prospective-workspace toggle separately. The completion toolbar stays outside the ARIA listbox and preserves text/caret focus.
- `server/resources.ts` authorizes contained regular files independently of discovery and Git. Exact transcript references remain a separate authority outside the workspace. Content requests still check the addressed session/view, current canonical workspace, lexical/canonical target witness and pinned object. Missing paths invalidate discovery caches, not permissions. Changing ignore rules or hiding a file cannot revoke an otherwise valid handle. Contained reads do not load conversation content.
- `server/attachments.ts` and the existing delivery/history revalidation retain canonical-root, regular-file and selected-target checks without index membership. Hidden/ignored files can be sent and recalled; retargeting a selected symlink still fails. JSON-encoded prompt references retain their injection boundary.
- Document-local links/images, downloads and terminal file links inherit the independent resource authority. Local images in ignored generated-output directories can load; remote/protocol-relative images, outside targets without citations, sandbox content and transfer limits remain unchanged.
- Changes no longer infers `+0 −0` from an absent status entry. Only a concrete diff supplies line counts; missing/unavailable/incomplete/not-a-repository observations show unavailable counts and disable navigation. An empty selected Git comparison does not substitute working-tree bytes for staged source.

The earlier preview-index authority and five-second ignore-revocation tradeoff in [[review-resource-terminal-ownership]], and the ignored-image refusal recorded in [[document-relative-previews]], are superseded. Their session/object and document safety boundaries remain. Current contracts: [[resource-preview]], [[composer]], [[conversation]].

## Verification

Linux, explicitly verified Node **22.19.0** and npm **10.9.2**:

- `npm run ci` passed: formatting, lint, TypeScript, unused-code checks, production web build, **17 portable tests**, **1,581 unit tests + 9 launcher tests**, and **38 Chromium tests**. Three Vitest tests were conditionally skipped. The build retains its existing large-chunk advisory.
- Following the final completion-header deduplication, format/lint/typecheck/build, **32 composer tests**, and **5 affected browser tests** passed again.
- Server regressions cover Git/non-Git parity, a corrupt Git index with no Git discovery calls, empty/ignored/hidden entries, native-attribute filtering/failure, traversal and symlink boundaries, invalid UTF-8 filenames, partial discovery, explicit-path access despite incomplete basename recovery, HTTP query propagation, preview/download access, send-time and history-recall validation, and in-workspace/outside retarget refusal.
- Web regressions reject retired directory/search results after a visibility change, carry incomplete-result metadata, preserve cwd ownership, and distinguish missing Git evidence from a zero-change diff.
- The isolated browser Host browses a synthetic Git-ignored `dist` directory and a hidden configuration directory despite a corrupt index; it opens hidden content, hides the tree entry without revoking the preview, renders an ignored local Markdown image through authenticated resources, downloads the file, searches it, and sends an `@`-selected hidden file. Both **1440×900** and **390×844** passed. Screenshots inspected: `output/playwright/filesystem-{files,hidden,completion}-{desktop,narrow}.png`.

All session/attachment fixtures are synthetic. No daily session conversation payloads were read, and no daily Host or terminal service was restarted.

## Limits

- This is read-only bounded discovery, not an unrestricted file manager or a complete eager filesystem index. Special nodes and broken/outside symlink targets are not offered or traversed. A truncated scan is not proof of absence or basename uniqueness; exact qualified file reads do not depend on the scan.
- Search caches have a five-second freshness window, at most eight canonical-root/visibility scopes, and shared in-flight scans. The scan time budget is cooperative between directory reads, not a hard deadline on an individual filesystem/native-attribute operation. Explicit refresh invalidates discovery globally within that small cache.
- Native Windows/macOS attributes reuse the existing bounded platform helper. Their adapter behavior is covered synthetically here; this Linux run does not establish native Windows/macOS end-to-end performance or behavior.
- Deployment/service restart is not part of this repair. Running Hosts must load the updated backend before the new Files semantics are available.
