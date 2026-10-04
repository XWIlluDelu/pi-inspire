import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  decodeTerminalInputFrame,
  decodeTerminalServerDataFrame,
} from "../../shared/terminal-contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { openMockSession, pairedPage } from "./support/navigation";

test("project terminals survive browser detach and keep multiple tabs", async ({
  context,
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.evaluate(() => {
    window.localStorage.setItem(
      "inspire:terminal-ui-settings:v1",
      JSON.stringify({ screenReaderMode: true }),
    );
  });
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();

  const emptyTerminal = page.locator(".terminal-empty");
  await emptyTerminal.getByRole("button", { name: "New terminal" }).click();
  const readTerminals = async () => {
    const response = await page.request.get(
      `/api/terminals?cwd=${encodeURIComponent(browserWorkspace)}`,
    );
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{
      terminals: Array<{ id: string; nextOutputOffset: number }>;
    }>;
  };
  const terminalInput = page.locator(".xterm-helper-textarea");
  await expect(terminalInput).toBeVisible();
  const firstCatalog = await readTerminals();
  const firstTerminal = firstCatalog.terminals[0]!;
  let terminalIds = [firstTerminal.id];
  try {
    await terminalInput.pressSequentially("printf 'INSPIRE_TERMINAL_E2E\\n'");
    await terminalInput.press("Enter");
    await expect
      .poll(async () => (await readTerminals()).terminals[0]!.nextOutputOffset)
      .toBeGreaterThan(firstTerminal.nextOutputOffset);
    const visibleTerminalOutput = page.locator(
      ".terminal-views__item:not([hidden]) .xterm-accessibility-tree",
    );
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    await page.evaluate(async () => {
      await navigator.clipboard.writeText("printf '终端✓\\n'");
    });
    await page.getByLabel("Terminal actions", { exact: true }).click();
    await page.getByRole("button", { name: "Paste into terminal" }).click();
    await expect(
      page.locator(".terminal-pane details[data-terminal-menu][open]"),
    ).toHaveCount(0);
    await expect(terminalInput).toBeFocused();
    await terminalInput.press("Enter");
    await expect(visibleTerminalOutput).toContainText("终端✓");
    await terminalInput.pressSequentially(
      "printf '\\033[?1049hINSPIRE_ALT_SCREEN'",
    );
    await terminalInput.press("Enter");
    await expect(visibleTerminalOutput).toContainText("INSPIRE_ALT_SCREEN");

    await page.getByRole("button", { name: "New terminal" }).click();
    await expect(page.locator(".terminal-tab__select")).toHaveCount(2);
    terminalIds = (await readTerminals()).terminals.map(({ id }) => id);
    const terminalAccessibility = await new AxeBuilder({ page })
      .include(".terminal-pane")
      .analyze();
    expect(terminalAccessibility.violations).toEqual([]);

    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await openMockSession(page, /Review extension event lifecycle/);
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await expect(page.locator(".terminal-tab__select")).toHaveCount(2);
    expect((await readTerminals()).terminals.map(({ id }) => id)).toEqual(
      terminalIds,
    );

    await page.locator(`#terminal-tab-${terminalIds[0]}`).click();
    await expect(
      page.getByRole("status", { name: "Controlling", exact: true }),
    ).toBeVisible();
    const restoredInput = page.locator(
      ".terminal-views__item:not([hidden]) .xterm-helper-textarea",
    );
    await expect(
      page.locator(
        ".terminal-views__item:not([hidden]) .xterm-accessibility-tree",
      ),
    ).toContainText("INSPIRE_ALT_SCREEN");
    await restoredInput.pressSequentially("printf '\\033[?1049l'");
    await restoredInput.press("Enter");

    const focusedPage = await context.newPage();
    const focusedUrl = new URL(page.url());
    focusedUrl.searchParams.set("terminal", terminalIds[0]!);
    focusedUrl.searchParams.set("terminalFocus", "1");
    await focusedPage.goto(focusedUrl.href);
    await expect(focusedPage.locator(".terminal-pane--focused")).toBeVisible();
    await expect(
      focusedPage.getByRole("status", { name: "View only", exact: true }),
    ).toBeVisible();
    await focusedPage.keyboard.press("Control+k");
    await focusedPage
      .getByRole("dialog", { name: "Command palette" })
      .getByLabel("Filter commands")
      .fill("take control");
    await focusedPage
      .getByRole("option", { name: /Take control of terminal/ })
      .click();
    await expect(
      focusedPage.getByRole("status", { name: "Controlling", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("status", { name: "View only", exact: true }),
    ).toBeVisible();
    await openMockSession(page, /Formula rendering and spectral analysis/);
    await expect(focusedPage.locator(".terminal-pane--focused")).toBeVisible();
    await expect(
      focusedPage.locator(`#terminal-tab-${terminalIds[0]}`),
    ).toHaveAttribute("aria-pressed", "true");
    await focusedPage.close();
  } finally {
    for (const terminalId of terminalIds) {
      const response = await page.request.delete(
        `/api/terminals/${encodeURIComponent(terminalId)}?force=1`,
      );
      expect(response.ok()).toBe(true);
    }
  }
  await expect.poll(async () => (await readTerminals()).terminals).toEqual([]);
});

test("terminal menus share alignment, mutual exclusion, and nested Escape ownership", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  const created = await page.request.post("/api/terminals", {
    data: { cwd: browserWorkspace },
  });
  expect(created.ok()).toBe(true);
  const terminal = (await created.json()) as { id: string };
  try {
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (!(await page.locator(".ctx").count()))
        await page
          .getByRole("button", { name: "Toggle resources panel" })
          .click();
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await expect(
        page.locator(".xterm-helper-textarea").first(),
      ).toBeVisible();

      const centers = await page
        .locator(
          ".terminal-tabs__new > .icon-button, .terminal-tabs-shell .terminal-menu > summary, .terminal-view-controls > .icon-button, .terminal-tabs__focus",
        )
        .evaluateAll((controls) =>
          controls.map((control) => {
            const icon = control.querySelector("svg")!.getBoundingClientRect();
            return icon.top + icon.height / 2;
          }),
        );
      expect(centers.length).toBeGreaterThanOrEqual(4);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(
        0.5,
      );
      await page.locator(".terminal-tabs-shell").screenshot({
        path: `output/playwright/terminal-toolbar-${width}.png`,
      });

      const actions = page.getByLabel("Terminal actions", { exact: true });
      const profiles = page.getByLabel("Choose terminal profile", {
        exact: true,
      });
      const openMenus = page.locator(
        ".terminal-pane details[data-terminal-menu][open]",
      );
      await actions.focus();
      await actions.press("Enter");
      await expect(openMenus).toHaveCount(1);
      // Profile discovery is platform-specific; exercise mutual exclusion when
      // this Host exposes more than one profile, without inventing a shell.
      if (await profiles.count()) {
        await profiles.focus();
        await profiles.press("Enter");
        await expect(openMenus).toHaveCount(1);
        await expect(profiles.locator("..")).toHaveAttribute("open", "");
        await actions.focus();
        await actions.press("Enter");
      }
      const projects = page.getByLabel("Terminals in all projects", {
        exact: true,
      });
      await projects.click();
      const filter = page.getByRole("textbox", {
        name: "Find terminal or project",
      });
      await filter.fill("NO_SUCH_TERMINAL");
      await expect(
        page.getByText("No matching terminals", { exact: true }),
      ).toBeVisible();
      await filter.press("Escape");
      await expect(projects.locator("..")).not.toHaveAttribute("open");
      await expect(projects).toBeFocused();
      await expect(openMenus).toHaveCount(1);
      await projects.press("Escape");
      await expect(openMenus).toHaveCount(0);
      await expect(actions).toBeFocused();
      await expect(page.locator(".ctx")).toBeVisible();

      await actions.press("Enter");
      await page.getByRole("button", { name: "Rename", exact: true }).focus();
      await page.keyboard.press("Escape");
      await expect(openMenus).toHaveCount(0);
      await expect(actions).toBeFocused();

      for (const shortcut of ["Control+Shift+Escape", "Meta+Shift+Escape"]) {
        await page
          .getByRole("button", { name: "Focus terminal", exact: true })
          .click();
        await expect(page.locator(".terminal-pane--focused")).toBeVisible();
        await page.locator(".xterm-helper-textarea").first().focus();
        await page.keyboard.press(shortcut);
        await expect(page.locator(".terminal-pane--focused")).toHaveCount(0);
        await expect(page.locator(".ctx")).toBeVisible();
      }
      if (width === 390) {
        await actions.focus();
        await actions.press("Escape");
        await expect(page.locator(".ctx")).toHaveCount(0);
      }
    }
  } finally {
    await page.request.delete(
      `/api/terminals/${encodeURIComponent(terminal.id)}?force=1`,
    );
  }
});

test("compact terminal controls keep selection, search, and output scoped to the active view", async ({
  context,
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.evaluate(() =>
    localStorage.setItem(
      "inspire:terminal-ui-settings:v1",
      JSON.stringify({ screenReaderMode: true }),
    ),
  );
  const ids: string[] = [];
  const prompts: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/prompt"
    )
      prompts.push(request.url());
  });
  try {
    for (let index = 0; index < 2; index += 1) {
      const response = await page.request.post("/api/terminals", {
        data: { cwd: browserWorkspace },
      });
      expect(response.ok()).toBe(true);
      ids.push(((await response.json()) as { id: string }).id);
    }
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
    await page.getByRole("button", { name: "Terminal", exact: true }).click();
    await page.locator(`#terminal-tab-${ids[0]}`).click();
    await expect(
      page.getByRole("status", { name: "Controlling", exact: true }),
    ).toBeVisible();
    const activeView = page.locator(".terminal-views__item:not([hidden])");
    const input = activeView.locator(".xterm-helper-textarea");
    // The mock Host intentionally skips user shell integration. Exercise its
    // real PTY stream with explicit advisory command/output boundaries.
    await input.pressSequentially(
      "printf '\\033]6973;C1;fixture\\007TERMINAL_REDESIGN_A\\n\\033]6973;D;0\\007'",
    );
    await input.press("Enter");
    await expect(activeView.locator(".xterm-accessibility-tree")).toContainText(
      "TERMINAL_REDESIGN_A",
    );
    await input.evaluate((element) =>
      element.setAttribute("data-continuity", "retained"),
    );
    const dimensions = async () => {
      const response = await page.request.get(
        `/api/terminals?cwd=${encodeURIComponent(browserWorkspace)}`,
      );
      const catalog = (await response.json()) as {
        terminals: Array<{ id: string; cols: number; rows: number }>;
      };
      const terminal = catalog.terminals.find(({ id }) => id === ids[0])!;
      return { cols: terminal.cols, rows: terminal.rows };
    };
    const beforeSearch = await dimensions();
    const searchButton = page.getByRole("button", {
      name: "Search terminal output",
      exact: true,
    });
    await expect(searchButton).toHaveCount(1);
    await searchButton.click();
    const searchInput = page.getByRole("textbox", {
      name: "Search terminal output",
      exact: true,
    });
    await expect(searchInput).toBeFocused();
    await searchInput.fill("TERMINAL_REDESIGN_A");
    await expect(page.locator(".terminal-search__count")).not.toHaveText("0/0");
    expect(await dimensions()).toEqual(beforeSearch);
    await page.locator(`#terminal-tab-${ids[1]}`).click();
    await expect(searchButton).toHaveCount(1);
    await expect(searchButton).toHaveAttribute("aria-expanded", "false");
    await searchButton.click();
    await expect(searchInput).toHaveValue("");
    await searchInput.fill("SECOND_VIEW_QUERY");
    await page.getByLabel("Terminal actions", { exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Copy last output", exact: true }),
    ).toBeDisabled();
    await page.locator(`#terminal-tab-${ids[0]}`).click();
    await expect(searchInput).toHaveValue("TERMINAL_REDESIGN_A");
    await expect(input).toHaveAttribute("data-continuity", "retained");
    await page.getByRole("button", { name: "Close terminal search" }).click();

    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(page.url()).origin,
    });
    const more = page.getByLabel("Terminal actions", { exact: true });
    await more.click();
    const copyOutput = page.getByRole("button", {
      name: "Copy last output",
      exact: true,
    });
    await expect(copyOutput).toBeEnabled();
    await copyOutput.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("TERMINAL_REDESIGN_A");
    await more.click();
    await page.getByRole("button", { name: "Copy all", exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("TERMINAL_REDESIGN_A");
    await more.click();
    await page
      .getByRole("button", { name: "Select text", exact: true })
      .click();
    const textDialog = page.getByRole("dialog", {
      name: "Select terminal text",
    });
    const textOutput = textDialog.getByRole("textbox", {
      name: "Terminal output",
    });
    await expect(page.locator("details[data-terminal-menu][open]")).toHaveCount(
      0,
    );
    await expect(textOutput).toBeFocused();
    await expect(textOutput).toHaveAttribute("readonly", "");
    expect(await dimensions()).toEqual(beforeSearch);
    await textOutput.press("Control+a");
    await textDialog
      .getByRole("button", { name: "Copy selection", exact: true })
      .click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toContain("TERMINAL_REDESIGN_A");
    await page
      .getByRole("button", {
        name: "Send terminal selection to composer",
        exact: true,
      })
      .click();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveValue(/```text[\s\S]*TERMINAL_REDESIGN_A/);
    expect(prompts).toEqual([]);

    // A delayed permission/read result belongs to its original activation,
    // including an A → B → A round trip. A fresh paste still reaches the PTY.
    await page.evaluate(() => {
      document.documentElement.dataset.testPasteSends = "";
      const send = WebSocket.prototype.send;
      WebSocket.prototype.send = function (data) {
        const text =
          typeof data === "string"
            ? data
            : data instanceof Blob
              ? ""
              : new TextDecoder().decode(data);
        if (text.includes("TERMINAL_CLIPBOARD_"))
          document.documentElement.dataset.testPasteSends += text;
        return send.call(this, data);
      };
      Object.defineProperty(navigator.clipboard, "readText", {
        configurable: true,
        value: () =>
          new Promise<string>((resolve) => {
            document.addEventListener(
              "test-terminal-paste",
              (event) => resolve((event as CustomEvent<string>).detail),
              { once: true },
            );
          }),
      });
    });
    const deliverPaste = (value: string) =>
      page.evaluate(async (text) => {
        document.dispatchEvent(
          new CustomEvent("test-terminal-paste", { detail: text }),
        );
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve()),
        );
      }, value);
    await more.click();
    await page
      .getByRole("button", { name: "Paste into terminal", exact: true })
      .click();
    await page.locator(`#terminal-tab-${ids[1]}`).click();
    await page.locator(`#terminal-tab-${ids[0]}`).click();
    await deliverPaste("TERMINAL_CLIPBOARD_STALE");
    await expect(page.locator("html")).toHaveAttribute(
      "data-test-paste-sends",
      "",
    );
    await more.click();
    await page
      .getByRole("button", { name: "Paste into terminal", exact: true })
      .click();
    await deliverPaste("TERMINAL_CLIPBOARD_FRESH");
    await expect(page.locator("html")).toHaveAttribute(
      "data-test-paste-sends",
      /TERMINAL_CLIPBOARD_FRESH/,
    );
    await expect(input).toBeFocused();
    await input.press("Control+u");
    await page.evaluate(() =>
      Reflect.deleteProperty(navigator.clipboard, "readText"),
    );

    const accessibility = await new AxeBuilder({ page })
      .include(".terminal-pane")
      .analyze();
    expect(accessibility.violations).toEqual([]);
    // Height-only changes preserve output; a short panel also scrolls its menu.
    await page
      .locator(".terminal-pane")
      .evaluate((element) => (element.style.flex = "0 0 280px"));
    await more.click();
    await expect(copyOutput).toBeEnabled();
    await copyOutput.click();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("TERMINAL_REDESIGN_A");
    await more.click();
    await page
      .locator(".terminal-pane")
      .getByRole("button", { name: "Settings", exact: true })
      .scrollIntoViewIfNeeded();
    const paneBounds = await page.locator(".terminal-pane").boundingBox();
    const menuBounds = await page
      .locator(".terminal-menu--more > .terminal-menu__popover")
      .boundingBox();
    expect(menuBounds!.y + menuBounds!.height).toBeLessThanOrEqual(
      paneBounds!.y + paneBounds!.height,
    );
    await page
      .locator(".terminal-pane")
      .screenshot({ path: "output/playwright/terminal-compact-menu.png" });
    await more.click();
    await page
      .locator(".terminal-pane")
      .evaluate((element) => element.style.removeProperty("flex"));

    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (!(await page.locator(".ctx").count()))
        await page
          .getByRole("button", { name: "Toggle resources panel" })
          .click();
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      const visibleInput = page.locator(
        ".terminal-views__item:not([hidden]) .xterm-helper-textarea",
      );
      await searchButton.click();
      await expect(searchInput).toBeFocused();
      await searchInput.fill("TERMINAL_REDESIGN_A");
      await searchInput.press("Escape");
      await expect(searchInput).toHaveCount(0);
      await expect(page.locator(".ctx")).toBeVisible();
      await expect(visibleInput).toBeFocused();
      for (const theme of ["light", "dark"]) {
        await page.evaluate(
          (value) => (document.documentElement.dataset.theme = value),
          theme,
        );
        await page.locator(".terminal-pane").screenshot({
          path: `output/playwright/terminal-compact-${width}-${theme}.png`,
        });
        const themedAccessibility = await new AxeBuilder({ page })
          .include(".terminal-pane")
          .analyze();
        expect(themedAccessibility.violations).toEqual([]);
      }
      const overflow = await page
        .locator(".terminal-tabs-shell")
        .evaluate((element) => element.scrollWidth - element.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    }
  } finally {
    for (const id of ids)
      await page.request.delete(
        `/api/terminals/${encodeURIComponent(id)}?force=1`,
      );
  }
});

test.describe("touch terminal", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("keeps touch keys in the input flow and offers stable native text selection", async ({
    context,
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    const inputs: string[] = [];
    let output = "";
    page.on("websocket", (socket) => {
      if (new URL(socket.url()).pathname !== "/terminal") return;
      socket.on("framesent", ({ payload }) => {
        if (typeof payload !== "string")
          inputs.push(
            new TextDecoder().decode(decodeTerminalInputFrame(payload).data),
          );
      });
      const decoder = new TextDecoder();
      socket.on("framereceived", ({ payload }) => {
        if (typeof payload !== "string")
          output += decoder.decode(
            decodeTerminalServerDataFrame(payload).data,
            { stream: true },
          );
      });
    });
    await pairedPage(page);
    await page.getByRole("button", { name: "Toggle navigation" }).tap();
    await openMockSession(page, /Review extension event lifecycle/);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const response = await page.request.post("/api/terminals", {
      data: { cwd: browserWorkspace },
    });
    expect(response.ok()).toBe(true);
    const terminal = (await response.json()) as { id: string };
    try {
      await page.getByRole("button", { name: "Toggle resources panel" }).tap();
      await page.getByRole("button", { name: "Terminal", exact: true }).tap();
      await expect(
        page.getByRole("status", { name: "Controlling", exact: true }),
      ).toBeVisible();
      const input = page.locator(
        ".terminal-view--active .xterm-helper-textarea",
      );
      const keys = page.getByRole("group", {
        name: "Terminal keys",
        exact: true,
      });
      const ctrl = keys.getByRole("button", { name: "Ctrl", exact: true });
      await page.getByRole("button", { name: "Focus terminal input" }).tap();
      await expect(input).toBeFocused();
      await ctrl.tap();
      await expect(ctrl).toHaveAttribute("aria-pressed", "true");
      await expect(input).toBeFocused();
      await page.keyboard.insertText("a");
      await expect.poll(() => inputs.at(-1)).toBe("\u0001");
      await expect(ctrl).toHaveAttribute("aria-pressed", "false");

      // A native paste is literal even if a touch modifier was waiting.
      await page.evaluate(() => navigator.clipboard.writeText("c"));
      await ctrl.tap();
      await page.keyboard.press("Control+v");
      await expect
        .poll(() => inputs.at(-1))
        .toMatch(/^(?:\u001b\[200~)?c(?:\u001b\[201~)?$/u);
      await expect(ctrl).toHaveAttribute("aria-pressed", "false");
      await input.press("Control+u");
      await ctrl.tap();
      await keys.getByRole("button", { name: "Arrow up", exact: true }).tap();
      await expect.poll(() => inputs.at(-1)).toBe("\u001b[1;5A");
      await expect(input).toBeFocused();
      await expect(ctrl).toHaveAttribute("aria-pressed", "false");

      await input.evaluate((element) => element.blur());
      await keys.getByRole("button", { name: "Ctrl+C", exact: true }).tap();
      await expect.poll(() => inputs.at(-1)).toBe("\u0003");
      await expect(input).not.toBeFocused();
      await keys.getByRole("button", { name: "Arrow down", exact: true }).tap();
      await expect(input).not.toBeFocused();
      await ctrl.tap();
      await page.getByRole("button", { name: "Focus terminal input" }).tap();
      await expect(ctrl).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.insertText("u");
      await expect.poll(() => inputs.at(-1)).toBe("\u0015");

      await page.keyboard.insertText("printf 'TOUCH\\137COPY_中文\\n'");
      await input.press("Enter");
      await expect.poll(() => output).toContain("TOUCH_COPY_中文");
      const more = page.getByLabel("Terminal actions", { exact: true });
      await more.tap();
      await expect(
        page.getByRole("button", { name: "Copy last output", exact: true }),
      ).toBeDisabled();
      await page.getByRole("button", { name: "Copy all", exact: true }).tap();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain("TOUCH_COPY_中文");
      await more.tap();
      await page
        .getByRole("button", { name: "Select text", exact: true })
        .tap();
      const dialog = page.getByRole("dialog", { name: "Select terminal text" });
      const text = dialog.getByRole("textbox", {
        name: "Terminal output",
        exact: true,
      });
      await expect(text).toBeFocused();
      await expect(text).toHaveAttribute("readonly", "");
      await expect(text).toHaveAttribute("inputmode", "none");
      const snapshot = await text.inputValue();
      await text.evaluate((element: HTMLTextAreaElement) => {
        const start = element.value.lastIndexOf("TOUCH_COPY_中文");
        element.setSelectionRange(start, start + "TOUCH_COPY_中文".length);
      });
      const copySelection = dialog.getByRole("button", {
        name: "Copy selection",
        exact: true,
      });
      await expect(copySelection).toBeVisible();
      // The native selection survives the height change that clears xterm's
      // canvas selection. Incoming reflow does not replace the captured text.
      await page.setViewportSize({ width: 390, height: 500 });
      await expect(text).toHaveValue(snapshot);
      await copySelection.tap();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toBe("TOUCH_COPY_中文");
      await dialog
        .getByRole("button", { name: "Select all", exact: true })
        .tap();
      await expect
        .poll(() =>
          text.evaluate(
            (element: HTMLTextAreaElement) =>
              element.selectionEnd - element.selectionStart,
          ),
        )
        .toBe(snapshot.length);

      for (const [width, height] of [
        [320, 740],
        [700, 390],
      ]) {
        await page.setViewportSize({ width, height });
        const safeInset = width > height ? 36 : 0;
        await page.evaluate((value) => {
          document.documentElement.style.setProperty(
            "--safe-left",
            `${value}px`,
          );
          document.documentElement.style.setProperty(
            "--safe-right",
            `${value}px`,
          );
        }, safeInset);
        for (const theme of ["light", "dark"]) {
          await page.evaluate((value) => {
            document.documentElement.dataset.theme = value;
            document.documentElement.dataset.palette =
              value === "dark" ? "teal" : "amber";
          }, theme);
          await expect(dialog).toBeVisible();
          const bounds = await dialog.boundingBox();
          expect(bounds!.x).toBeGreaterThanOrEqual(safeInset);
          expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(
            width - safeInset,
          );
          expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(height);
          expect(
            await dialog.evaluate(
              (element) => element.scrollWidth - element.clientWidth,
            ),
          ).toBeLessThanOrEqual(1);
          await page.screenshot({
            path: `output/playwright/terminal-text-${width}-${theme}.png`,
          });
          const accessibility = await new AxeBuilder({ page })
            .include(".terminal-text-dialog")
            .analyze();
          expect(accessibility.violations).toEqual([]);
        }
      }
      await page.evaluate(() =>
        Object.defineProperty(navigator.clipboard, "writeText", {
          configurable: true,
          value: () => Promise.reject(new Error("Clipboard permission denied")),
        }),
      );
      await dialog.getByRole("button", { name: /^Cop/ }).tap();
      await expect(dialog.getByRole("alert")).toContainText(
        "Clipboard permission denied",
      );
      await expect(text).toBeFocused();
      expect(
        await text.evaluate(
          (element: HTMLTextAreaElement) =>
            element.selectionEnd - element.selectionStart,
        ),
      ).toBe(snapshot.length);
      await page.keyboard.press("Escape");
      await expect(dialog).toHaveCount(0);
      await expect(page.locator(".ctx")).toBeVisible();
      await expect(input).not.toBeFocused();
    } finally {
      await page.request.delete(
        `/api/terminals/${encodeURIComponent(terminal.id)}?force=1`,
      );
    }
  });
});
