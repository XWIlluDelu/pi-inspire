---
scope:
  - src/components/{FilesPane,FilePreview,ChangesPane,TerminalPane,HerdrSettings,HostRestartSettings}.tsx
  - src/controllers/{connection-controller,host-restart-controller,workspace-controller}.ts
  - server/{app,runtime-event-sockets,herdr-enhancement,herdr-rpc-transport}.ts
  - connections/ssh-reverse/**
  - docs/{extensions,tool-presentations,ssh-reverse}.md
---

# Supporting-surface review

## Outcome

Host/remote, optional Herdr, Files/Changes and project-terminal workflows retain their existing
structure. The review repaired stale Git feedback, blocked-Herdr enablement and extension guidance.
Native adaptation gaps continue in [[follow-pi-native-capability-review-2026-10-02]]; Files layout
questions remain in [[follow-file-browsing-experience-2026-08-24]].

## Repairs

- **Changes:** one refresh-failure notice qualifies any retained result, including clean and
  non-repository states. Initial failure remains distinct from retained data. Component and
  desktop/390px browser checks verified failure, recovery and preserved results.
- **Herdr:** prerequisite/recovery status now reports readiness. A blocked status prevents enabling
  and offers recheck; a healthy recheck restores enabling, and a saved enabled choice remains
  disable-able. An installed on-demand server need not already be running. Focused server and
  desktop/390px browser checks cover these states; no real Herdr launch was repeated.
- **Author guidance:** `list` presentation means file/resource links. The guides identify the internal
  branch/catalog/auth bridge. Four JSON examples validated, and keyboard resource activation worked.
  See [Extension adaptation](../../../docs/extensions.md) and
  [Tool presentations](../../../docs/tool-presentations.md).

## Verification

| Area | Checked behavior | Evidence boundary |
| --- | --- | --- |
| Host/remote | Invalid/valid pairing and Enter; independent selection in two views; reconnect/Retry with retained draft; restart-control ownership and connection status. | Isolated desktop/390px Chromium and controller/auth/asset checks. Existing restart evidence reused; no real service restart or public SSH/TLS path repeated. |
| Files/Changes | Search/open/Back, document and diff navigation; searchable 1,500-file directory; explicit cutoff for an 18,000-line source at the 256 KiB preview bound. | Isolated Chromium and workspace/Git ownership checks. Existing PDF.js, sandboxed HTML, media and line-reference evidence reused. |
| Terminal | Project tabs and reuse, project switching/return, explicit second-view takeover, Unicode selection/copy, non-executing paste and narrow Ctrl+C. | Real isolated PTYs plus controller checks. Production daemon restart and shell-marker integration reused prior evidence; the in-process fixture lacked Copy last output wrappers. |

These checks demonstrated no additional material Host/remote or terminal defect. Contracts and
reusable mechanisms remain in [[host-lifecycle]], [[herdr-enhancement]], [[terminal]],
[[terminal-controls-redesign]] and [[review-resource-terminal-ownership]].
