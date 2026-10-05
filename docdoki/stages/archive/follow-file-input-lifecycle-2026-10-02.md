---
scope:
  - src/composer-completion.ts
  - src/components/{ComposerInput,Composer,Welcome}.tsx
  - server/{attachments,attachment-references,composer-history,runtime,runtime-composer-artifacts,session-catalog}.ts
  - tests/server/{attachment-retention,attachments,app,runtime,session-delete,desktop-trash,session-catalog}.test.ts
  - tests/fixtures/attachment-retention-process.ts
  - tests/web/{composer-completion,composer,welcome-new-session}.test.ts*
  - docdoki/specs/{composer,session-deletion}.md
  - docs/pi-commands.md
---

# File references and attachment lifetime

## Outcome

Inline file references and durable upload retention implement [[composer]] and [[session-deletion]].
Image input remains embedded in native Pi messages. Encoded-reference retention and handled-input
reclamation are verified in the checks below.

- `replaceFileCompletion` inserts `@` references at their sentence positions, preserving repeats and
  quoting spaces. Start-surface references use absolute paths in the prospective canonical workspace;
  explicit file picking still uses chips.
- Ordinary uploads and ownership sidecars live in durable Inspire state. Close removes staged/image
  copies but preserves accepted ordinary files; a new Host restores ownership and original filenames.
- Collection reads complete JSONL trees, including old branches, forks, recoverable Trash and private
  deletion-recovery payloads. Sources include default storage, configured roots for known projects
  and remembered custom directories. Unchanged source versions reuse parsed references.
- Malformed, unreadable or changing Pi sources defer destruction. Content-classified unrelated JSONL
  does not block collection; native entry envelopes with a missing header still defer it. Skipped
  sources are version-checked against concurrent replacement.
- Prompt leases and per-destination persistence holds protect staging, in-flight and accepted-but-not-
  persisted input, including textual resends from Pending. Confirmed deletion and a 60-second sweep
  collect only unreferenced ownership-recorded upload copies, never original project/user files.
  A native `handled` receipt skips the future-reference hold; paths actually recorded by its hook
  remain protected by normal reference scanning.

## Evidence and limits

Focused attachment, retention, Runtime/API, catalog and deletion checks passed: close/reopen and fresh-
process retention, original-byte/history recall, forks/old branches, last-reference reclamation,
Linux native Trash restoration/emptying, permanent deletion, recovery payloads, configured/custom roots,
staging/resend and malformed-source deferral. The unrelated `application-log.jsonl` regression verifies
orphan reclamation while preserving that log; corrupt/incomplete Pi fixtures retain the upload.

Retention and resend leases now share literal/exact-JSON-string path matching. A real Linux directory
containing a backslash survives store restart and final-reference reclamation; a separate case checks
Windows-shaped scanning on any platform. The native handled-input case records no path or model turn
and permits immediate collection without restarting the Host. Queued and unknown-outcome protections
are unchanged.

Fresh-build isolated Chromium preserved repeated inline references and quoted paths without chips;
explicit picking still created a chip, image preview/delivery worked, and start references were absolute.
Pending recovery/Stop/Clear, completion placement and picker-focus regressions passed alongside these
flows. Typecheck, scoped lint and diff checks passed at acceptance.

Discovery is bounded to default, configured known-project and remembered session directories.
Unregistered external copies are not protected; whole-filesystem discovery was not selected.
Native Linux Trash was exercised. macOS Trash and Windows Recycle Bin enumeration are implemented but
not natively verified; synthetic Windows payload/metadata tests establish only parsing behavior.
