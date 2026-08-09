---
purpose: Product references identify the visual, workbench, state, and inspection patterns worth carrying into inspire without copying their implementations.
---

# Reference applications

## License landscape

The Pi GUI/web ecosystem is substantial enough to provide a convention signal, but peer licenses are not inherited merely by studying product behavior. At the 2026-08-09 review, upstream Pi and the independently maintained `pi-web` implementations by jmfederico, agegr, and Epsilondelta-ai, plus `pi-dashboard`, Piface, and `pi-gui`, all used MIT; PizzaPi used Apache-2.0; several smaller public repositories declared no license and therefore provided no reusable code grant. Inspire's provenance records deliberately transfer product capabilities and independently observed state boundaries rather than peer implementation, and its Git history has one author. No peer license therefore constrains the project license.

Inspire uses MIT to match Pi and the dominant ecosystem convention while allowing ordinary npm reuse. License compliance remains artifact-specific: the Vite build generates notices from the modules actually bundled into the browser, runtime npm dependencies retain their own installed licenses, and the locally distributed IBM Plex fonts retain their SIL OFL texts. IBM Plex Sans SC comes from the integrity-pinned official `@ibm/plex-sans-sc@1.1.0` archive; only untouched publisher-generated Unicode splits are redistributed, so the OFL Reserved Font Name `Plex` is not applied to a local Modified Version.

Sources:

- [Pi MIT license at reviewed commit](https://github.com/earendil-works/pi/blob/936aff00918de1187f085f123c2812d8f2d67745/LICENSE)
- [jmfederico/pi-web MIT license](https://github.com/jmfederico/pi-web/blob/7885c75085d354f41a802372ca65d8e32b914f93/LICENSE)
- [agegr/pi-web MIT license](https://github.com/agegr/pi-web/blob/598c3c6f3c11b0e3bfc4c39cc8884ea7e3e3da34/LICENSE)
- [Epsilondelta-ai/pi-web MIT license](https://github.com/Epsilondelta-ai/pi-web/blob/8b8bf7b2f162617ca1a7823bb4a52a4ac35cac35/LICENSE)
- [pi-dashboard MIT license](https://github.com/samfoy/pi-dashboard/blob/4d8b6eff3fcd6458055066f21b9c1bdbab5dc71f/LICENSE)
- [Piface MIT license](https://github.com/jbn/piface/blob/6172144f221b5f6e2240d9ca1bb7cc522607ef62/LICENSE)
- [pi-gui MIT license](https://github.com/minghinmatthewlam/pi-gui/blob/eb9a7380705dffad36db3efa771ee825aafbef6f/LICENSE)
- [PizzaPi Apache-2.0 license](https://github.com/Pizzaface/PizzaPi/blob/8d254569f1f8ba74b457354b6447f63c470dce01/LICENSE)

## cscience and Claude Science

The reviewed `Haleclipse/cscience` tree is a launcher, unpacker, and AST patcher for an already-built Claude Science runtime rather than a maintainable GUI source project. Its repository can ground packaging facts, but its GUI observations come from released minified assets and are design references only.

Useful product patterns visible in the release are typed text/thinking/tool/delegation blocks, paired tool results, project and frame organization, reconnectable streaming buffers, a shared Markdown renderer with KaTeX, and first-class panes for plans, code, provenance, environment, and varied artifacts. These patterns justify the workbench and rendering direction; the unavailable source and uncertain upstream GUI licensing rule out direct reuse.

Sources:

- [`cscience` fixed commit](https://github.com/Haleclipse/cscience/tree/6b6f0654f8861652e04119d40f0794aaa0e88045)
- [`cscience` package dependencies](https://github.com/Haleclipse/cscience/blob/6b6f0654f8861652e04119d40f0794aaa0e88045/package.json#L1-L21)
- [`cscience` local launcher](https://github.com/Haleclipse/cscience/blob/6b6f0654f8861652e04119d40f0794aaa0e88045/pkg/platform/bin/claude-science.mjs#L61-L94)
- [Released GUI asset inventory](https://unpkg.com/@cometix/cscience@0.0.2-linux-x64/?meta)

## OpenAI4S

OpenAI4S is a complete local web application whose browser is a projection over durable SQLite, workspace, artifact, and action-ledger state plus transient WebSocket events. Its dashboard and conversation workspace establish a useful product shape: session navigation at the left, conversation in the center, and notebook, timeline, or files at the right.

The reusable architectural lesson is the separation of canonical durable state, bounded/redacted browser projections, and live deltas. Conversation, immutable execution history, and safe action timeline are separate views rather than one terminal transcript. The implementation itself is not a suitable base: the frontend is a large untyped vanilla JavaScript application, the gateway and client protocol contain compatibility irregularities, and chat does not provide a full KaTeX or MathJax pipeline.

Sources:

- [`OpenAI4S` fixed commit](https://github.com/PKU-YuanGroup/OpenAI4S/tree/e71954465d8b003e656e37741bbc2496bcb2fd3d)
- [Web UI structure](https://github.com/PKU-YuanGroup/OpenAI4S/blob/e71954465d8b003e656e37741bbc2496bcb2fd3d/openai4s/server/webui/index.html#L23-L175)
- [Browser projection boundary](https://github.com/PKU-YuanGroup/OpenAI4S/blob/e71954465d8b003e656e37741bbc2496bcb2fd3d/openai4s/server/webui/app.js#L112-L128)
- [REST and WebSocket roles](https://github.com/PKU-YuanGroup/OpenAI4S/blob/e71954465d8b003e656e37741bbc2496bcb2fd3d/docs/webapp-api.md#L7-L28)
- [Streaming Markdown contract](https://github.com/PKU-YuanGroup/OpenAI4S/blob/e71954465d8b003e656e37741bbc2496bcb2fd3d/tests/test_webui_static_contract.py#L266-L292)
- [Limited LaTeX artifact parser](https://github.com/PKU-YuanGroup/OpenAI4S/blob/e71954465d8b003e656e37741bbc2496bcb2fd3d/openai4s/server/webui/scientific_renderers.js#L226-L276)

## Pi web concurrency references

Three Pi web clients demonstrate the same useful boundary. `pi-web` keeps active runtimes and activity state in maps keyed by session identity, then derives separate unread completion state from active-to-idle transitions. `pi-dashboard` likewise owns a map of independently started slots, while Piface owns a dictionary of live sessions and groups its dashboard by working directory and recency.

insπre adopts the common product boundary rather than any implementation: one long-lived worker per opened session, browser selection as a view operation, per-session live/completion/error projection, and exact-working-directory navigation groups. This boundary keeps state in the running host without importing peer-specific persistence, health sweeps, terminal surfaces, or broad compatibility layers.

Sources:

- [`pi-web` active runtime and activity maps](https://github.com/jmfederico/pi-web/blob/24a3d3611ed81232e4a87bb22ff8fb6760ead9d8/src/server/sessions/piSessionService.ts#L663-L670)
- [`pi-web` active-to-unread completion transition](https://github.com/jmfederico/pi-web/blob/24a3d3611ed81232e4a87bb22ff8fb6760ead9d8/src/server/sessions/sessionUnreadStore.ts#L116-L145)
- [`pi-web` session-row activity precedence](https://github.com/jmfederico/pi-web/blob/24a3d3611ed81232e4a87bb22ff8fb6760ead9d8/src/client/src/components/SessionList.ts#L519-L537)
- [`pi-dashboard` independent slot map and lazy runtime creation](https://github.com/samfoy/pi-dashboard/blob/d8be67d4eadc8bc10a309513b59a0485373ef833/backend/pi-manager.ts#L1039-L1073)
- [Piface live-session ownership](https://github.com/jbn/piface/blob/6172144f221b5f6e2240d9ca1bb7cc522607ef62/piface/session_manager.py#L51-L65)
- [Piface working-directory grouping and session status](https://github.com/jbn/piface/blob/6172144f221b5f6e2240d9ca1bb7cc522607ef62/README.md#L91-L96)

## Git-aware file inspection

VS Code and Zed both connect a changed-file index to a file diff and project-tree status decorations; Zed also distinguishes opening the current file from opening its diff and reflects command-line changes immediately. GitHub Desktop makes the changed-file list and diff one review flow, with unified or split layouts and expandable context.

The common fit for insπre is an informational layer over its existing Files and preview surfaces: a Changes index, compact status decorations, and one shared `File` / `Diff` detail region. The contextual pane favors a bounded unified diff; repository mutations, split layout, history, and blame are separate product choices rather than implied parts of inspection.

Sources:

- [VS Code source control](https://code.visualstudio.com/docs/sourcecontrol/overview)
- [GitHub Desktop change review](https://docs.github.com/en/desktop/making-changes-in-a-branch/committing-and-reviewing-changes-to-your-project-in-github-desktop)
- [Zed Git](https://zed.dev/docs/git)

## Visual direction

Both references use compact user bubbles and open assistant document flows. Their interfaces combine neutral surfaces, fine borders, soft radii, restrained shadows, and keyboard accelerators with visible controls. These common patterns are suitable references for insπre’s conversation-centered scientific-workbench character.

Claude Science is the primary visual benchmark. Its released style system supports light, dark, and system modes; uses Anthropic Sans for the interface and default response flow, Anthropic Serif for title or optional response treatment, and Anthropic Mono for code; and combines neutral surfaces with clay branding and controlled semantic colors. OpenAI4S follows a related but more utilitarian treatment: its body and Markdown flow are sans-serif, serif type marks the wordmark and selected titles, monospaced type carries code and data, and its warm-neutral surface system uses a blue primary accent with limited clay, status, and tool colors.

insπre adopts the shared visual grammar rather than either reference brand. Claude Science leads typography roles, surfaces, boundaries, radii, shadows, and finish. OpenAI4S remains a secondary reference for direct local-tool interaction, command-palette behavior, and practical information organization. Its light and dark palettes are original project tokens; IBM Plex is an independently selected, openly licensed type system obtained from IBM's official distribution, not a reference-application asset.

Sources:

- [Claude Science released style system](https://unpkg.com/@cometix/cscience@0.0.2-linux-x64/runtime/assets/web-dist/assets/index-D3CLqYKb.css)
- [Claude Science released message presentation](https://unpkg.com/@cometix/cscience@0.0.2-linux-x64/runtime/assets/web-dist/assets/MessageBubble-DlbWFzLl.js)
- [OpenAI4S visual tokens and conversation styles](https://github.com/PKU-YuanGroup/OpenAI4S/blob/e71954465d8b003e656e37741bbc2496bcb2fd3d/openai4s/server/webui/style.css)
- [OpenAI4S command palette and keyboard interaction](https://github.com/PKU-YuanGroup/OpenAI4S/blob/e71954465d8b003e656e37741bbc2496bcb2fd3d/openai4s/server/webui/app.js#L6361-L6487)
