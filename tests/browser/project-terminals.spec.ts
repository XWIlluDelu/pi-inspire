import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page } from "@playwright/test";
import { encodeTerminalServerDataFrame } from "../../shared/terminal-contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { renderedColors } from "./support/colors";
import { focusRingClipping } from "./support/focus-bounds";
import {
  openCommandPalette,
  openFixtureSession,
  openProjectTerminal,
  pairAndOpen,
} from "./support/navigation";
import {
  terminalNodeCommand,
  terminalWriteCommand,
} from "./support/terminal-command";
import { terminalOperation } from "./support/terminal-operations";
import {
  observeTerminalSocket,
  terminalCatalog,
  terminalTest as test,
} from "./support/terminal-transport";
import { textOverflowsInlineBounds } from "./support/text-bounds";

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
const terminalStatus = (page: Page, name = "Controlling") =>
  page.getByRole("status", { name, exact: true });

async function writeTerminal(input: Locator, value: string) {
  await input.pressSequentially(terminalWriteCommand(value));
  await input.press("Enter");
}

async function terminalAction(page: Page, name: string) {
  const menu = page.getByLabel("Terminal actions", { exact: true });
  await menu.click();
  return menu.locator("..").getByRole("button", { name, exact: true });
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

for (const source of ["catalog", "connection"] as const) {
  test(`long terminal ${source} errors stay within the pane and can be dismissed`, {
    tag: "@platform-ui",
  }, async ({ page, context, fixtures }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairAndOpen(page);
    if (source === "connection") await fixtures.create();
    const message =
      "Cannot establish the terminal connection.\n" +
      "EACCES: permission denied, open '/workspace/terminal-state/TemperatureDependentReferenceSpectrometerCalibrationRepeatabilityAndMeasurementUncertaintyDecompositionAnalysis.json'";
    let recover = false;
    await page.route(
      source === "catalog"
        ? /\/api\/terminals(?:\?|$)/
        : /\/api\/terminals\/[^/]+\/attach-ticket$/,
      (route) =>
        recover
          ? route.fallback()
          : route.fulfill({ status: 500, json: { error: message } }),
    );
    await openFixtureTerminal(page);

    const pane = page.locator(".ctx");
    const error = pane.locator(
      source === "catalog" ? ".terminal-pane__error" : ".terminal-view__error",
    );
    await expect(error).toHaveAttribute("role", "alert");
    await expect(error.locator(".notice__text")).toHaveText(message);
    await page.evaluate(() => document.fonts.ready);
    await page.setViewportSize({ width: 320, height: 420 });
    await expect
      .poll(() => error.evaluate(textOverflowsInlineBounds))
      .toBe(false);
    if (source === "catalog") {
      for (const label of [
        error.locator(".notice__title"),
        error.locator(".notice__text"),
      ])
        expect((await renderedColors(label)).contrast).toBeGreaterThanOrEqual(
          4.5,
        );
      const copy = error.getByRole("button", {
        name: "Copy error",
        exact: true,
      });
      await expect(copy).toBeInViewport({ ratio: 1 });
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await error.locator(".notice__text").click();
      await expect(error).toBeVisible();
      await copy.click();
      await expect
        .poll(async () =>
          (await page.evaluate(() => navigator.clipboard.readText())).replace(
            /\r\n/g,
            "\n",
          ),
        )
        .toBe(message);
      await expect(
        error.getByRole("button", { name: "Error copied", exact: true }),
      ).toBeVisible();
    }
    // Restore transport only after dismissal so reconnect cannot remove the click target.
    await error
      .getByRole("button", { name: "Dismiss terminal error", exact: true })
      .click();
    recover = true;
    await expect(error).toHaveCount(0);
  });
}

test("project terminals and a lost create response survive browser reload", {
  tag: "@cross-browser",
}, async ({ context, page, browserName }) => {
  // Real typing, replay, accessibility analysis, two clients and confirmed
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
  const deliveries: unknown[] = [];
  const check = Promise.withResolvers<void>();
  const routePattern = /\/api\/terminal-operations(?:\?observe=1)?$/;
  try {
    if (browserName === "chromium") {
      // Only Chromium supports this headless read permission grant. Keep the
      // real paste check there; other engines still exercise native PTY input,
      // Unicode output, reload/replay, and control handoff without a shim.
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(page.url()).origin,
      });
      await page.evaluate(
        (command) => navigator.clipboard.writeText(command),
        terminalWriteCommand("终端✓\n"),
      );
      await (await terminalAction(page, "Paste into terminal")).click();
      await expect(input).toBeFocused();
      await input.press("Enter");
    } else {
      await writeTerminal(input, "终端✓\n");
    }
    await expect(output).toContainText("终端✓");
    await writeTerminal(input, "\u001b[?1049hINSPIRE_ALT_SCREEN");
    await expect(output).toContainText("INSPIRE_ALT_SCREEN");

    await page.route(routePattern, async (route) => {
      const request = route.request();
      if (
        request.method() !== "POST" ||
        request.postDataJSON()?.intent?.command !== "create"
      )
        return route.continue();
      deliveries.push({
        body: request.postDataJSON(),
        observing: new URL(request.url()).searchParams.get("observe") === "1",
      });
      const response = await route.fetch();
      if (deliveries.length === 1 && response.ok()) {
        terminalIds.push((await response.json()).result.id);
        // The daemon committed the create before the browser lost the response.
        return route.abort("failed");
      }
      await check.promise;
      await route.fulfill({ response });
    });
    await page.getByRole("button", { name: "New terminal" }).click();
    const pending = page.locator(".terminal-pending");
    await expect(pending).toContainText("Outcome unknown");
    await expect(pending).toBeInViewport({ ratio: 1 });
    const secondTab = terminalTab(page, terminalIds[1]!);
    // Catalog observation finds the second tab without sending another create.
    await expect(secondTab).toBeVisible({ timeout: 10_000 });
    expect(deliveries).toHaveLength(1);
    await secondTab.click();
    const terminalAccessibility = await new AxeBuilder({ page })
      .include(".terminal-pane")
      .analyze();
    expect(terminalAccessibility.violations).toEqual([]);

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
    await expect(pending).toContainText(browserWorkspace);
    await pending
      .getByRole("button", { name: "Retry same operation" })
      .press("Enter");
    await expect(
      pending.getByRole("button", { name: "Checking…" }),
    ).toBeDisabled();
    await expect(
      pending.getByRole("button", { name: "Stop tracking…" }),
    ).toBeDisabled();
    check.resolve();
    await expect(pending).toHaveCount(0);
    expect(deliveries).toHaveLength(2);
    expect(deliveries[0]).toMatchObject({ observing: false });
    expect(deliveries[1]).toEqual({
      ...(deliveries[0] as object),
      observing: true,
    });
    expect((await terminalCatalog(page)).terminals.map(({ id }) => id)).toEqual(
      terminalIds,
    );
    await expect(foreignTab).toHaveAttribute("aria-selected", "true");
    const desktop = page.viewportSize()!;
    await page.setViewportSize({ width: 568, height: 320 });
    const projectContext = page.locator(".terminal-project-context");
    await expect(projectContext).toContainText("Viewing browser");
    const back = projectContext.getByRole("button", {
      name: "Back to current project",
    });
    await back.focus();
    await expect(back).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() => back.evaluate(focusRingClipping))
      .toBeLessThanOrEqual(0.5);
    await back.press("Enter");
    await expect(projectContext).toBeHidden();
    await page.setViewportSize(desktop);

    await terminalTab(page, firstId).click();
    await expect(terminalStatus(page)).toBeVisible();
    await expect(output).toContainText("INSPIRE_ALT_SCREEN");
    await writeTerminal(input, "\u001b[?1049l");

    const focusedPage = await context.newPage();
    const focusedUrl = new URL(page.url());
    focusedUrl.searchParams.set("terminal", firstId);
    focusedUrl.searchParams.set("terminalFocus", "1");
    await focusedPage.goto(focusedUrl.href);
    await expect(focusedPage.locator(".terminal-pane--focused")).toBeVisible();
    await expect(terminalStatus(focusedPage, "View only")).toBeVisible();
    const focusedArrow = activeTerminal(focusedPage).getByRole("button", {
      name: "Arrow up",
      exact: true,
      includeHidden: true,
    });
    await expect(focusedArrow).toBeDisabled();
    await focusedPage.keyboard.press("ControlOrMeta+k");
    await focusedPage
      .getByRole("dialog", { name: "Command palette" })
      .getByLabel("Filter commands")
      .fill("take control");
    await focusedPage
      .getByRole("option", { name: /Take control of terminal/ })
      .click();
    await expect(terminalStatus(focusedPage)).toBeVisible();
    await expect(focusedArrow).toBeEnabled();
    await expect(terminalStatus(page, "View only")).toBeVisible();
    await openFixtureSession(page, /Formula rendering and spectral analysis/);
    await expect(focusedPage.locator(".terminal-pane--focused")).toBeVisible();
    await expect(terminalTab(focusedPage, firstId)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await focusedPage.close();
  } finally {
    check.resolve();
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

test("terminal menus fit the narrow pane and Escape restores their individual owners", async ({
  page,
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
  let terminal:
    | Awaited<ReturnType<typeof terminalCatalog>>["terminals"][number]
    | undefined;
  await page.route(/\/api\/terminals(?:\?|$)/, (route) =>
    route.fetch().then(async (response) =>
      route.fulfill({
        response,
        json: {
          ...(await response.json()),
          profiles,
          ...(!terminal ||
          new URL(route.request().url()).searchParams.has("cwd")
            ? {}
            : {
                terminals: [
                  ["Atlas dev", "/Clients/Atlas", "make atlas"],
                  ["Atlas logs", "/Clients/Atlas", "bash"],
                  ["Atlas demo", "C:\\Samples\\Atlas", "bash"],
                  ["Orion dev", "/Clients/Orion", "bash"],
                ].map(([title, projectCwd, currentCommand], index) => ({
                  ...terminal,
                  id: `navigator-${index}`,
                  title,
                  projectCwd,
                  currentCommand,
                })),
              }),
        },
      }),
    ),
  );
  await openFixtureTerminal(page);
  await page
    .locator(".terminal-empty")
    .getByRole("button", { name: "New terminal" })
    .click();
  const picker = page.getByLabel("Choose terminal profile", { exact: true });
  await expect(picker).toBeFocused();
  expect((await terminalCatalog(page)).terminals).toEqual([]);
  const create = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/terminal-operations" &&
      request.postDataJSON()?.intent?.command === "create",
  );
  await page.getByRole("button", { name: alternative }).click();
  expect((await create).postDataJSON().intent.params.request).toEqual({
    cwd: browserWorkspace,
    profileId: shell.id,
  });
  await expect(terminalStatus(page)).toBeVisible();
  [terminal] = (await terminalCatalog(page)).terminals;
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
  await page.setViewportSize({ width: 320, height: 420 });
  await page.evaluate(() => document.fonts.ready);
  for (const row of await menu.getByRole("button").all())
    await expect
      .poll(() => row.evaluate(textOverflowsInlineBounds))
      .toBe(false);
  await picker.focus();
  await picker.press("Tab");
  await expect(current).toBeFocused();
  await current.press("Escape");
  await expect(menu).toBeHidden();
  await expect(picker).toBeFocused();

  await page.setViewportSize({ width: 320, height: 900 });
  await picker.press("Enter");
  await actions.press("Enter");
  await expect(menu).toBeHidden();
  await projects.click();
  const filter = page.getByRole("searchbox", {
    name: "Find terminal or project",
  });
  const navigator = page.locator(".terminal-menu__projects");
  await expect(navigator.locator(".terminal-menu__project-context")).toHaveText(
    ["@Clients", "@Samples"],
  );
  await filter.fill("ATLAS");
  await expect(navigator.getByRole("button")).toHaveText([
    "Atlas devmake atlas",
    "Atlas logsbash",
    "Atlas demobash",
  ]);
  await filter.fill("CLIENTS");
  await expect(
    navigator.getByRole("button", { name: /Orion dev/ }),
  ).toBeVisible();
  await expect(
    navigator.getByRole("button", { name: /Atlas demo/ }),
  ).toHaveCount(0);
  await filter.fill("NO_SUCH_TERMINAL");
  await expect(
    page.getByText("No matching terminals", { exact: true }),
  ).toBeVisible();
  await filter.press("Escape");
  await expect(filter).toBeHidden();
  await expect(projects).toBeFocused();
  await projects.press("Escape");
  await expect(projects).toBeHidden();
  await expect(actions).toBeFocused();

  await page
    .getByRole("button", { name: "Focus terminal", exact: true })
    .click();
  await expect(page.locator(".terminal-pane--focused")).toBeVisible();
  await actions.click();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Terminal settings" });
  const close = settings.getByRole("button", {
    name: "Close terminal settings",
  });
  await expect(close).toBeFocused();
  await close.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(actions).toBeFocused();
  await page
    .getByRole("button", { name: "Exit focused terminal", exact: true })
    .click();
  await expect(page.locator(".terminal-pane--focused")).toHaveCount(0);
  await expect(page.locator(".ctx")).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(page.locator(".ctx")).toHaveCount(0);
  const removed = await terminalOperation(page, {
    command: "remove",
    params: { id: terminal!.id, force: true },
  });
  expect(removed.ok()).toBe(true);
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
    const firstId = (await fixtures.create()).id;
    const secondId = mac ? undefined : (await fixtures.create()).id;
    const wire = observeTerminalSocket(page, firstId);
    const bytes = () => wire.inputs.join("");
    await openFixtureTerminal(page);
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

    const beforePalette = bytes();
    await input.press(mac ? "Meta+k" : "Control+k");
    const palette = page.getByRole("dialog", { name: "Command palette" });
    await palette
      .getByRole("combobox", { name: "Filter commands" })
      .press("Escape");
    expect(bytes()).toBe(beforePalette);

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

    const chord = `${mac ? "Meta" : "Control"}+Shift+Backquote`;
    const create = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/terminal-operations" &&
        response.request().method() === "POST" &&
        response.request().postDataJSON()?.intent?.command === "create",
    );
    await input.press(chord);
    const response = await create;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON().intent.params.request).toEqual({
      cwd: browserWorkspace,
    });
    const { result: created } = await response.json();
    await expect(terminalTab(page, created.id)).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await firstTab.click();
    const removed = await terminalOperation(page, {
      command: "remove",
      params: { id: created.id, force: true },
    });
    expect(removed.ok()).toBe(true);
    const setShortcutPriority = async (name: "Shell" | "Workbench") => {
      await (await terminalAction(page, "Settings")).click();
      const dialog = page.getByRole("dialog", { name: "Terminal settings" });
      await dialog
        .getByRole("button", { name: "Interaction", exact: true })
        .click();
      await dialog
        .getByRole("combobox", { name: "Terminal shortcut priority" })
        .selectOption({ label: name });
      await dialog
        .getByRole("button", { name: "Close terminal settings" })
        .click();
    };
    await setShortcutPriority("Shell");
    expect(
      await replayLayoutKey(firstTab, {
        key: "~",
        code: "Backquote",
        shiftKey: true,
        ctrlKey: !mac,
        metaKey: mac,
      }),
    ).toBe(false);
    expect((await terminalCatalog(page)).terminals.map(({ id }) => id)).toEqual(
      secondId ? [firstId, secondId] : [firstId],
    );
    await setShortcutPriority("Workbench");

    if (secondId) {
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

    const openInteraction = async () => {
      await (await terminalAction(page, "Settings")).click();
      await page
        .getByRole("dialog", { name: "Terminal settings" })
        .getByRole("button", { name: "Interaction", exact: true })
        .click();
    };
    await openInteraction();
    const option = page.getByRole("switch", { name: "Use Option as Meta" });
    await expect(option).not.toBeChecked();
    await option.locator("..").click();
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

test("terminal search, last output, and asynchronous paste follow the active tab", async ({
  context,
  page,
  fixtures,
}) => {
  await pairWithTerminalOutput(page);
  const firstId = (await fixtures.create()).id;
  const secondId = (await fixtures.create()).id;
  const firstTerminal = observeTerminalSocket(page, firstId);
  const secondTerminal = observeTerminalSocket(page, secondId);
  const selectTab = async (id: string) => {
    const tab = terminalTab(page, id);
    await tab.click();
    await expect(tab).toHaveAttribute("aria-selected", "true");
  };
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
  await page.getByRole("button", { name: "Close terminal search" }).click();
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
    await expect(searchInput).toBeFocused();
    await expect(result).toHaveText("1/2");
  }
  await searchInput.press("Enter");
  await expect(result).toHaveText("2/2");
  await searchInput.press("Escape");
  await expect(searchInput).toBeHidden();
  await expect(input).toBeFocused();

  const selected = terminalTab(page, firstId);
  await expect(selected).toHaveAttribute(
    "aria-controls",
    (await activeTerminal(page)
      .locator("xpath=ancestor::*[@role='tabpanel']")
      .getAttribute("id"))!,
  );
  const draft = "UNFINISHED_TERMINAL_LINE";
  await input.pressSequentially(draft);
  const files = page.getByRole("tab", { name: "Files", exact: true });
  await files.click();
  await expect(input).toBeHidden();
  await selectTab(firstId);
  await expect(output).toContainText(draft);
  expect((await terminalCatalog(page)).terminals.map(({ id }) => id)).toEqual([
    firstId,
    secondId,
  ]);
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
    const { id } = await fixtures.create();
    const { inputs } = observeTerminalSocket(page, id);
    await openFixtureTerminal(page);
    await expect(terminalStatus(page)).toBeVisible();
    const input = terminalInput(page);
    const keys = page.getByRole("group", {
      name: "Terminal keys",
      exact: true,
    });
    const ctrl = keys.getByRole("button", { name: "Ctrl", exact: true });
    const scroll = keys.locator(".terminal-touch-keys__scroller");
    await page.setViewportSize({ width: 320, height: 844 });
    {
      const arrows = keys
        .getByRole("group", { name: "Arrow keys", exact: true })
        .getByRole("button");
      for (const arrow of await arrows.all())
        await expect(arrow).toBeInViewport({ ratio: 1 });
      const arrowX = (await arrows.first().boundingBox())!.x;
      const expectCompleteKeys = async () => {
        await expect
          .poll(() =>
            scroll.evaluate((node) => {
              const viewport = node.getBoundingClientRect();
              const visible = [...node.querySelectorAll("button")]
                .map((button) => button.getBoundingClientRect())
                .filter(
                  (rect) =>
                    rect.right > viewport.left + 1 &&
                    rect.left < viewport.right - 1,
                );
              return (
                visible.length > 0 &&
                visible.every(
                  (rect) =>
                    rect.left >= viewport.left - 1 &&
                    rect.right <= viewport.right + 1,
                )
              );
            }),
          )
          .toBe(true);
      };
      // An arbitrary drag offset must settle on whole keys, not clipped labels.
      await scroll.evaluate((node) => {
        node.scrollLeft += 83;
      });
      await expectCompleteKeys();
      await scroll.evaluate((node) => {
        node.scrollLeft = node.scrollWidth;
      });
      await expect(
        keys.getByRole("button", { name: "PgDn", exact: true }),
      ).toBeInViewport({ ratio: 1 });
      await expectCompleteKeys();
      expect((await arrows.first().boundingBox())!.x).toBe(arrowX);
      await scroll.evaluate((node) => {
        node.scrollLeft = 0;
      });
    }
    await input.evaluate((node) => node.blur());
    await keys.getByRole("button", { name: "Arrow up", exact: true }).tap();
    await expect.poll(() => inputs.at(-1)).toMatch(/^\x1b(?:\[|O)A$/u);
    await expect(input).not.toBeFocused();
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
    await page.keyboard.press("ControlOrMeta+v");
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
    const snapshot = await text.inputValue();
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
    await expect(copySelection).toBeVisible();
    // The native selection survives the height change that clears xterm's
    // canvas selection. Incoming reflow does not replace the captured text.
    await page.setViewportSize({ width: 390, height: 500 });
    await expect(text).toHaveValue(snapshot);
    await copySelection.tap();
    await expect
      .poll(() => page.evaluate(() => navigator.clipboard.readText()))
      .toBe("TOUCH_COPY_中文");
    // The landscape safe area must leave the dialog and its actions reachable.
    await page.setViewportSize({ width: 700, height: 390 });
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--safe-left", "36px");
      document.documentElement.style.setProperty("--safe-right", "36px");
      document.documentElement.dataset.theme = "dark";
    });
    const surface = dialog.locator(".terminal-text-dialog");
    await expect(surface).toBeInViewport({ ratio: 1 });
    const bounds = (await surface.boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(36);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(700 - 36);
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

    const pageDown = keys.getByRole("button", {
      name: "PgDn",
      exact: true,
    });
    const beforePageDown = inputs.length;
    await pageDown.tap();
    await expect
      .poll(() => inputs.slice(beforePageDown).join(""))
      .toBe("\u001b[6~");
    const alt = keys.getByRole("button", { name: "Alt", exact: true });
    await alt.tap();
    await expect(alt).toHaveAttribute("aria-pressed", "true");
    const previous = inputs.length;
    await keys.getByRole("button", { name: "Esc", exact: true }).tap();
    await expect
      .poll(() => inputs.slice(previous).join(""))
      .toBe("\u001b\u001b");
    await expect(alt).toHaveAttribute("aria-pressed", "false");

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
