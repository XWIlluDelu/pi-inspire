---
purpose: Hidden-folder visibility in the host-side project picker, its native attribute boundary, and verification scope.
---

# Hidden project directories

## Behavior and reason

The New session picker previously skipped every dot-prefixed name unconditionally in `server/host-dirs.ts`, on all host platforms. That made hidden projects unreachable through browsing even though typing their absolute path already worked. Windows Hidden attributes and macOS UF_HIDDEN were not inspected.

Under [[workbench]], a local-to-the-open-picker Show hidden folders checkbox now opts into all immediate directories through the authenticated, session-independent `GET /api/host/dirs?showHidden=1`. Omission or `0` retains filtering; other values are rejected. No preference or filesystem attribute is changed. The checkbox is retained through navigation and resets on reopening. Browser paths remain verbatim Host paths, including drive and UNC forms.

## Native inspection boundary

`server/host-hidden-dirs.ts` handles attributes Node's Dirent/Stats do not expose:

- Linux and other POSIX hosts need no subprocess for the common dot-name rule.
- Windows runs one bounded Windows PowerShell command per directory level. `Get-ChildItem -LiteralPath … -Force -Hidden` returns names as an explicit UTF-8 JSON array, including zero/singleton cases. The path travels through an environment value, never script interpolation, and no shell/profile runs.
- macOS runs `/usr/bin/find` with `-mindepth 1 -maxdepth 1 -flags +hidden -print0`. NUL delimiters preserve spaces and newlines; the scan never descends into children. The [macOS find manual](https://keith.github.io/xcode-man-pages/find.1.html) defines these primaries; [chflags](https://keith.github.io/xcode-man-pages/chflags.1.html) defines `hidden` as hiding an item from the GUI.

Native queries have a ten-second timeout and 8 MiB output bound. Failures remain visible rather than silently changing the filter. Explicit show-hidden listing bypasses native inspection, so unavailable tooling does not make all browsing impossible. These flags supplement dot-name filtering; the picker does not emulate every file manager's private visibility metadata.

## Verification

On Linux with Node 22.19.0, the six targeted suites passed 113 tests; the native Windows/macOS integration test was conditionally skipped. Coverage lives in:

- `tests/server/host-dirs.test.ts`: dot names, direct hidden paths, directory links, native filtering, bypass/recovery, canonical paths, home and roots. The native-platform case sets and clears a real Hidden/UF_HIDDEN flag, including a name containing Unicode and metacharacters.
- `tests/server/host-hidden-dirs.test.ts`: no Linux subprocess, literal Windows paths, UTF-8 array validation, bounded nonrecursive macOS command shape, NUL-delimited names, and explicit native-query failures.
- `tests/server/app.test.ts` and `tests/web/api.test.ts`: authentication, explicit/false/invalid query values, and Host path encoding.
- `tests/web/directory-picker.test.tsx` and existing App tests: POSIX/drive/UNC values, drive navigation, reopening, hidden selection, latest-request ownership during navigation and rapid toggles, home fallback, failed-load confirmation, keyboard operation, and dismissal.

Typecheck, lint, and the production web build passed. An isolated Node 22 mock Host serving that build was exercised in Chromium via Playwright CLI at 1280×900 light, 375×812 dark, and 812×375 landscape. Checked actual hidden-folder listing/selection, nested hidden directories, reopen/reset, Space, Escape/focus restoration, reduced-motion layout, and no dialog overflow. Desktop/narrow screenshots were inspected under `output/playwright/hidden-directory-*.png` (ignored local artifacts). The new checkbox had no axe violations in either theme; the complete dark dialog had none. The existing shared primary button's light-theme white-on-orange contrast was reported at 3.87:1 and was not changed by this feature.

Native Windows/macOS execution remains unverified locally; the existing three-OS Node 22 CI matrix runs the platform-conditional integration test. No daily-use Host restart or release deployment was performed.
