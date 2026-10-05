---
scope:
  - server/model-catalog*.ts
  - server/{runtime,runtime-events,app,index,mock}.ts
  - server/extensions/inspire-branch-bridge.ts
  - shared/branch-bridge-protocol.ts
  - src/model-options.ts
  - src/components/{Welcome,ModelSelector,Composer}.tsx
  - src/{App.tsx,api.ts,store.ts}
  - tests/{server,web,browser}/**
  - docdoki/specs/{composer,pi-integration}.md
  - docs/pi-commands.md
---

# Model selection corrections

## Outcome

Thinking transitions and non-interrupting catalog refresh are implemented. Saved configuration and
credentials are covered by [[follow-model-settings-auth-2026-10-02]]; remaining virtual-model identity
and cold-start extension discovery gaps are in [[follow-pi-native-capability-review-2026-10-02]].

- `modelSwitchThinkingLevel` reads prospective-workspace native settings: per-model default, global
  default, then current effort. The browser applies Pi's metadata and upward-then-downward clamp;
  unsupported `xhigh`/`max` becomes `high` on an off-through-high model, not `off`. Extension-only
  models retain their capability authority. Startup resolution is read-only and creates no worker.
- Welcome rejects stale workspace/model reads and preserves effort edited afterward. Catalog refresh
  retains the selected identity even if omitted from fresh choices and does not reapply defaults.
  Matching inherited workspaces use their existing worker; other prospective reads use the Host SDK.
  Automatic catalog/default reads share a 220 ms directory-typing delay, while picker opening remains
  immediate. Empty directories skip automatic refresh; invalid directories are rejected before catalog work.
- Pickers show cached choices immediately and refresh without restarting Pi or changing model/effort.
  Pi 1.0's RPC reads `getAvailableSnapshot`, so clearing the Host cache alone is insufficient. The
  existing internal bridge invokes public `ctx.modelRegistry.refresh({ signal })`; worker/session/
  nonce status and prompt-response fences precede the available-snapshot read. Concurrent reads
  coalesce and verify owner identity before publication. The 15-second discovery timeout does not
  abort the agent, clear Pending or retire the worker.
- The browser retains query/focus and usable cache on failure. Highlight follows model identity through
  insertion/reordering; if that identity disappears it uses the nearest surviving position. Ordinary
  model selection keeps ordinary feedback, without confirmation or configuration controls on rows.

## Evidence

- `tests/server/model-thinking.integration.test.ts` compares browser policy with actual SDK
  `AgentSession.setModel`: inherited effort, global/per-model/project precedence, upward clamping holes
  and non-reasoning models. Installed **Pi 1.0.0** (explicit `INSPIRE_TEST_PI_COMMAND`) and development
  **0.87.0** (then the development baseline) passed; settings bytes remain unchanged and sessions are in memory.
- `tests/server/model-catalog-refresh.integration.test.ts` changes synthetic configuration while a
  loopback-served model streams and an extension confirmation remains open. Raw RPC is initially stale;
  public refresh exposes a model accepted by `set_model` in the same PID. Session/file/entries,
  model/effort, queues, registered provider and answerable dialog remain intact. Both Pi versions passed
  with isolated credentials/files/processes/network.
- Focused Runtime/browser-store tests passed for refresh coalescing, hidden internal traffic, stale
  ownership, failure cache, later effort input and identity-stable keyboard selection/Enter.
- Fresh-build Chromium model and command-UX cases passed: cached opening/in-place updates, stable
  search/focus/draft/selection, failure cache and Welcome `max` → `high`. These are mock-Host UI flows;
  native authority is established separately above. Screenshots are
  `output/playwright/model-catalog-updated.png` and `model-start-thinking-high.png`.
- A production-GUI check typed a 94-character project path at 60 ms/character. Catalog requests fell
  from 94 (71 unfinished paths returned 400) to one; the repaired flow also passed under 160 ms network
  emulation. A real-Pi route probe observed zero refresh callbacks for invalid cwd and one for valid
  cwd. The focused Welcome regression protects final-query-only behavior and existing owner/thinking
  cases use the shared virtual-list layout fixture. This measures request reduction, not WAN speedup.
- Typecheck and diff checks passed for the recorded checks.
