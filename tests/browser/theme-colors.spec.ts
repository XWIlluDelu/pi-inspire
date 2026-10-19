import { readFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { PALETTE_PREFERENCES } from "../../shared/contracts";
import { renderedColors } from "./support/colors";

const css = (
  await Promise.all(
    [
      "foundation",
      "choice-input",
      "navigation",
      "topbar",
      "transcript",
      "activity-cards",
      "composer",
      "image-preview",
      "workbench",
      "terminal",
      "welcome",
      "settings-overlays",
      "model-settings",
      "system-settings",
      "history",
    ].map((name) => readFile(`src/styles/${name}.css`, "utf8")),
  )
).join("\n");
const surfaces = [
  "stage",
  "rail",
  "context",
  "surface",
  "raised",
  "inset",
  "control",
  "prompt",
];
// Component notices use their real host surface, not arbitrary user bubbles
// or input backgrounds. Generic chips/text below support the wider ladder.
const notices = [
  ["prompt-map__error", "raised"],
  ["terminal-view__error", "raised"],
  ["terminal-pane__error", "raised"],
  ["session-delete__error", "raised"],
  ["session-delete__warning", "raised"],
  ["nav__error", "rail"],
  ["branches__stale", "surface"],
  ["file-preview__notice", "file-canvas"],
  ["source-view__boundary", "file-canvas"],
  ["source-diff__boundary", "file-canvas"],
  ["changes__projection-note", "context"],
  ["res__index-summary--clean", "stage"],
  ["res__index-summary--dirty", "stage"],
  ["changes__additions", "context"],
  ["changes__deletions", "context"],
  ["file-path-action file-path-action--copied", "stage"],
  ["res__index-summary--conflict", "stage"],
];
// Plain status messages need text ink too: a neutral panel is not always white
// or the darkest surface. Keep decorative marks out of this text-role contract.
const statusMessages = [
  ["chip chip--activity-event", "stage", "activity-event-ink"],
  ["tool-notice tool-notice--warning", "stage", "warning-ink"],
  ["tool-notice tool-notice--error", "stage", "error-ink"],
  ["composer__failed-delivery", "surface", "error-ink"],
  ["completion__empty completion__empty--error", "raised", "error-ink"],
  ["image-lightbox__error", "raised", "error-ink"],
  ["models-status", "surface", "error-ink"],
  ["settings__error", "surface", "error-ink"],
  ["settings__field-status", "surface", "warning-ink"],
  ["export-dialog__error", "raised", "error-ink"],
  ["dirpicker__note dirpicker__note--error", "raised", "error-ink"],
  ["models-default-value__warning", "surface", "warning-ink"],
  ["system-versions__error", "surface", "error-ink"],
  ["terminal-text-dialog__error", "raised", "error-ink"],
  ["terminal-settings__footer", "raised", "error-ink"],
  ["earlier-branch-banner__error", "surface", "error-ink"],
  ["assistant-error__label", "surface", "error-ink"],
  ["pending-groups__confirm-label", "surface", "error-ink"],
  ["welcome__error", "stage", "error-ink"],
  ["welcome__readiness welcome__readiness--error", "stage", "error-ink"],
  ["files-browser__note files-browser__note--action", "context", "warning-ink"],
  ["token-gate__error", "surface", "error-ink"],
] as const;
const commandStates = [
  ["info", "info-ink", "info"],
  ["running", "accent-deep", "accent-deep"],
  ["success", "success-ink", "success"],
  ["warning", "warning-ink", "warning"],
  ["cancelled", "muted", "muted"],
  ["error", "error-ink", "error"],
] as const;
const controls = [
  ["primary", 4.5],
  ["danger", 4.5],
  ["danger-outline", 4.5],
  ["danger-quiet", 4.5],
  ["danger-menu", 4.5],
  ["danger-provider", 4.5],
  ["ordinary", 4.5],
  ["reload", 4.5],
  ["send", 3],
  ["abort", 3],
  ["recover", 3],
] as const;

// Same selection semantics, including surfaces with local geometry overrides.
const choiceGroups = [
  ["default", "", "segmented", "segmented__item"],
  ["settings", "dialog settings", "segmented", "segmented__item"],
  [
    "terminal-settings",
    "dialog terminal-settings",
    "segmented",
    "segmented__item",
  ],
  ["composer", "composer__delivery", "segmented", ""],
  ["prepared-prompt", "palette__prepare", "segmented", ""],
  ["resource-mode", "", "ctx__modes", ""],
  ["palette", "dialog settings", "palette-picker", "palette-picker__choice"],
] as const;

for (const palette of PALETTE_PREFERENCES)
  for (const theme of ["light", "dark"]) {
    test(`${palette} ${theme}: readable controls and status text across surfaces`, async ({
      page,
    }) => {
      await page.route("**/__theme-controls__", (route) =>
        route.fulfill({
          contentType: "text/html",
          body: `<!doctype html><html data-palette="${palette}" data-theme="${theme}">
          <style>${css}
          * { transition: none !important; animation: none !important; }
          body { padding: 24px; background: var(--bg-stage); overflow: auto; }
          section { display: flex; flex-wrap: wrap; gap: 12px; padding: 12px; }
          .app-error { min-height: 0; padding: 12px; }
          </style>
          <section aria-label="Semantic color roles">
            <button class="settings__action-button" id="focus-action">Action</button>
            <input class="choice-input" type="checkbox" id="focus-choice" aria-label="Choice">
            <button class="terminal-tab__select" id="focus-terminal">Terminal</button>
            <div class="nav__search" id="focus-search"><input aria-label="Session search"></div>
            <div class="transcript-search transcript-search--active" id="focus-transcript"><input aria-label="Transcript search"></div>
            <button class="transcript__older-retry" id="focus-retry">Retry history</button>
            <button class="nav__pagination-button" id="focus-pagination">More sessions</button>
            <label class="settings-switch">
              <input type="checkbox" checked id="role-switch" aria-label="Setting">
              <span class="settings-switch__track"><span class="settings-switch__thumb"></span></span>
            </label>
            <button class="activity-fold__omission activity-fold__omission--error" id="omission-error">Retry earlier activity</button>
            <button class="activity-fold__disclosure activity-fold__disclosure--error" id="disclosure-error">Activity</button>
          </section>
          <button class="button button--primary" id="primary">Save</button>
          <button class="button button--danger" id="danger">Delete</button>
          <section style="background:var(--bg-surface)">
            <button class="button button--danger-outline" id="danger-outline">Restart</button>
            <button class="button button--danger-quiet" id="danger-quiet">Clear history</button>
            <div class="terminal-menu__popover" style="position:static">
              <button class="terminal-menu__danger" id="danger-menu">Force terminate</button>
            </div>
            <div class="models-auth"><button class="models-remove-credential" id="danger-provider">Remove credentials</button></div>
          </section>
          <section aria-label="Standalone and form control states">
            <div class="dropdown dropdown--field"><button class="dropdown__trigger" id="field-dropdown" aria-expanded="false">Form value</button></div>
            <div class="dropdown"><button class="dropdown__trigger" id="quiet-dropdown" aria-expanded="false">Composer value</button></div>
            <div class="models-auth"><button class="models-text-button models-auth__connect" id="provider-connect">Connect provider</button></div>
            <div class="attachment"><span>Attachment</span><button class="attachment__remove" id="attachment-remove">×</button></div>
            <div class="dirpicker__list"><button class="dirpicker__row" id="directory-row">Folder</button></div>
            <h1 class="topbar__title"><button class="topbar__title-button" id="session-title"><span>Session title</span></button></h1>
            <div class="session-actions-menu" style="position:static"><button id="clone-action">Clone current branch</button></div>
            <div class="composer__failed-delivery"><button class="button button--quiet" id="restore-action">Restore</button></div>
          </section>
          <section aria-label="Status actions" style="background:var(--bg-stage)">
            <button class="topbar__git" id="git-normal"><span class="topbar__git-branch">main</span></button>
            <button class="topbar__git topbar__git--stale" id="git-stale">
              <svg class="topbar__git-icon" width="13" height="13" aria-hidden="true"></svg>
              <span class="topbar__git-branch">main</span><span class="topbar__git-count">3 changes</span>
            </button>
            <button class="topbar__git topbar__git--conflict" id="git-conflict">
              <span class="topbar__git-branch">main</span><span class="topbar__git-count">1 conflict</span>
            </button>
            <button class="meter meter--warning" id="meter-warning"><svg class="meter__ring" aria-hidden="true"><circle class="meter__ring-fill"></circle></svg><span>70%</span></button>
            <button class="meter meter--error" id="meter-error"><svg class="meter__ring" aria-hidden="true"><circle class="meter__ring-fill"></circle></svg><span>90%</span></button>
          </section>
          <section style="background:var(--bg-rail)">
            <button class="workspace-tree__status workspace-tree__status--error" id="workspace-error">
              <svg width="11" height="11" aria-hidden="true"></svg><span>Directory unavailable</span>
            </button>
          </section>
          <section style="background:var(--bg-context)">
            <button class="files-browser__note files-browser__note--action" id="files-retry">
              <svg width="12" height="12" aria-hidden="true"></svg>Retry recent files
            </button>
          </section>
          <section aria-label="Icon button states">
            <button class="icon-button" id="icon" aria-label="Add files">+</button>
            <button class="icon-button icon-button--active" id="icon-selected" aria-label="Resources" aria-expanded="true">▤</button>
            <button class="icon-button pending-group__control pending-group__control--clear" id="icon-clear" aria-label="Clear pending input">×</button>
            <button class="models-icon-button" id="icon-model" aria-label="Move model up">↑</button>
            <div class="file-detail-header"><button class="icon-button" id="icon-file" aria-label="File action">↗</button></div>
            <div class="composer__input-wrap" style="width:36px;height:36px;flex:none"><button class="icon-button composer__expand" id="icon-expand" aria-label="Expand composer">↗</button></div>
          </section>
          <section aria-label="Choice selection states">
            ${choiceGroups
              .map(
                ([id, parent, group, item]) => `
              <div class="${parent}" style="position:static;width:auto;height:auto;display:block">
                <div class="${group}" id="choices-${id}" role="group" aria-label="${id}" style="width:320px;flex:none">
                  <button class="${item}" aria-pressed="true"><svg width="12" height="12" aria-hidden="true"></svg>Selected</button>
                  <button class="${item}" aria-pressed="false">Other</button>
                </div>
              </div>`,
              )
              .join("")}
            <span class="settings__section-icon" id="section-icon"><svg width="14" height="14" aria-hidden="true"></svg></span>
          </section>
          <button class="button" id="ordinary">Cancel</button>
          <div class="app-error"><button id="reload">Reload page</button></div>
          <button class="composer__send" id="send" aria-label="Send">↑</button>
          <button class="composer__send composer__send--abort" id="abort" aria-label="Abort">■</button>
          <button class="composer__send composer__send--recover" id="recover" aria-label="Recover">↻</button>
          ${surfaces
            .map(
              (surface) => `<section style="background:var(--bg-${surface})">
            <span data-role="muted" style="color:var(--muted)">Supporting text</span>
            <span data-role="faint" style="color:var(--faint)">Metadata</span>
            ${["warning", "error", "info", "accent", "muted"]
              .map(
                (status) =>
                  `<span class="chip chip--${status}" data-role="${status}">${status}</span>`,
              )
              .join("")}
          </section>`,
            )
            .join("")}
          ${notices
            .map(
              ([
                name,
                surface,
              ]) => `<section style="background:var(--bg-${surface})">
            <div class="${name}" data-role="${name}">Status message</div>
          </section>`,
            )
            .join("")}
          ${statusMessages
            .map(
              ([
                name,
                surface,
                ink,
              ]) => `<section style="background:var(--bg-${surface})">
            <div class="${name}" ${name === "models-status" ? 'role="alert"' : ""} data-role="${name}" data-ink="${ink}">Status message</div>
          </section>`,
            )
            .join("")}
          <section aria-label="Command result states" style="background:var(--bg-stage)">
            ${commandStates
              .map(
                ([status, ink, mark]) => `
              <article class="command-activity__item command-activity__item--${status}">
                <div class="command-activity__icon"><svg data-state-mark="${mark}" width="14" height="14" aria-hidden="true"></svg></div>
                <div class="command-activity__body">
                  <div class="command-activity__heading">
                    <code>/session</code>
                    <span class="command-activity__state" data-role="command-${status}" data-ink="${ink}">Command status</span>
                  </div>
                </div>
              </article>`,
              )
              .join("")}
          </section>
          <section aria-label="Context and extension identities" style="background:var(--bg-stage)">
            <div class="context-checkpoint">
              <svg class="context-checkpoint__icon" data-state-mark="activity-event" width="14" height="14" aria-hidden="true"></svg>
            </div>
            <div class="custom-message"><div class="custom-message__head">
              <svg data-state-mark="activity-event" width="14" height="14" aria-hidden="true"></svg>
              <span class="custom-message__title" data-role="extension-title" data-ink="ink">Extension message</span>
              <span class="custom-message__source" data-role="extension-source" data-ink="muted">Intercom</span>
            </div></div>
            <form class="composer composer--compacting" id="compacting-identity"><input aria-label="Compacting draft"></form>
          </section>
          <section class="shell-execution card card--failed">
            <div class="shell-execution__header"><span class="shell-execution__status" data-role="shell-failed-status" data-ink="error-ink">Exit code 1</span></div>
            <p class="shell-execution__error" data-role="shell-error" data-ink="error-ink">Shell request failed</p>
          </section>
          <section class="card card--tool card--failed">
            <svg class="card__icon" data-state-mark="activity-tool" width="14" height="14" aria-hidden="true"></svg>
            <div class="tool-call-list__heading">Calls <span class="tool-call-list__error-count" data-role="failed-call-count" data-ink="error-ink">1 failed</span></div>
            <span class="child-call__status child-call__status--error" data-state-mark="error"><svg width="12" height="12" aria-hidden="true"></svg></span>
            <span class="child-call__status child-call__status--ok" data-state-mark="success"><svg width="12" height="12" aria-hidden="true"></svg></span>
            <div class="child-call__detail"><pre class="card__mono card__mono--error" data-role="child-error" data-ink="error-ink">Call failed</pre></div>
            <pre class="card__mono card__mono--error" data-role="fallback-error" data-ink="error-ink">Tool failed</pre>
            <pre class="tool-text tool-text--error" data-role="tool-text-error" data-ink="error-ink">Tool returned an error</pre>
            <pre class="tool-terminal tool-terminal--error"><span data-role="tool-terminal-error" data-ink="error-ink">Command failed</span><span data-authored-color style="color:rgb(205,49,49)">Explicit ANSI color</span></pre>
            <div class="tool-markdown tool-markdown--error"><div class="rich-text"><p data-role="tool-markdown-error" data-ink="error-ink">Request failed</p></div></div>
          </section>
          <section class="res__preview">
            <div class="notebook-preview__output notebook-preview__output--error">
              <div class="notebook-preview__output-body"><pre data-role="notebook-error" data-ink="error-ink">Traceback</pre></div>
            </div>
          </section>
          <section style="background:var(--bg-raised)">
            <div class="terminal-settings__loading"><p role="alert" data-role="terminal-settings-loading" data-ink="error-ink">Failed to load settings</p></div>
            ${["info", "warning", "error"]
              .map(
                (status) => `
              <div class="notice notice--${status}"><span class="notice__title" data-role="notice-${status}">Notification</span></div>`,
              )
              .join("")}
          </section>
          <section style="background:var(--bg-stage)">
            ${["warning", "error", "success"]
              .map(
                (status) => `
              <span class="history-shell__status" data-outcome="${status}" data-role="history-${status}">Command status</span>`,
              )
              .join("")}
          </section>
          <section style="background:var(--bg-context)">
            <div class="history-turn" data-current="true">
              <button class="history-prompt"><span>Prompt</span><small data-history-label data-role="history-current-conversation" data-ink="accent-deep">Current conversation</small></button>
            </div>
            <button class="history-entry"><span>Activity</span><span class="history-position" data-history-label data-role="history-current-point" data-ink="accent-deep">Current point</span></button>
          </section>
          <section class="terminal-pane" style="background:var(--bg-stage)">
            <section class="terminal-pending" aria-label="Unconfirmed terminal controls">
              <div class="terminal-pending__row"><span class="terminal-pending__description">Outcome unknown</span><button class="button button--quiet">Retry same operation</button></div>
            </section>
            <button class="terminal-pane__error" data-role="terminal-pending-error" data-ink="error-ink">Terminal outcome remains unknown</button>
          </section>
          <section style="background:var(--bg-canvas)">
            ${["warning", "error"]
              .map(
                (status) => `
              <div class="banner banner--${status}"><span data-role="banner-${status}">Connection status</span><button data-banner-action>Retry</button></div>`,
              )
              .join("")}
          </section>
        </html>`,
        }),
      );
      await page.goto("/__theme-controls__");
      // Resolve roles through CSS, then check their consumers rather than
      // accepting equal swatch values as proof of correct role wiring.
      const roles = await page.evaluate(() => {
        const probe = document.createElement("span");
        document.body.append(probe);
        const colors = Object.fromEntries(
          [
            "accent-focus",
            "accent-deep",
            "accent-fill",
            "on-accent",
            "error-ink",
            "error",
            "warning-ink",
            "warning",
            "info-ink",
            "info",
            "success-ink",
            "success",
            "muted",
            "activity-tool",
            "activity-event",
            "activity-event-ink",
            "error-tint",
            "accent-tint",
            "ink",
            "faint",
            "bg-inset",
            "bg-control",
          ].map((role) => {
            probe.style.color = `var(--${role})`;
            return [role, getComputedStyle(probe).color];
          }),
        );
        probe.remove();
        return colors;
      });
      await page.keyboard.press("Tab");
      for (const [control, target, property] of [
        ["#focus-action", "#focus-action", "outline-color"],
        ["#focus-choice", "#focus-choice", "outline-color"],
        ["#focus-terminal", "#focus-terminal", "outline-color"],
        ["#focus-search input", "#focus-search", "border-color"],
        ["#focus-transcript input", "#focus-transcript", "border-color"],
        ["#focus-retry", "#focus-retry", "border-color"],
        ["#role-switch", ".settings-switch__track", "outline-color"],
      ]) {
        await page.locator(control!).focus();
        await expect(page.locator(target!)).toHaveCSS(
          property!,
          roles["accent-focus"]!,
        );
      }
      await expect(page.locator("#focus-transcript")).toHaveCSS(
        "border-color",
        roles["accent-deep"]!,
      );
      await expect(page.locator(".settings-switch__track")).toHaveCSS(
        "background-color",
        roles["accent-fill"]!,
      );
      await expect(page.locator(".settings-switch__thumb")).toHaveCSS(
        "background-color",
        roles["on-accent"]!,
      );

      for (const [id] of choiceGroups) {
        const group = page.locator(`#choices-${id}`);
        const selected = group.locator('[aria-pressed="true"]');
        const other = group.locator('[aria-pressed="false"]');
        await expect(selected).toHaveCSS("color", roles["accent-deep"]!);
        await expect(selected.locator("svg")).toHaveCSS(
          "color",
          roles["accent-deep"]!,
        );
        expect(
          (await renderedColors(selected)).contrast,
          id,
        ).toBeGreaterThanOrEqual(4.5);
        const selectedFill = await selected.evaluate(
          (el) => getComputedStyle(el).backgroundColor,
        );
        await expect(other).not.toHaveCSS("color", roles["accent-deep"]!);
        await expect(other).not.toHaveCSS("background-color", selectedFill);
        await selected.focus();
        await selected.hover();
        await page.mouse.down();
        await expect(selected).toHaveCSS("color", roles["accent-deep"]!);
        await expect(selected).toHaveCSS("background-color", selectedFill);
        await page.mouse.up();
        // Palette buttons are never disabled; native segments and view modes can be.
        if (id !== "palette") {
          await selected.evaluate((el: HTMLButtonElement) => {
            el.disabled = true;
          });
          await expect(selected).toHaveCSS("color", roles.faint!);
        }
      }
      await expect(page.locator("#section-icon")).toHaveCSS(
        "color",
        roles["accent-deep"]!,
      );

      for (const label of await page.locator("[data-history-label]").all()) {
        const action = label.locator("..");
        for (const state of ["hover", "press", "focus"]) {
          if (state === "hover") await action.hover();
          else if (state === "press") await page.mouse.down();
          else {
            await page.mouse.up();
            await page.keyboard.press("Tab");
            await action.focus();
          }
          await expect(label).toHaveCSS("color", roles["accent-deep"]!);
          expect((await renderedColors(label)).contrast).toBeGreaterThanOrEqual(
            4.5,
          );
        }
      }

      const pagination = page.locator("#focus-pagination");
      await expect(pagination).toHaveCSS("border-radius", "6px");
      await pagination.hover();
      await expect(pagination).toHaveCSS("border-color", roles["accent-deep"]!);
      await pagination.focus();
      // Simultaneous hover must not hide focus or substitute focus color for text ink.
      await expect(pagination).toHaveCSS(
        "border-color",
        roles["accent-focus"]!,
      );
      await expect(pagination).toHaveCSS("color", roles["accent-deep"]!);
      for (const id of ["focus-retry", "focus-transcript"]) {
        const target = page.locator(`#${id}`);
        await (id === "focus-transcript"
          ? target.locator("input")
          : target
        ).focus();
        await target.hover();
        await expect(target).toHaveCSS("border-color", roles["accent-focus"]!);
      }
      for (const id of ["omission-error", "disclosure-error"]) {
        const error = page.locator(`#${id}`);
        await expect(error).toHaveCSS("color", roles["error-ink"]!);
        await error.hover();
        await expect(error).toHaveCSS("color", roles["error-ink"]!);
        await page.mouse.down();
        await expect(error).toHaveCSS("color", roles["error-ink"]!);
        await page.mouse.up();
        await page.keyboard.press("Tab");
        await error.focus();
        await expect(error).toHaveCSS("color", roles["error-ink"]!);
        await expect(error).toHaveCSS("outline-color", roles["accent-focus"]!);
      }
      // Interaction changes affordance, not the meaning of warning/error text.
      for (const [id, text, ink, mark, markProperty, markRole] of [
        [
          "git-stale",
          ".topbar__git-branch, .topbar__git-count",
          "warning-ink",
          "svg",
          "color",
          "warning",
        ],
        ["git-conflict", ".topbar__git-count", "error-ink", null, null, null],
        ["workspace-error", "span", "warning-ink", "svg", "color", "warning"],
        ["meter-warning", "span", "warning-ink", "circle", "stroke", "warning"],
        ["meter-error", "span", "error-ink", "circle", "stroke", "error"],
        ["files-retry", null, "warning-ink", "svg", "color", "warning"],
      ] as const) {
        const action = page.locator(`#${id}`);
        for (const state of ["rest", "hover", "pressed", "focus"]) {
          await page.mouse.move(0, 0);
          if (state === "hover" || state === "pressed") await action.hover();
          if (state === "pressed") await page.mouse.down();
          if (state === "focus") {
            await page.keyboard.press("Tab");
            await action.focus();
          }
          try {
            const labels = text ? await action.locator(text).all() : [action];
            for (const label of labels) {
              await expect(label).toHaveCSS("color", roles[ink]!);
              expect(
                (await renderedColors(label)).contrast,
                `${id} ${state}`,
              ).toBeGreaterThanOrEqual(4.5);
            }
            if (mark)
              await expect(action.locator(mark)).toHaveCSS(
                markProperty!,
                roles[markRole!]!,
              );
            if (state === "focus")
              await expect(action).toHaveCSS(
                "outline-color",
                roles["accent-focus"]!,
              );
          } finally {
            await page.mouse.up();
          }
        }
      }
      await page.locator("#git-normal").hover();
      await expect(page.locator("#git-normal")).toHaveCSS("color", roles.ink!);
      for (const [id, ink, background] of [
        ["icon", "ink", "bg-inset"],
        ["icon-selected", "accent-deep", "accent-tint"],
        ["icon-clear", "error", "error-tint"],
        ["icon-model", "ink", "bg-control"],
        ["icon-file", "ink", "bg-inset"],
        ["icon-expand", "ink", "bg-inset"],
      ]) {
        const button = page.locator(`#${id}`);
        await button.hover();
        // Shared state exclusions must not out-rank local action treatments.
        await expect(button).toHaveCSS("color", roles[ink!]!);
        await expect(button).toHaveCSS("background-color", roles[background!]!);
        if (id === "icon-clear") {
          await page.mouse.move(0, 0);
          await page.keyboard.press("Tab");
          await button.focus();
          await expect(button).toHaveCSS("color", roles.error!);
          await expect(button).toHaveCSS(
            "background-color",
            roles["error-tint"]!,
          );
          await expect(button).toHaveCSS(
            "outline-color",
            roles["accent-focus"]!,
          );
          expect(
            (await renderedColors(button)).contrast,
          ).toBeGreaterThanOrEqual(3);
        }
        if (id === "icon-selected") {
          await page.mouse.down();
          await expect(button).toHaveCSS("color", roles["accent-deep"]!);
          await expect(button).toHaveCSS(
            "background-color",
            roles["accent-tint"]!,
          );
          await page.mouse.up();
          await page.keyboard.press("Tab");
          await button.focus();
          await expect(button).toHaveCSS(
            "outline-color",
            roles["accent-focus"]!,
          );
          await expect(button).toHaveAttribute("aria-expanded", "true");
        }
        await button.evaluate((element: HTMLButtonElement) => {
          element.disabled = true;
        });
        await page.mouse.move(0, 0);
        const disabled = await renderedColors(button);
        await expect(button).toHaveCSS("cursor", "default");
        await expect(button).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
        if (id !== "icon-model")
          await expect(button).toHaveCSS("color", roles.faint!);
        await button.hover({ force: true });
        expect(await renderedColors(button)).toEqual(disabled);
        await page.mouse.down();
        expect(await renderedColors(button)).toEqual(disabled);
        await page.mouse.up();
      }
      // Independent controls and form variants must not bypass disabled state.
      // Keep readable session titles rather than dimming every disabled label.
      for (const [id, ink, hoverProperty, hoverValue] of [
        ["field-dropdown", "faint", "color", roles.ink],
        ["quiet-dropdown", "faint", "background-color", roles["bg-inset"]],
        ["provider-connect", "faint", "text-decoration-line", "underline"],
        ["attachment-remove", "faint", "color", roles.error],
        ["directory-row", "faint", "background-color", roles["bg-inset"]],
        ["session-title", "ink", "background-color", roles["bg-inset"]],
        ["clone-action", "faint", "background-color", roles["bg-inset"]],
        ["restore-action", "faint", "background-color", roles["bg-inset"]],
      ]) {
        const button = page.locator(`#${id}`);
        const appearance = () =>
          button.evaluate((element) => {
            const style = getComputedStyle(element);
            return Object.fromEntries(
              [
                "color",
                "background-color",
                "border-color",
                "box-shadow",
                "text-decoration-line",
                "opacity",
                "cursor",
              ].map((property) => [property, style.getPropertyValue(property)]),
            );
          });
        await button.hover();
        await expect(button).toHaveCSS(hoverProperty!, hoverValue!);
        await button.evaluate((element: HTMLButtonElement) => {
          element.disabled = true;
        });
        await page.mouse.move(0, 0);
        const disabled = await appearance();
        await expect(button).toHaveCSS("color", roles[ink!]!);
        await expect(button).toHaveCSS("cursor", "default");
        await button.hover({ force: true });
        expect(await appearance(), `${id} disabled hover`).toEqual(disabled);
        await page.mouse.down();
        try {
          expect(await appearance(), `${id} disabled press`).toEqual(disabled);
        } finally {
          await page.mouse.up();
        }
      }
      for (const [id, minimum] of controls) {
        const button = page.locator(`#${id}`);
        for (const state of ["rest", "hover", "pressed"]) {
          await page.mouse.move(0, 0);
          if (state !== "rest") await button.hover();
          if (state === "pressed") await page.mouse.down();
          try {
            if (id.startsWith("danger-"))
              await expect(button).toHaveCSS("color", roles["error-ink"]!);
            const colors = await renderedColors(button);
            expect(
              colors.contrast,
              `${id} ${state}: ${JSON.stringify(colors)}`,
            ).toBeGreaterThanOrEqual(minimum);
          } finally {
            await page.mouse.up();
          }
        }
        await button.evaluate(
          (element: HTMLButtonElement) => (element.disabled = true),
        );
        await page.mouse.move(0, 0);
        const disabled = await renderedColors(button);
        const decoration = await button.evaluate(
          (element) => getComputedStyle(element).textDecorationLine,
        );
        const filter = await button.evaluate(
          (element) => getComputedStyle(element).filter,
        );
        await button.hover({ force: true });
        await page.mouse.down();
        expect(await renderedColors(button)).toEqual(disabled);
        expect(
          await button.evaluate(
            (element) => getComputedStyle(element).textDecorationLine,
          ),
        ).toBe(decoration);
        expect(
          await button.evaluate((element) => getComputedStyle(element).filter),
        ).toBe(filter);
        await page.mouse.up();
      }
      const compacting = page.locator("#compacting-identity");
      await expect(compacting).toHaveCSS(
        "border-color",
        roles["activity-event"]!,
      );
      await compacting.getByRole("textbox").focus();
      await expect(compacting).toHaveCSS(
        "border-color",
        roles["activity-event"]!,
      );
      await compacting.getByRole("textbox").blur();
      for (const marker of await page.locator("[data-state-mark]").all()) {
        const role = (await marker.getAttribute("data-state-mark"))!;
        await expect(marker).toHaveCSS("color", roles[role]!);
        if (role === "activity-event")
          expect(
            (await renderedColors(marker)).contrast,
          ).toBeGreaterThanOrEqual(3);
      }
      // Theme-owned fallback text must not overwrite explicit terminal colors.
      await expect(page.locator("[data-authored-color]")).toHaveCSS(
        "color",
        "rgb(205, 49, 49)",
      );
      for (const label of await page.locator("[data-role]").all()) {
        const ink = await label.getAttribute("data-ink");
        if (ink) await expect(label).toHaveCSS("color", roles[ink]!);
        const colors = await renderedColors(label);
        const description = await label.evaluate(
          (el) =>
            `${el.closest("section")!.getAttribute("style")} / ${el.getAttribute("data-role")}`,
        );
        expect(
          colors.contrast,
          `${description}: ${JSON.stringify(colors)}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
      for (const button of await page.locator("[data-banner-action]").all()) {
        await button.hover();
        const colors = await renderedColors(button);
        expect(
          colors.contrast,
          `banner hover: ${JSON.stringify(colors)}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
