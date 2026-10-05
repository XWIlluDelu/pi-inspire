---
scope:
  - server/{attachment-references,attachments,runtime*,pending-image-evidence,pi-rpc,session-export,session-tree,app}.ts
  - server/extensions/inspire-branch-bridge.ts
  - shared/{contracts,branch-bridge-protocol}.ts
  - src/components/{Welcome,BranchTree,ComposerInput,AppTopbar}.tsx
  - src/controllers/branch-controller.ts
  - package.json
  - package-lock.json
  - scripts/verify-release-package.mjs
  - tests/{server,web,browser}/**
---

# Native-workflow quality repairs

## Verified repairs

The repairs below passed the targeted and Linux integration checks recorded on 2026-10-03.
[[challenge-pi-1-quality-2026-10-05]] records the subsequent audit and current verification. The native
adaptation backlog remains in [[follow-pi-native-capability-review-2026-10-02]].

| Finding | Repair and verification | Detailed owner |
| --- | --- | --- |
| Encoded upload references | Retention scanning and resend leases share raw/exact-JSON-string path matching. A retained backslash-path upload survives restart and is reclaimed after its final reference disappears; Windows-shaped scanning is covered separately. | [[follow-file-input-lifecycle-2026-10-02]] |
| Aggregate pending-image read | Preparation reads a native append cursor; ambiguous recovery streams bounded identity records without image bodies. The two-14-MiB-image native reproduction stays below the unchanged frame cap and keeps its worker alive. | [[follow-pending-input-recovery-2026-10-02]] |
| Handled-input file retention | Native `handled` input no longer installs a future-reference hold. A native hook that records no path permits collection without restarting the Host; queued/unknown outcomes and actual persisted references remain protected. | [[follow-file-input-lifecycle-2026-10-02]] |
| Aggregate JSONL export | Reuse the verified local prefix and request only the native suffix/effective leaf. The large-session reproduction no longer retires its worker; native serializer/source-preservation and unmaterialized-session cases pass. | [[follow-command-ux-2026-10-02]] |
| History reads invalidated by append | Text/image admission now binds the transcript view, not the advancing revision. Native reads succeed after a Bash append; the Runtime regression rejects them after navigation. | [[follow-history-cloning-2026-10-02]] |
| Hidden first-input alternatives | Other starts retains branch points from the hidden metadata prefix. The component regression opens the original route without native navigation. | [[follow-history-cloning-2026-10-02]] |
| Catalog work during directory typing | New coalesces automatic reads; the Host rejects invalid directories before refresh. A 94-character path produces one catalog request rather than 94, including under 160 ms network emulation. | [[follow-model-selection-2026-10-02]] |
| Large command-completion menu | Bounded rendering replaces a full 1,080-item DOM. The same production-browser workload adds 45 nodes instead of 4,324; keyboard selection, filtering and narrow-screen scrolling pass. | [[follow-command-ux-2026-10-02]] |
| Late Rename response | Editing advances the existing draft revision, so an earlier blur-save response cannot close a newer draft. Desktop and touch browser regressions pass. | [[follow-frontend-change-review-2026-10-03]] |
| Root attachment view | An explicit null-root navigation lease no longer falls back to the durable leaf. The artifact regression verifies that retained-history lookup receives the selected root. | `tests/server/runtime-composer-artifacts.test.ts` |
| Default native test baseline | The installed development CLI is pinned to Pi 1.0.0. The three effective-settings cases pass without an override; they failed on the former 0.87.0 pin. Browser fuzzy-search TUI remains independently pinned. | [[dependency-boundaries]] |
| Release verification | The verifier allows the shipped native-UI example and reads only font/CSS assets during font checks. The production-only package installs and passes external Pi startup, PTY, Fork and lifecycle checks. | [[dependency-boundaries]] |

The input checks use installed Pi 1.0 and isolated roots, including the large-history read, original
image multiplicity, bridge ownership and handled-input collection. The large payload probes require
no model-provider task. The earlier image-only settlement/clear-receipt race remains repaired, with
its Runtime interleaving retained in the Pending suite.

Provider-login polling, lost cancellation receipts and repeatable completed receipts were rechecked
against the actual GUI and native API-key path; no current defect was demonstrated in those paths.
[[follow-model-settings-auth-2026-10-02]] distinguishes that evidence from real-account authentication
and from the still-open native behavior-setting persistence gap.

## Verification organization

Pending browser workflows live in `tests/browser/pending-input.spec.ts`, including Clear confirmation,
full individual/all copying, later-draft merging, Stop, image recovery and modal/global Escape.
Provider-authentication state tests live in their component suite, while parent Models wiring retains
its own owner/destination cases. Runtime settings, compaction and Pending cases have dedicated suites
sharing `tests/server/fixtures/runtime.ts`; they preserve the admission/clear/retirement boundaries
that isolated image-owner tests cannot establish.

Recorded Linux verification on 2026-10-03, before later Pending-preview changes:

- Default suite: 219 files, 2,299 passed and two skipped. Stale maintenance, projection-worker and
  pagination fixtures were corrected against the current interfaces and behavior.
- Portable checks: 26 passed. Launcher checks: nine passed and one skipped.
- Typecheck, formatting, lint and unused-code checks passed. Obsolete update-card CSS and the
  duplicate sidebar command entry were removed.
- Release verification passed: production-only installation, 760 font assets, external Pi 1.0 startup,
  mock/real lifecycle, terminal PTY, Fork worker and publish dry-run.
- Relevant browser/native task checks are linked from the topic stages; authentication used
  isolated credentials/callbacks rather than live accounts.

## Remaining work

Native behavior-setting persistence feedback, virtual-model identity and cold-start extension-model
discovery remain unrepaired. The full command, extension, tool, resource and presentation backlog
stays in [[follow-pi-native-capability-review-2026-10-02]].
