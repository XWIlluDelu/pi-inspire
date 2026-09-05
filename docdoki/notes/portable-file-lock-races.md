---
purpose: Preserve mutual exclusion when portable lock participants change phase during directory enumeration.
---

# Portable file-lock phase races

`server/file-lock.mjs` keeps Linux's established kernel-flock protocol. macOS and Windows instead publish process-birth-bound participants in a Lamport bakery: `choosing-<token>.json` is atomically renamed to `ticket-<number>-<token>.json` before entry to the critical section.

A directory listing and inspection of its entries are not one atomic observation. If a listed choosing file disappears before `lstat` or `readFile`, the owner may still be live under its ticket filename. Treating that `ENOENT` as departure admits two races:

1. **Ticket selection:** an entrant misses an existing ticket, picks the same number, and can sort ahead of an owner already inside its critical section.
2. **Entry check:** a scan misses a lower-priority-numbered ticket during its choosing-to-ticket rename and admits a second owner.

Both ticket selection and entry checking must re-enumerate after a missing choosing entry. Rescans stay within the caller's acquisition deadline. A missing numbered ticket can still mean release, since numbered participants are never renamed to another phase and tokens are not reused. Ownership verification and stale-owner cleanup remain process-birth/token/inode bound.

## Evidence and scope

- `tests/portable/file-lock.test.mjs` forces each rename between directory listing and entry inspection, with fixed token ordering. Both regressions admit an unexpected lease against the former implementation and time out safely after the fix. Filesystem instrumentation stays in the tests; production does not detect fixtures or use test-specific behavior.
- A simultaneous eight-writer read/modify/write regression checks both exclusive entry and preservation of every update. Existing dead-owner, replacement, idempotent-release, and queued-owner checks remain.
- `tests/server/preferences.test.ts` retains the independent-Host field-patch assertion that exposed the race in Windows CI run `33970667263`; the assertion is not relaxed.
- The same portable lock also protects launcher lifecycle and web-build publication. This is a locking correction, not a preference-value workaround, and does not change the on-disk protocol or Linux locking.
