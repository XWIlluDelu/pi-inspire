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
      "workbench",
      "terminal",
      "settings-overlays",
      "model-settings",
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
            <div class="composer__failed-delivery"><button id="restore-action">Restore</button></div>
          </section>
          <section aria-label="Icon button states">
            <button class="icon-button" id="icon" aria-label="Add files">+</button>
            <button class="icon-button icon-button--active" id="icon-selected" aria-label="Resources" aria-expanded="true">▤</button>
            <button class="icon-button pending-group__control pending-group__control--clear" id="icon-clear" aria-label="Clear pending input">×</button>
            <button class="models-icon-button" id="icon-model" aria-label="Move model up">↑</button>
            <div class="file-detail-header"><button class="icon-button" id="icon-file" aria-label="File action">↗</button></div>
            <div class="composer__input-wrap" style="width:36px;height:36px;flex:none"><button class="icon-button composer__expand" id="icon-expand" aria-label="Expand composer">↗</button></div>
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
          <section style="background:var(--bg-raised)">
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

      const pagination = page.locator("#focus-pagination");
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
        ["restore-action", "ink", "cursor", "pointer"],
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
      for (const label of await page.locator("[data-role]").all()) {
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
