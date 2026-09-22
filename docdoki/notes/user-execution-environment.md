---
purpose: Explain the user-environment launch boundary, its verification, and migration without tool-specific PATH patches.
---

# User execution environment

## Boundary and rationale

The user approved reusing their existing development environment alongside their external Pi
installation. The original systemd units reduced PATH to the bootstrap Node directory and system
bins. A normally installed CLI in `~/.local/bin` was consequently invisible to extension processes.
Separately, `inspire.mjs` and the terminal unit forced `NODE_ENV=production`, changing npm behavior in
user projects. These were launcher-environment problems, not reasons to customize individual tools.

`server/user-environment.mjs` resolves exports at the launcher boundary. Direct launches retain the
caller's environment; installed services use the user's selected login/interactive shell from their
home directory. The helper runs the current absolute Node executable only to serialize exports.
Runtime children receive the resolved result, with discovery consumed rather than recursively run.
The binding contract is in [[host-lifecycle]] and [[pi-integration]].

No second environment database or install-time credential snapshot is needed. Removing Inspire's
forced NODE_ENV preserves user provenance directly, including unset and empty values. Express sets
its production mode on its own application object. `INSPIRE_TERMINAL_IN_PROCESS`, not the user's
NODE_ENV, controls the special in-process terminal owner.

Independent terminal services need the same boundary. The installed terminal launcher resolves the
shell environment. The transient `systemd-run` path transfers named exports using `--setenv=NAME`
with the supplied subprocess environment, rather than including values in command arguments. The
new service receives systemd's own invocation/notification identity, not the Host's. Detached fallback
continues to inherit the supplied environment.

## Probe behavior and failure handling

- Supported shell initialization uses `-i -l -c`, not manually sourcing a particular rc file in a
  potentially different shell. `INSPIRE_SHELL` overrides SHELL/account selection; explicit inherit
  mode supports externally managed environments. This does not change Pi's native shell tools.
- Startup output is discarded, while exports use a separate pipe. The final command redirects its
  stdout to that pipe: interactive Bash did not reliably preserve an inherited auxiliary descriptor
  into Node, so writing directly to fd 3 failed in the initial experiment. Explicit descriptor
  duplication works with the tested Bash and Zsh initialization.
- The probe is isolated, limited to ten seconds and 1 MiB of exports, and killed as a process group
  on timeout/overflow/failure. Errors do not repeat shell output or environment values. No partial
  result or silently reduced PATH is accepted.
- Shell unsets are retained. Explicit Inspire controls and systemd identity survive initialization;
  temporary probe state does not. Interactive-only prompts/TUI startup can check
  `INSPIRE_RESOLVING_ENVIRONMENT=1` while leaving exports active.
- The result contains exported process state, not aliases/functions or a virtual environment from
  some other terminal tab. Existing terminal processes are not changed by a Host restart.

## Verification

Verified on Linux with Node 26.5.0:

- `node --test tests/portable/user-environment.test.mjs`: 9 tests passed, covering caller inheritance,
  service-mode Bash setup, executable lookup, multiline/Unicode values, explicit unsets, empty and
  user-supplied NODE_ENV, shell override, failed/missing/oversized exports, timeout cleanup, and
  value-free systemd arguments.
- Targeted Vitest run: 91 tests passed across `user-environment-launcher`, `restart-launcher`, Pi RPC,
  Host API, independent terminal launch/ownership, and systemd control. Packaged-launch fixtures
  exercise both Host and terminal entrypoints; RPC checks include a real subprocess under the fake
  worker's exported environment.
- Serial `tests/launcher.test.ts`: 9 passed, one platform-specific case skipped. Its isolated real
  Host/terminal lifecycle now uses a user-supplied NODE_ENV=test and still preserves PTYs across
  Host restart. Installer assertions check shell-discovery policy and absence of forced NODE_ENV.
- Type checking, scoped Biome lint/format, import-boundary and unused-file checks, and compiled
  release build passed.
  The compiled environment module was imported and exercised from `build/server`; release packaging
  explicitly copies and requires that module. The full publication verifier was not rerun.
- A bounded local Zsh smoke check starting from the service's reduced bootstrap PATH resolved a
  normally installed CLI directly from `~/.local/bin`, without its temporary Pi-bin symlink, and
  retained an unset NODE_ENV. Only command location/version and boolean checks were printed.
- A short-lived isolated systemd unit confirmed named environment transfer, including spaces and
  an equals sign, without putting the test value into its arguments.

Other OS shell startup and the actual Fish/Ksh variants were not exercised locally. Direct inheritance
is tested with platform selection; platform CI remains the runtime authority for Windows/macOS.

## Deployment boundary

Project changes do not rewrite the installed services, restart the active Host/terminal daemon,
change the user's shell files, modify Pi, or remove existing workaround symlinks. Existing terminal
unit files still force production until reinstalled. The documented migration is:

```sh
./inspire service install-host
./inspire restart --all
```

The second command ends project terminal processes and must be scheduled deliberately. Host-only
restart keeps those processes and their old environment. Remove any temporary tool symlink only
after verifying the newly started runtime's normal command lookup.
