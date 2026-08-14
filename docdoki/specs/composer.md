---
purpose: One browser composer submits ordinary prompts, project context, images, files, steering messages, and follow-ups without exposing local privileges.
covers:
  - package.json
  - vite.config.ts
  - server/app.ts
  - server/attachments.ts
  - server/model-catalog.ts
  - server/project-files.ts
  - server/runtime.ts
  - server/session-projection.ts
  - shared/resource-references.ts
  - src/api.ts
  - src/controllers/composer-controller.ts
  - src/store.ts
  - src/App.tsx
  - src/clipboard-files.ts
  - src/composer-completion.ts
  - src/model-options.ts
  - src/components/AttachmentList.tsx
  - src/components/Composer.tsx
  - src/components/ComposerInput.tsx
  - src/components/ImagePreview.tsx
  - src/components/ProjectFiles.tsx
  - src/components/Transcript.tsx
  - src/components/Welcome.tsx
  - tests/server/app.test.ts
  - tests/server/model-catalog.test.ts
  - tests/server/session-projection.test.ts
  - tests/web/composer-completion.test.ts
  - tests/web/composer-controller.test.ts
  - tests/web/composer-sessions.test.tsx
  - tests/web/composer.test.tsx
  - tests/web/model-options.test.ts
  - tests/web/store.test.ts
  - tests/web/transcript-inspection.test.tsx
  - tests/web/welcome-new-session.test.tsx
---

# Conversation composer

## Goal

Cover the input modes needed to replace the primary terminal conversation loop.

## Checks

- The composer accepts multiline text; each session keeps its own unsent draft, staged attachments, and project-file references, restored when the user switches back (in-memory — staged work does not survive a reload). Empty session partitions are discarded, while non-empty partitions remain until their user-owned work is sent or removed. `ComposerController` owns the bounded per-session attachment/project-file partitions and delivery lifecycle through `AppStore`'s narrow facade; `AppStore` remains the sole browser snapshot and cross-domain commit authority.
- Project files can be found through the project index, either in the explicit picker or from the textarea’s active caret token. An established composer addresses the immutable workspace owned by its session; the start surface uses the typed path (or inherited current path) as a read-only prospective workspace and binds selected results to its canonical root. Changing that path clears staged references, and creation uses the bound canonical root so a symlink retarget cannot reinterpret a selected relative file. Neither search path authorizes prompt access: the prompt boundary revalidates every staged path against the created session’s index. `@` completion never treats other mentions as file authority: choosing a returned canonical path removes only the active token, preserves the surrounding draft and caret, and stages one deduplicated removable file-reference chip.
- Leading `/` completion is offered only while the caret remains inside the command token Pi would parse. Once the user types a query, Pi TUI’s public `fuzzyFilter` ranks command names globally across sources; descriptions explain results but never admit unrelated commands, while the unfiltered inventory remains grouped by source. The browser build resolves that matcher to Pi TUI’s pure fuzzy module rather than bundling its terminal-only dependencies. Pi’s runtime commands retain source attribution and first wire ownership so extension-before-prompt/skill collision behavior matches Pi dispatch; inspire then explicitly overrides `/compact` from the same descriptor/parser authority as its execution boundary. Choosing a result inserts the exact command plus a trailing space without executing it.
- Both completion lists expose loading, empty, and failure states, support pointer and arrow/Enter/Tab/Escape interaction with combobox/listbox semantics, suppress stale session results, and defer to IME composition, multiline input, steering, and follow-up behavior. The multiline textbox keeps DOM focus and owns `aria-controls`, `aria-activedescendant`, and autocomplete state inside its named ARIA 1.1 combobox composite. The shared active/start-surface `ComposerInput` disables browser spelling and grammar proofing: mixed-language technical terms, paths, formulas, and model identifiers must not acquire browser-dependent red or blue underlines that look like product validation.
- Images can be pasted, dropped, or selected. Staged images are distinct thumbnail tiles rather than metadata chips: name, MIME, and size stay hidden, removal remains an overlay action, and activating a tile opens a focus-contained full-image preview. The viewer places a crisp, shadowless image above one viewport-sized blurred scrim; image activation toggles fit/2× zoom, movement must cross a threshold before a zoomed image pans, and only the backdrop, close control, or Escape dismisses it. Native image dragging is disabled throughout, so inspecting an image can never restage it into the composer. After delivery the owning user turn retains the same inspectable image evidence across refreshes: Pi's canonical JSONL keeps the bytes, the bounded transcript projection carries only MIME plus stable message/part coordinates, and the session/view-bound resource adapter serves the mounted thumbnail without duplicating image bytes into the browser snapshot.
- Ordinary files can be selected or dropped, with their name, type, size, and submission meaning visible before sending. A browser paste uses `clipboardData.files` as its one complete source when non-empty and falls back to file-kind `clipboardData.items` only when `files` is empty. It never combines the two browser projections (which can manufacture two `File` objects for one paste), and it never content-deduplicates genuinely distinct files merely because their name, size, type, and timestamp coincide.
- Input submitted while Pi is active is explicitly sent as steering input or queued as a follow-up. `running`, `retrying`, `compacting`, and `queued` are one shared browser/host busy-state authority, so queued work exposes a visible two-option `Steer` / `Queue next` segmented control beside abort; the selected mode changes the input placeholder and the send action's accessible name, rather than hiding delivery behind a shortcut. Conflict recovery remains abortable but is not part of active busy ownership. The activity surface reports only the queued count; complete host-projected steering and follow-up text remains in the labelled pending transcript rows. Pi exposes no edit or withdrawal control for committed queue entries, so the workbench does not pretend to manage them.
- A typed `/compact [instructions]` is routed at the host prompt boundary to Pi's compact control, because the runtime does not parse built-in commands out of prompt text.
- The composer displays the selected model, thinking level, and context occupancy as quiet controls that do not crowd the writing surface; project identity lives in the topbar per [[workbench]]. Its message tools are ordered by decision scope — model, thinking effort, project files, then external attachments — before the separate right-aligned context and send/abort state. At phone widths the controls wrap into multiple usable rows: model and thinking triggers retain legible text and stable minimum hit areas, the trailing status/action cluster owns a full row, and no flex child may shrink into overlapping labels. The model picker groups Pi-provided models by canonical provider identity, searches provider/id/display fields locally, labels active/recent/capability state, restores trigger focus after Enter, click, or Escape without waiting for asynchronous model ownership, retains that focus through a later mutation-error rerender, and uses only successful model changes to maintain a bounded global MRU ordering within each provider. Unavailable MRU identities stay harmless preference history and are omitted from the current projection. A rejected model change never updates active truth or recency; a rejected thinking-level change rolls back its optimistic value while its session remains visible. Both report a non-blocking warning notice rather than a global error banner.
- The start surface uses the ordinary composer anatomy and the same shared caret-completion input and message-tool order as an active session, and accepts text-only, project-file-only, image-only, ordinary-file-only, or mixed first messages. Its readiness projection appears only while Start is blocked, resolving, failing, or starting (`Choose a project`, input/file, resolving/selecting model, or a failed default-model resolution with direct retry); once ready, the visible project and model controls speak for themselves. It treats Pi's `unknown/unknown` absent-model sentinel as no model rather than a selectable worker target, rather than leaving a generic disabled button. Model, thinking effort, project files, and attachments share the first tool row; a full-width project address occupies the second row, with its host-directory browser embedded at the address’s left edge. While it inherits the currently visible project, slash completion uses that selected Pi worker's authoritative runtime commands plus inspire's host-owned commands; after the user explicitly targets another directory, only host-owned commands remain because no Pi worker has loaded that project's extensions, prompts, or skills yet. Files remain browser-local until Pi returns the new session identity, then move through the same bounded upload/attachment owner and prompt lifecycle as an existing session. Its writing area grows with the draft up to a bounded viewport height. Model and thinking controls inherit the currently visible choice when one exists, including a model that arrives after the surface mounts. Without an inheritable session model, the host performs a read-only in-memory resolution through Pi’s public SDK for the prospective workspace, and the picker displays that real model rather than treating an omitted startup argument as an unexplained `Select model` state. The resolved or explicitly selected provider/id and supported thinking level are always passed to the creating Pi worker before the first prompt; no synthetic `Pi default` option or silent model omission exists. A model that does not support reasoning disables thinking instead of inventing a value.
- Submission errors preserve the draft and attachments. The project-file picker is one textbox-owned combobox: its input keeps DOM focus, exposes the popup with `aria-controls` and the active option with `aria-activedescendant`, and owns Arrow/Enter/Tab/Escape while disabled rows are skipped and every query generation clears obsolete results before new ones arrive. Home and End retain their ordinary editable-search text navigation rather than moving the active option. Project-file chips are frozen while delivery is in flight, remain partitioned with other composer artifacts by session, and clear only from the owning partition after the host accepts the exact delivery that included them. Attachment uploads still in flight, failed attachment chips, and attachment/project-reference caps prevent submission or staging with non-blocking warning notices rather than replacing the session-wide error banner. A delayed completion may update its originating session's draft/attachment/status partition, but it sets or clears the visible global error only when that session still owns the visible surface.
- Attachment data crosses the trusted host only through bounded, validated operations and is not silently uploaded elsewhere by inspire. One shared contract limits a message to eight attachments, 16 MiB per file, 32 MiB of raw attachment bytes, and 20 MiB of raw image bytes. The browser rejects excess staging before upload; the host's multipart storage counts raw file bytes while streaming directly into a private `0600` process cache and aborts the batch at 32 MiB; prompt resolution revalidates totals, encodes images sequentially within a bounded base64 budget, and the Pi RPC writer rejects any serialized command line above 32 MiB before touching stdin. The matching stdout reader permits only that bound plus a 1 MiB event-envelope allowance, so Pi can echo an accepted image message without making the child unbounded or killing it under a contradictory 8 MiB cap. Dead process cache directories are reclaimed on startup, and shutdown removes this host's cache only after active HTTP uploads have drained.
- Uploaded attachments have a bounded host-side lifetime: withdrawing a staged attachment deletes its host cache copy, image bytes are reclaimed once a delivered prompt has consumed them, and ordinary files persist for the host’s lifetime because their host paths are referenced by the conversation text.

## Non-goals

- The first release does not need a complete project file manager.
- File attachment does not imply arbitrary automatic ingestion of every file format.
