import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { encodeTerminalServerDataFrame } from "../../shared/terminal-contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import {
  openCommandPalette,
  openFixtureSession,
  openProjectTerminal,
  openWorkspaceFile,
  pairAndOpen,
} from "./support/navigation";
import {
  pasteTerminalText,
  terminalNodeCommand,
  terminalWriteCommand,
} from "./support/terminal-command";
import { terminalOperation } from "./support/terminal-operations";
import {
  observeTerminalSocket,
  terminalCatalog,
  terminalTest as test,
} from "./support/terminal-transport";

test.use({ serviceWorkers: "block" });

async function openFixtureTerminal(page: Page) {
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await openProjectTerminal(page);
}

async function pairWithTerminalOutput(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem(
      "inspire:terminal-ui-settings:v1",
      JSON.stringify({ screenReaderMode: true }),
    );
  });
  await pairAndOpen(page);
}

const activeTerminal = (page: Page) => page.locator(".terminal-view--active");
const terminalOutput = (page: Page) =>
  activeTerminal(page).locator(".xterm-accessibility-tree");
const terminalInput = (page: Page) =>
  activeTerminal(page).locator(".xterm-helper-textarea");
const terminalTab = (page: Page, id: string) =>
  page.locator(`#terminal-tab-${id}`);
async function selectTerminalTab(page: Page, id: string, title: string) {
  const tab = terminalTab(page, id);
  const overflow = page.getByRole("button", { name: "More tabs", exact: true });
  await expect(tab.or(overflow).filter({ visible: true }).first()).toBeVisible();
  if (await tab.isVisible()) await tab.click();
  else {
    await overflow.click();
    await page.getByRole("listbox", { name: "Open tabs" })
      .getByRole("option", { name: title, exact: true }).click();
  }
  await expect(tab).toHaveAttribute("aria-selected", "true");
}
const terminalStatus = (page: Page, name = "Controlling") =>
  page.getByRole("status", { name, exact: true });

async function writeTerminal(input: Locator, value: string) {
  await pasteTerminalText(input, terminalWriteCommand(value));
  await input.press("Enter");
}

async function terminalAction(page: Page, name: string) {
  const menu = page.getByLabel("Terminal actions", { exact: true });
  await menu.click();
  const popover = menu.locator("..");
  const group = name === "Clear local scrollback" || name === "Reset terminal display"
    ? "Display"
    : /^(Move tab|Restart$|Close$|Force terminate$)/u.test(name)
      ? "Manage terminal"
      : null;
  if (group) await popover.locator("summary").getByText(group, { exact: true }).click();
  return popover.getByRole("button", { name, exact: true });
}

test("a replacement terminal snapshot retires output still waiting in xterm's parser", async ({
  page,
  fixtures,
}) => {
  await pairWithTerminalOutput(page);
  const terminal = await fixtures.create();
  const wire = observeTerminalSocket(page, terminal.id);
  await page.evaluate(() => {
    let terminalSocket: WebSocket | undefined;
    const NativeWebSocket = window.WebSocket;
    window.WebSocket = class extends NativeWebSocket {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        if (new URL(String(url)).pathname === "/terminal")
          terminalSocket = this;
      }
    };
    // Deliver a replay boundary before xterm's asynchronous parser can drain
    // the retired output. Network/timer scheduling must not decide this race.
    window.addEventListener("inspire-test-terminal-replay", (event) => {
      if (!terminalSocket) throw new Error("Terminal socket is unavailable");
      for (const frame of (event as CustomEvent<Array<string | number[]>>)
        .detail) {
        terminalSocket.dispatchEvent(
          new MessageEvent("message", {
            data:
              typeof frame === "string" ? frame : Uint8Array.from(frame).buffer,
          }),
        );
      }
    });
  });
  await openFixtureTerminal(page);
  await expect(terminalStatus(page)).toBeVisible();
  const input = terminalInput(page);
  const output = terminalOutput(page);
  await writeTerminal(input, "INITIAL_OUTPUT\r\n");
  await expect(output).toContainText("INITIAL_OUTPUT");
  const attached = wire.attached()!;
  const descriptor = wire.descriptor()!;
  const frame = (kind: "output" | "snapshot", text: string) =>
    Array.from(
      encodeTerminalServerDataFrame(
        kind,
        descriptor.resizeRevision,
        descriptor.nextOutputOffset,
        Buffer.from(text),
      ),
    );
  await page.evaluate(
    (frames) =>
      window.dispatchEvent(
        new CustomEvent("inspire-test-terminal-replay", { detail: frames }),
      ),
    [
      frame("output", "RETIRED_OUTPUT\r\n"),
      JSON.stringify({
        ...attached,
        terminal: descriptor,
        replay: "snapshot",
      }),
      frame("snapshot", "CURRENT_SNAPSHOT"),
      JSON.stringify({
        type: "replay_complete",
        nextOutputOffset: descriptor.nextOutputOffset,
      }),
    ],
  );
  await expect(output).toContainText("CURRENT_SNAPSHOT");
  await expect(output).not.toContainText("RETIRED_OUTPUT");
  await writeTerminal(input, "\r\nLIVE_TAIL");
  await expect(output).toContainText("LIVE_TAIL");
  await expect(terminalStatus(page)).toBeVisible();
});

test("project terminals and a lost create response survive browser reload", {
  tag: ["@cross-browser", "@platform-ui"],
}, async ({ context, page }) => {
  // Real typing, replay, two clients and confirmed
  // serial PTY retirement share this budget; each operation keeps its deadline.
  test.setTimeout(60_000);
  await pairWithTerminalOutput(page);
  await openFixtureTerminal(page);

  const emptyTerminal = page.locator(".terminal-empty");
  await emptyTerminal.getByRole("button", { name: "New terminal" }).click();

  const input = terminalInput(page);
  const output = terminalOutput(page);
  await expect(input).toBeVisible();
  const { terminals } = await terminalCatalog(page);
  const firstId = terminals[0]!.id;
  const terminalIds = [firstId];
  let foreignId: string | undefined;
  const deliveries: boolean[] = [];
  const routePattern = /\/api\/terminal-operations(?:\?observe=1)?$/;
  try {
    const pane = page.locator(".ctx");
    await pane.getByRole("tab", { name: "Files", exact: true }).click();
    await openWorkspaceFile(pane, "README.md");
    await terminalTab(page, firstId).click();
    await expect(terminalStatus(page)).toBeVisible();
    await pane.getByRole("button", { name: "Close README.md", exact: true }).click();

    await writeTerminal(input, "终端✓\n");
    await expect(output).toContainText("终端✓");
    const alternateScreen = terminalNodeCommand(
      "process.stdin.once('data',()=>process.stdout.write('\\x1b[?1049lINSPIRE_NORMAL_SCREEN\\r\\n',()=>process.exit(0)));process.stdout.write('\\x1b[?1049hINSPIRE_ALT_SCREEN\\r\\n')",
    );
    await pasteTerminalText(input, alternateScreen);
    await input.press("Enter");
    await expect(output).toContainText("INSPIRE_ALT_SCREEN");

    await page.route(routePattern, async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        request.postDataJSON()?.intent?.command !== "create"
      )
        return route.continue();
      deliveries.push(new URL(request.url()).searchParams.has("observe"));
      const response = await route.fetch();
      if (deliveries.length === 1 && response.ok()) {
        terminalIds.push((await response.json()).result.id);
        // The daemon committed the create before the browser lost the response.
        return route.abort("failed");
      }
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "New terminal" }).click();
    await expect.poll(() => deliveries).toEqual([false, true]);
    const secondTab = terminalTab(page, terminalIds[1]!);
    // Catalog observation finds the second tab without sending another create.
    await expect(secondTab).toBeVisible({ timeout: 10_000 });
    await secondTab.click();
    await page.reload();
    await expect(page.getByRole("main")).toBeVisible();
    await openFixtureSession(page, /Review extension event lifecycle/);
    const palette = await openCommandPalette(page);
    await palette.getByLabel("Filter commands").fill("Open Terminal");
    await palette.getByRole("option", { name: /^Open Terminal$/ }).click();
    await expect(secondTab).toHaveAttribute("aria-selected", "true");

    const foreignResponse = await terminalOperation(page, {
      command: "create",
      params: {
        request: { cwd: join(browserWorkspace, "tests", "browser") },
      },
    });
    expect(foreignResponse.ok()).toBe(true);
    const { result: foreign } = await foreignResponse.json();
    foreignId = foreign.id;
    await page.getByLabel("Terminal actions", { exact: true }).click();
    await page.getByLabel("Terminals in all projects", { exact: true }).click();
    await page
      .getByRole("searchbox", { name: "Find terminal or project" })
      .fill(foreign.projectCwd);
    await page
      .locator(".terminal-menu__project")
      .filter({
        has: page.getByTitle(foreign.projectCwd, { exact: true }),
      })
      .getByRole("button")
      .click();
    const foreignTab = terminalTab(page, foreign.id);
    await expect(foreignTab).toHaveAttribute("aria-selected", "true");
    await page
      .getByRole("button", { name: "Back to current project" })
      .press("Enter");
    await terminalTab(page, firstId).click();
    await expect(terminalStatus(page)).toBeVisible();
    await expect(output).toContainText("INSPIRE_ALT_SCREEN");
    await input.press("Enter");
    await expect(output).toContainText("INSPIRE_NORMAL_SCREEN");

    const focusedPage = await context.newPage();
    const focusedUrl = new URL(page.url());
    focusedUrl.searchParams.set("terminal", firstId);
    focusedUrl.searchParams.set("terminalFocus", "1");
    await focusedPage.goto(focusedUrl.href);
    await expect(focusedPage.locator(".terminal-pane--focused")).toBeVisible();
    await expect(terminalStatus(focusedPage, "View only")).toBeVisible();
    await focusedPage.keyboard.press("ControlOrMeta+k");
    await focusedPage
      .getByRole("dialog", { name: "Command palette" })
      .getByLabel("Filter commands")
      .fill("take control");
    await focusedPage
      .getByRole("option", { name: /Take control of terminal/ })
      .click();
    await expect(terminalStatus(focusedPage)).toBeVisible();
    await expect(terminalStatus(page, "View only")).toBeVisible();
    await openFixtureSession(page, /Formula rendering and spectral analysis/);
    await expect(terminalTab(focusedPage, firstId)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await focusedPage.close();
  } finally {
    await page.unroute(routePattern);
    for (const terminalId of foreignId
      ? [...terminalIds, foreignId]
      : terminalIds) {
      const response = await terminalOperation(page, {
        command: "remove",
        params: { id: terminalId, force: true },
      });
      expect(response.ok()).toBe(true);
    }
  }
  await expect
    .poll(async () => (await terminalCatalog(page)).terminals)
    .toEqual([]);
});

test("Escape restores the owners of terminal menus in the narrow pane", async ({
  page,
  fixtures,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairAndOpen(page);
  const { profiles: shellProfiles } = await terminalCatalog(page);
  const shell = shellProfiles.find(
    (profile) => profile.available && profile.isDefault,
  )!;
  const defaultLabel = "CalibrationResearchEnvironmentShell";
  const alternative = "光谱校准与测量不确定度分析专用交互环境";
  const profiles = [
    { id: "research", label: defaultLabel, available: true, isDefault: true },
    { id: shell.id, label: alternative, available: true, isDefault: false },
  ];
  await page.route(/\/api\/terminals(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), profiles } });
  });
  await openFixtureTerminal(page);
  const picker = page.getByLabel("Choose terminal profile", { exact: true });
  await page.locator(".terminal-empty").getByRole("button", { name: "New terminal" }).click();
  await expect(picker).toBeFocused();
  const created = page.waitForResponse((response) =>
    response.url().endsWith("/api/terminal-operations") &&
    response.request().method() === "POST" &&
    response.request().postDataJSON()?.intent?.command === "create",
  );
  await page.getByRole("button", { name: alternative }).click();
  fixtures.track((await (await created).json()).result.id);
  await expect(terminalStatus(page)).toBeVisible();
  const actions = page.getByLabel("Terminal actions", { exact: true });
  const projects = page.getByLabel("Terminals in all projects", {
    exact: true,
  });
  const menu = page.locator(".terminal-menu__popover--profiles");
  const current = menu.getByRole("button", {
    name: defaultLabel + " Default",
    exact: true,
  });
  await actions.press("Enter");
  await expect(projects).toBeVisible();
  await picker.press("Enter");
  await expect(projects).toBeHidden();
  await expect(current).toBeVisible();
  await picker.focus();
  await picker.press("Tab");
  await expect(current).toBeFocused();
  await current.press("Escape");
  await expect(menu).toBeHidden();
  await expect(picker).toBeFocused();

  await actions.press("Enter");
  await projects.click();
  const filter = page.getByRole("searchbox", {
    name: "Find terminal or project",
  });
  await filter.press("Escape");
  await expect(filter).toBeHidden();
  await expect(projects).toBeFocused();
  await projects.press("Escape");
  await expect(projects).toBeHidden();
  await expect(actions).toBeFocused();

  await page.keyboard.press("Escape");
  const controls = page.getByRole("button", { name: "Show terminal controls" });
  await expect(controls).toBeFocused();
  await controls.press("Escape");
  await expect(page.getByRole("dialog", { name: "Context panel" })).toHaveCount(0);
});

// Playwright's physical chords cannot produce a character from a foreign
// system layout. Replay the events that layout sends to the real xterm.
function replayLayoutKey(
  input: Locator,
  init: KeyboardEventInit,
  charCode?: number,
) {
  return input.evaluate(
    (element, { init, charCode }) => {
      const down = new KeyboardEvent("keydown", {
        ...init,
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(down);
      if (charCode !== undefined) {
        element.dispatchEvent(
          new KeyboardEvent("keypress", {
            ...init,
            charCode,
            keyCode: charCode,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
      element.dispatchEvent(
        new KeyboardEvent("keyup", { ...init, keyCode: 0, bubbles: true }),
      );
      return down.defaultPrevented;
    },
    { init, charCode },
  );
}

function nativeClipboard(
  input: Locator,
  action: "copy" | "paste",
  mac: boolean,
) {
  return input.evaluate(
    (element, { action, mac }) => {
      const key = action === "copy" ? "c" : "v";
      const accepted = element.dispatchEvent(
        new KeyboardEvent("keydown", {
          key,
          code: "Key" + key.toUpperCase(),
          keyCode: key.toUpperCase().charCodeAt(0),
          bubbles: true,
          cancelable: true,
          ctrlKey: !mac,
          metaKey: mac,
        }),
      );
      // Some browsers strip synthetic ClipboardEvent data on construction.
      let text = action === "paste" ? "PASTED_TEXT" : "";
      const event = new Event(action, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          getData: (type: string) => (type === "text/plain" ? text : ""),
          setData: (type: string, value: string) => {
            if (type === "text/plain") text = value;
          },
        },
      });
      element.dispatchEvent(event);
      return { accepted, text };
    },
    { action, mac },
  );
}

for (const platform of ["Win32", "MacIntel"]) {
  test(`${platform} preserves clipboard and layout input in the terminal`, {
    tag: "@cross-browser",
  }, async ({ page, fixtures }) => {
    const mac = platform === "MacIntel";
    await page.addInitScript((platform) => {
      Object.defineProperty(navigator, "platform", {
        configurable: true,
        value: platform,
      });
    }, platform);
    await pairWithTerminalOutput(page);
    const firstTitle = "Clipboard terminal";
    const firstId = (await fixtures.create(firstTitle)).id;
    const secondId = mac ? undefined : (await fixtures.create()).id;
    const wire = observeTerminalSocket(page, firstId);
    const bytes = () => wire.inputs.join("");
    await openFixtureTerminal(page);
    await selectTerminalTab(page, firstId, firstTitle);
    await expect(terminalStatus(page)).toBeVisible();
    const input = terminalInput(page);
    await input.press("Control+c");
    await expect.poll(bytes).toBe("\u0003");

    await writeTerminal(input, "COPY_ME\r\n");
    const rendered = terminalOutput(page).getByText("COPY_ME", { exact: true });
    await expect(rendered).toBeVisible();
    const box = (await activeTerminal(page)
      .locator(".xterm-screen")
      .boundingBox())!;
    const { cols, rows } = wire.descriptor()!;
    const y = (await rendered.boundingBox())!.y + box.height / rows / 2;
    await page.mouse.move(box.x + 1, y);
    await page.mouse.down();
    await page.mouse.move(box.x + (box.width * 7) / cols, y);
    await page.mouse.up();
    await expect(
      page.getByRole("button", { name: "Copy terminal selection" }),
    ).toBeVisible();
    const beforeCopy = bytes();
    expect(await nativeClipboard(input, "copy", mac)).toEqual({
      text: "COPY_ME",
      accepted: true,
    });
    expect(bytes()).toBe(beforeCopy);
    if (mac) {
      await input.press("Control+c");
      await input.press("Control+v");
      await expect.poll(bytes).toBe(beforeCopy + "\u0003\u0016");
    }
    const beforePaste = bytes();
    expect((await nativeClipboard(input, "paste", mac)).accepted).toBe(true);
    await expect.poll(bytes).toBe(beforePaste + "PASTED_TEXT");

    await input.focus();
    const character = mac ? "|" : "[";
    const initial = bytes();
    expect(
      await replayLayoutKey(
        input,
        {
          key: character,
          code: mac ? "Digit7" : "Digit8",
          keyCode: mac ? 55 : 56,
          altKey: true,
          ctrlKey: !mac,
          modifierAltGraph: !mac,
        },
        character.charCodeAt(0),
      ),
    ).toBe(false);
    await expect.poll(bytes).toBe(initial + character);
    const firstTab = terminalTab(page, firstId);
    await expect(firstTab).toHaveAttribute("aria-selected", "true");

    if (!mac) {
      const create = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/terminal-operations" &&
          response.request().method() === "POST" &&
          response.request().postDataJSON()?.intent?.command === "create",
      );
      await input.press("Control+Shift+Backquote");
      const response = await create;
      expect(response.ok()).toBe(true);
      const { result: created } = await response.json();
      fixtures.track(created.id);
      await expect(terminalTab(page, created.id)).toHaveAttribute("aria-selected", "true");
      await selectTerminalTab(page, firstId, firstTitle);
      await fixtures.remove(created.id);
    }
    const openInteraction = async () => {
      await (await terminalAction(page, "Settings")).click();
      const dialog = page.getByRole("dialog", { name: "Terminal settings" });
      await dialog
        .getByRole("button", { name: "Interaction", exact: true })
        .click();
      return dialog;
    };
    const setShortcutPriority = async (name: "Shell" | "Workbench") => {
      const dialog = await openInteraction();
      await dialog
        .getByRole("group", { name: "Terminal shortcut priority" })
        .getByRole("button", { name, exact: true })
        .click();
      await dialog
        .getByRole("button", { name: "Close terminal settings" })
        .click();
    };
    if (secondId) {
      await setShortcutPriority("Shell");
      expect(
        await replayLayoutKey(firstTab, {
          key: "~",
          code: "Backquote",
          shiftKey: true,
          ctrlKey: true,
        }),
      ).toBe(false);
      expect((await terminalCatalog(page)).terminals.map(({ id }) => id)).toEqual(
        [firstId, secondId],
      );
      await setShortcutPriority("Workbench");

      const beforeTabs = bytes();
      await input.press("Alt+2");
      await expect(terminalTab(page, secondId)).toHaveAttribute(
        "aria-selected",
        "true",
      );
      await input.press("Alt+1");
      await expect(firstTab).toHaveAttribute("aria-selected", "true");
      expect(bytes()).toBe(beforeTabs);
      await page
        .getByRole("button", { name: "Search terminal output" })
        .click();
      const search = page.getByRole("textbox", {
        name: "Search terminal output",
      });
      await search.press("Alt+2");
      await expect(firstTab).toHaveAttribute("aria-selected", "true");
      await expect(search).toBeFocused();
      return;
    }

    await replayLayoutKey(input, {
      key: "Dead",
      code: "KeyE",
      keyCode: 69,
      altKey: true,
    });
    await input.evaluate((element: HTMLTextAreaElement) => {
      element.value = "";
      element.dispatchEvent(
        new CompositionEvent("compositionstart", { bubbles: true }),
      );
      element.value = "é";
      for (const type of ["compositionupdate", "compositionend"])
        element.dispatchEvent(
          new CompositionEvent(type, { data: "é", bubbles: true }),
        );
    });
    await expect.poll(bytes).toBe(initial + "|é");
    await input.press("x");
    await expect.poll(bytes).toBe(initial + "|éx");

    await openInteraction();
    const option = page.getByRole("switch", { name: "Use Option as Meta" });
    await expect(option).not.toBeChecked();
    await option.click();
    await page.getByRole("button", { name: "Close terminal settings" }).click();
    await input.focus();
    await replayLayoutKey(input, {
      key: "¬",
      code: "KeyL",
      keyCode: 76,
      altKey: true,
    });
    await expect.poll(bytes).toBe(initial + "|éx\u001bl");
    await openInteraction();
    await expect(option).toBeChecked();
  });
}

test("terminal search, last output, and asynchronous paste follow the active tab", { tag: "@platform-ui" }, async ({
  context,
  page,
  fixtures,
}) => {
  await pairWithTerminalOutput(page);
  const firstLabel = "Terminal search A";
  const secondLabel = "Terminal search B";
  const firstId = (await fixtures.create(firstLabel)).id;
  const secondId = (await fixtures.create(secondLabel)).id;
  const firstTerminal = observeTerminalSocket(page, firstId);
  const secondTerminal = observeTerminalSocket(page, secondId);
  const selectTab = (id: string) => selectTerminalTab(page, id, id === firstId ? firstLabel : secondLabel);
  await openFixtureTerminal(page);
  await selectTab(firstId);
  await expect(terminalStatus(page)).toBeVisible();
  const input = terminalInput(page);
  const marker = "TERMINAL_REDESIGN_A";
  await writeTerminal(
    input,
    `测量一\r\n测量二\r\n\u001b]6973;C1;fixture\u0007${marker}\r\n\u001b]6973;D;0\u0007`,
  );
  const output = terminalOutput(page);
  await expect(output).toContainText(marker);
  const dimensions = () => {
    const { cols, rows } = firstTerminal.descriptor()!;
    return { cols, rows };
  };
  const beforeSearch = dimensions();
  const searchButton = page.getByRole("button", {
    name: "Search terminal output",
    exact: true,
  });
  await searchButton.click();
  const searchInput = page.getByRole("textbox", {
    name: "Search terminal output",
    exact: true,
  });
  await expect(searchInput).toBeFocused();
  await searchInput.fill(marker);
  await expect(page.locator(".terminal-search__count")).not.toHaveText("0/0");
  expect(dimensions()).toEqual(beforeSearch);
  await selectTab(secondId);
  await expect(searchButton).toHaveAttribute("aria-expanded", "false");
  await searchButton.click();
  await expect(searchInput).toHaveValue("");
  await searchInput.fill("SECOND_VIEW_QUERY");
  // Search owns the floating corner while open; dismiss it before utilities.
  await searchInput.press("Escape");
  await expect(await terminalAction(page, "Copy last output")).toBeDisabled();
  await selectTab(firstId);
  await expect(searchInput).toHaveValue(marker);
  await searchInput.press("Escape");
  await expect(searchInput).toBeHidden();
  // xterm retains the search match as a selection, which owns the tools corner.
  await activeTerminal(page)
    .locator(".xterm-screen")
    .click({ position: { x: 8, y: 8 } });

  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await (await terminalAction(page, "Copy last output")).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(marker);

  // A delayed permission/read result belongs to its original activation,
  // including an A → B → A round trip. A fresh paste reaches the transport.
  await page.evaluate(() => {
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
  const beforePaste = firstTerminal.inputs.length;
  await (await terminalAction(page, "Paste into terminal")).click();
  await selectTab(secondId);
  await selectTab(firstId);
  await deliverPaste("TERMINAL_CLIPBOARD_STALE");
  expect(firstTerminal.inputs.slice(beforePaste)).toEqual([]);
  expect(secondTerminal.inputs).toEqual([]);
  await (await terminalAction(page, "Paste into terminal")).click();
  await deliverPaste("TERMINAL_CLIPBOARD_FRESH");
  await expect
    .poll(() => firstTerminal.inputs.slice(beforePaste))
    .toEqual(["TERMINAL_CLIPBOARD_FRESH"]);
  expect(secondTerminal.inputs).toEqual([]);
  await expect(input).toBeFocused();

  // A height-only resize changes PTY rows while retaining its columns and output.
  const beforeHeight = dimensions();
  await page
    .locator(".terminal-pane")
    .evaluate((element) => (element.style.flex = "0 0 280px"));
  await expect.poll(() => dimensions().rows).toBeLessThan(beforeHeight.rows);
  expect(dimensions().cols).toBe(beforeHeight.cols);
  await expect(output).toContainText(marker);

  await page.setViewportSize({ width: 320, height: 844 });
  await searchButton.click();
  await expect(
    page.getByRole("button", { name: "Close terminal search", exact: true }),
  ).toBeInViewport({ ratio: 1 });
  await searchInput.press("Tab");
  await expect(
    page.getByRole("button", { name: "Match case", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await searchInput.fill("测量");
  const result = page.locator(".terminal-search__count");
  await expect(result).toHaveText("1/2");
  for (const event of [
    { key: "Enter", isComposing: true },
    { key: "Escape", keyCode: 229 },
  ]) {
    await searchInput.dispatchEvent("keydown", event);
    await expect(result).toHaveText("1/2");
  }
  await searchInput.press("Enter");
  await expect(result).toHaveText("2/2");
  await searchInput.press("Escape");
  await expect(searchInput).toBeHidden();
  await expect(input).toBeFocused();

  const selected = terminalTab(page, firstId);
  const draft = "UNFINISHED_TERMINAL_LINE";
  await input.pressSequentially(draft);
  const files = page.getByRole("tab", { name: "Files", exact: true });
  await files.click();
  await expect(input).toBeHidden();
  await selectTab(firstId);
  await expect(output).toContainText(draft);
  await input.press(process.platform === "win32" ? "Escape" : "Control+u");
  await input.pressSequentially(
    terminalNodeCommand(
      "process.stdout.write(String.fromCharCode(27)+']6973;C1;busy'+String.fromCharCode(7));console.log('Busy proces'+'s');setInterval(()=>{},1000)",
    ),
  );
  await input.press("Enter");
  await expect(output).toContainText("Busy process");
  await expect
    .poll(
      async () =>
        (await terminalCatalog(page)).terminals.find(({ id }) => id === firstId)
          ?.commandRunning,
    )
    .toBe(true);
  const refresh = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/terminals",
  );
  await page.getByRole("button", { name: "Refresh context pane" }).click();
  await refresh;
  await expect(terminalStatus(page)).toBeVisible();
  const close = selected.locator("..").getByRole("button", { name: /^Close / });
  let confirmation: string | undefined;
  page.once("dialog", async (dialog) => {
    confirmation = dialog.message();
    await dialog.dismiss();
  });
  await close.click();
  expect(confirmation).toMatch(/and terminate its running process/);
  await expect(selected).toHaveAttribute("aria-selected", "true");
  await expect(terminalStatus(page)).toBeVisible();
});

test.describe("touch terminal", () => {
  test.use({
    hasTouch: true,
    isMobile: true,
    viewport: { width: 390, height: 844 },
  });

  test("uses touch keys, copies native text and quotes the selection in the phone draft", async ({
    context,
    page,
    fixtures,
  }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairAndOpen(page);
    const composer = page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill("Existing question");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const title = "Touch input terminal";
    const { id } = await fixtures.create(title);
    const { inputs } = observeTerminalSocket(page, id);
    await openFixtureTerminal(page);
    await selectTerminalTab(page, id, title);
    await expect(terminalStatus(page)).toBeVisible();
    const input = terminalInput(page);
    const keys = page.getByRole("group", {
      name: "Terminal keys",
      exact: true,
    });
    const ctrl = keys.getByRole("button", { name: "Ctrl", exact: true });
    const scroll = keys.locator(".terminal-touch-keys__scroller");
    await page.setViewportSize({ width: 320, height: 844 });
    const arrowUp = keys.getByRole("button", { name: "Arrow up", exact: true });
    const pageDown = keys.getByRole("button", { name: "PgDn", exact: true });
    await expect(page.getByRole("dialog", { name: "Context panel" })).toBeVisible();
    await pageDown.tap({ trial: true });
    await scroll.evaluate((node) => {
      node.scrollLeft = 0;
    });
    await input.evaluate((node) => node.blur());
    await arrowUp.tap();
    await expect.poll(() => inputs.at(-1)).toMatch(/^\x1b(?:\[|O)A$/u);
    await expect(input).not.toBeFocused();
    await page.getByRole("button", { name: "Focus terminal input" }).tap();
    await expect(input).toBeFocused();
    await ctrl.tap();
    await expect(ctrl).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.insertText("a");
    await expect.poll(() => inputs.at(-1)).toBe("\u0001");
    await expect(ctrl).toHaveAttribute("aria-pressed", "false");

    // A native paste is literal even if a touch modifier was waiting.
    await page.evaluate(() => navigator.clipboard.writeText("c"));
    await ctrl.tap();
    await page.keyboard.press("ControlOrMeta+v");
    await expect
      .poll(() => inputs.at(-1))
      .toMatch(/^(?:\u001b\[200~)?c(?:\u001b\[201~)?$/u);
    await expect(ctrl).toHaveAttribute("aria-pressed", "false");
    await input.evaluate((element) => element.blur());
    await keys.getByRole("button", { name: "Ctrl+C", exact: true }).tap();
    await expect.poll(() => inputs.at(-1)).toBe("\u0003");
    await page.getByRole("button", { name: "Focus terminal input" }).tap();

    // Clear pending input with the shell's own editing key.
    await input.press(process.platform === "win32" ? "Escape" : "Control+u");
    await page.keyboard.insertText(terminalWriteCommand("TOUCH_COPY_中文\n"));
    await input.press("Enter");
    const more = page.getByLabel("Terminal actions", { exact: true });
    const selectText = async () => {
      await more.tap();
      await page
        .getByRole("button", { name: "Select text", exact: true })
        .tap();
    };
    const dialog = page.getByRole("dialog", {
      name: "Select terminal text",
    });
    const text = dialog.getByRole("textbox", {
      name: "Terminal output",
      exact: true,
    });
    // The inspector freezes its snapshot on open, so wait for the shell's
    // marker by reopening it if the real PTY has not rendered the output yet.
    await expect(async () => {
      await selectText();
      const snapshot = await text.inputValue();
      if (!snapshot.includes("TOUCH_COPY_中文")) await text.press("Escape");
      expect(snapshot).toContain("TOUCH_COPY_中文");
    }).toPass({ timeout: 5_000 });
    await expect(text).toBeFocused();
    await expect(text).toHaveAttribute("readonly", "");
    await expect(text).toHaveAttribute("inputmode", "none");
    const selectMarker = () =>
      text.evaluate((element: HTMLTextAreaElement) => {
        const marker = "TOUCH_COPY_中文";
        const start = element.value.lastIndexOf(marker);
        element.setSelectionRange(start, start + marker.length);
      });
    await selectMarker();
    const copySelection = dialog.getByRole("button", {
      name: "Copy selection",
      exact: true,
    });
    // A height change clears xterm's canvas selection, but keeps the dialog selection.
    await page.setViewportSize({ width: 390, height: 500 });
    await copySelection.tap();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("TOUCH_COPY_中文");
    await page.setViewportSize({ width: 700, height: 390 });
    await expect(copySelection).toBeInViewport();
    const accessibility = await new AxeBuilder({ page })
      .include(".terminal-text-dialog")
      .analyze();
    expect(accessibility.violations).toEqual([]);
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
      await text.evaluate((element: HTMLTextAreaElement) =>
        element.value.slice(element.selectionStart, element.selectionEnd),
      ),
    ).toBe("TOUCH_COPY_中文");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".ctx")).toBeVisible();
    await expect(input).not.toBeFocused();

    const beforePageDown = inputs.length;
    await pageDown.tap();
    await expect
      .poll(() => inputs.slice(beforePageDown).join(""))
      .toBe("\u001b[6~");
    let sentPrompt = false;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname === "/api/prompt"
      )
        sentPrompt = true;
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await selectText();
    await selectMarker();
    await dialog
      .getByRole("button", { name: "Send terminal selection to composer" })
      .tap();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator(".ctx")).toHaveCount(0);
    await expect(composer).toBeFocused();
    await expect(composer).toHaveValue(
      "Existing question\n\n```text\nTOUCH_COPY_中文\n```",
    );
    await page.keyboard.insertText(" Follow-up");
    await expect(composer).toHaveValue(/Follow-up/);
    expect(sentPrompt).toBe(false);
  });
});
