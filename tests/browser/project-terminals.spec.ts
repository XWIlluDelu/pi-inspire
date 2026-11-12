import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  decodeTerminalInputFrame,
  decodeTerminalServerDataFrame,
  encodeTerminalServerDataFrame,
} from "../../shared/terminal-contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { renderedColors } from "./support/colors";
import { focusRingClipping } from "./support/focus-bounds";
import { hostRequest } from "./support/host-request";
import {
  openCommandPalette,
  openFixtureSession,
  openProjectTerminal,
  pairAndOpen,
  pairedPage,
  showTerminalControls,
} from "./support/navigation";
import { terminalWriteCommand } from "./support/terminal-command";
import { terminalMutationHeaders } from "./support/terminal-operations";
import { terminalTransportFixture } from "./support/terminal-transport";
import { textOverflowsInlineBounds } from "./support/text-bounds";

test.use({ serviceWorkers: "block" });

async function openFixtureTerminal(page: Page) {
  await pairAndOpen(page);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await openProjectTerminal(page);
}

test("a replacement terminal snapshot retires output still waiting in xterm's parser", async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.localStorage.setItem(
      "inspire:terminal-ui-settings:v1",
      JSON.stringify({ screenReaderMode: true }),
    );
  });
  const [terminal] = await terminalTransportFixture(page, browserWorkspace, [
    "snapshot-replay",
  ]);
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
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
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await openProjectTerminal(page);
  await expect(
    page.getByRole("status", { name: "Controlling", exact: true }),
  ).toBeVisible();
  await expect.poll(() => terminal!.resizes.length).toBeGreaterThan(0);
  terminal!.write("INITIAL_OUTPUT\r\n");
  await expect(
    page.locator(".terminal-view--active .xterm-accessibility-tree"),
  ).toContainText("INITIAL_OUTPUT");
  const descriptor = terminal!.descriptor;
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
        type: "attached",
        terminal: descriptor,
        attachmentId: "replacement-attachment",
        writable: true,
        ownerToken: "replacement-owner",
        nextInputSequence: 1,
        replay: "snapshot",
      }),
      frame("snapshot", "CURRENT_SNAPSHOT"),
      JSON.stringify({
        type: "replay_complete",
        nextOutputOffset: descriptor.nextOutputOffset,
      }),
    ],
  );
  const output = page.locator(
    ".terminal-view--active .xterm-accessibility-tree",
  );
  await expect(output).toContainText("CURRENT_SNAPSHOT");
  await expect(output).not.toContainText("RETIRED_OUTPUT");
  terminal!.write("\r\nLIVE_TAIL");
  await expect(output).toContainText("LIVE_TAIL");
  await expect(
    page.getByRole("status", { name: "Controlling", exact: true }),
  ).toBeVisible();
});

for (const source of ["catalog", "connection"] as const) {
  test(`long terminal ${source} errors stay within the pane and can be dismissed`, {
    tag: "@platform-ui",
  }, async ({ page, context }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await terminalTransportFixture(
      page,
      browserWorkspace,
      source === "connection" ? ["error-wrap-terminal"] : [],
    );
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
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  await page.evaluate(() => {
    window.localStorage.setItem(
      "inspire:terminal-ui-settings:v1",
      JSON.stringify({ screenReaderMode: true }),
    );
  });
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await openProjectTerminal(page);

  const emptyTerminal = page.locator(".terminal-empty");
  await emptyTerminal.getByRole("button", { name: "New terminal" }).click();
  const readTerminals = async () => {
    const response = await hostRequest(page).get(
      `/api/terminals?cwd=${encodeURIComponent(browserWorkspace)}`,
    );
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{
      terminals: Array<{ id: string }>;
    }>;
  };
  const terminalInput = page.locator(".xterm-helper-textarea");
  await expect(terminalInput).toBeVisible();
  const firstCatalog = await readTerminals();
  const firstTerminal = firstCatalog.terminals[0]!;
  const terminalIds = [firstTerminal.id];
  let foreignId: string | undefined;
  const deliveries: Array<{ identity: string; body: string | null }> = [];
  const check = Promise.withResolvers<void>();
  const routePattern = "**/api/terminals";
  try {
    const visibleTerminalOutput = page.locator(
      ".terminal-views__item:not([hidden]) .xterm-accessibility-tree",
    );
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
      await showTerminalControls(page);
      await page.getByLabel("Terminal actions", { exact: true }).click();
      await page.getByRole("button", { name: "Paste into terminal" }).click();
      await expect(
        page.locator(".terminal-pane details[data-terminal-menu][open]"),
      ).toHaveCount(0);
      await expect(terminalInput).toBeFocused();
    } else {
      await terminalInput.pressSequentially(terminalWriteCommand("终端✓\n"));
    }
    await terminalInput.press("Enter");
    await expect(visibleTerminalOutput).toContainText("终端✓");
    await terminalInput.pressSequentially(
      terminalWriteCommand("\u001b[?1049hINSPIRE_ALT_SCREEN"),
    );
    await terminalInput.press("Enter");
    await expect(visibleTerminalOutput).toContainText("INSPIRE_ALT_SCREEN");

    await page.route(routePattern, async (route) => {
      const request = route.request();
      if (request.method() !== "POST") return route.continue();
      deliveries.push({
        identity: request.headers()["x-terminal-operation"]!,
        body: request.postData(),
      });
      const response = await route.fetch();
      if (deliveries.length === 1 && response.ok()) {
        terminalIds.push((await response.json()).id);
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
    const secondTab = page.locator(`#terminal-tab-${terminalIds[1]}`);
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

    const foreignResponse = await hostRequest(page).post("/api/terminals", {
      headers: await terminalMutationHeaders(page),
      data: { cwd: join(browserWorkspace, "tests", "browser") },
    });
    expect(foreignResponse.ok()).toBe(true);
    const foreign = await foreignResponse.json();
    foreignId = foreign.id;
    await showTerminalControls(page);
    await page.getByLabel("Terminal actions", { exact: true }).click();
    await page.getByLabel("Terminals in all projects", { exact: true }).click();
    await page
      .getByRole("textbox", { name: "Find terminal or project" })
      .fill(foreign.projectCwd);
    await page
      .locator(".terminal-menu__project")
      .filter({
        has: page.getByTitle(foreign.projectCwd, { exact: true }),
      })
      .getByRole("button")
      .click();
    const activeForeign = page.locator(
      `#terminal-tab-${foreignId}:is([aria-selected="true"],[aria-pressed="true"])`,
    );
    await expect(activeForeign).toBeVisible();
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
    expect(deliveries[1]).toEqual(deliveries[0]);
    expect((await readTerminals()).terminals.map(({ id }) => id)).toEqual(
      terminalIds,
    );
    await expect(activeForeign).toBeVisible();
    const desktop = page.viewportSize()!;
    await page.setViewportSize({ width: 568, height: 320 });
    const projectContext = page.locator(".terminal-project-context");
    await expect(projectContext).toContainText("Viewing browser");
    const back = projectContext.getByRole("button", {
      name: "Back to current project",
    });
    await page.keyboard.press("Tab");
    await back.focus();
    await expect(back).toBeInViewport({ ratio: 1 });
    await expect
      .poll(() => back.evaluate(focusRingClipping))
      .toBeLessThanOrEqual(0.5);
    await back.press("Enter");
    await expect(projectContext).toBeHidden();
    await page.setViewportSize(desktop);

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
    await restoredInput.pressSequentially(
      terminalWriteCommand("\u001b[?1049l"),
    );
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
    const focusedArrow = focusedPage.locator(
      '.terminal-view--active .terminal-touch-keys button[aria-label="Arrow up"]',
    );
    await expect(focusedArrow).toBeDisabled();
    await focusedPage.keyboard.press("ControlOrMeta+k");
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
    await expect(focusedArrow).toBeEnabled();
    await showTerminalControls(page);
    await expect(
      page.getByRole("status", { name: "View only", exact: true }),
    ).toBeVisible();
    await openFixtureSession(page, /Formula rendering and spectral analysis/);
    await expect(focusedPage.locator(".terminal-pane--focused")).toBeVisible();
    await expect(
      focusedPage.locator(`#terminal-tab-${terminalIds[0]}`),
    ).toHaveAttribute("aria-pressed", "true");
    await focusedPage.close();
  } finally {
    check.resolve();
    await page.unroute(routePattern);
    for (const terminalId of foreignId
      ? [...terminalIds, foreignId]
      : terminalIds) {
      const response = await hostRequest(page).delete(
        `/api/terminals/${encodeURIComponent(terminalId)}?force=1`,
        { headers: await terminalMutationHeaders(page) },
      );
      expect(response.ok()).toBe(true);
    }
  }
  await expect.poll(async () => (await readTerminals()).terminals).toEqual([]);
});

test("terminal menus fit the narrow pane and Escape restores their individual owners", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const [terminal] = await terminalTransportFixture(page, browserWorkspace, [
    "profile-menu-terminal",
  ]);
  const defaultLabel = "CalibrationResearchEnvironmentShell";
  const profiles = [
    { id: "research", label: defaultLabel, available: true, isDefault: true },
    { id: "bash", label: "Bash", available: true, isDefault: false },
    {
      id: "spectrometry",
      label: "光谱校准与测量不确定度分析专用交互环境",
      available: true,
      isDefault: false,
    },
  ];
  await page.route(/\/api\/terminals(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        catalogEpoch: terminal!.descriptor.catalogEpoch,
        revision: terminal!.descriptor.catalogRevision,
        terminals: [terminal!.descriptor],
        profiles,
      },
    }),
  );
  await openFixtureTerminal(page);
  await expect(
    page.getByRole("status", { name: "Controlling", exact: true }),
  ).toBeVisible();

  const actions = page.getByLabel("Terminal actions", { exact: true });
  const picker = page.getByLabel("Choose terminal profile", { exact: true });
  const projects = page.getByLabel("Terminals in all projects", {
    exact: true,
  });
  const menu = page.locator(".terminal-menu__popover--profiles");
  const current = menu.getByRole("button", {
    name: defaultLabel + " Default",
    exact: true,
  });
  await showTerminalControls(page);
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
  const filter = page.getByRole("textbox", {
    name: "Find terminal or project",
  });
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

  await actions.press("Enter");
  await page
    .getByRole("button", { name: "Focus terminal", exact: true })
    .click();
  await expect(page.locator(".terminal-pane--focused")).toBeVisible();
  await showTerminalControls(page);
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
  await actions.press("Enter");
  await page
    .getByRole("button", { name: "Exit focused terminal", exact: true })
    .click();
  await expect(page.locator(".terminal-pane--focused")).toHaveCount(0);
  await expect(page.locator(".ctx")).toBeVisible();

  await showTerminalControls(page);
  await actions.press("Escape");
  await expect(
    page.getByRole("button", { name: "Show terminal controls", exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator(".ctx")).toHaveCount(0);
});

test.describe("platform terminal keyboard input", () => {
  for (const platform of ["Win32", "MacIntel"]) {
    test(platform +
      " preserves native input, clipboard and explicit tab chords", {
      tag: "@cross-browser",
    }, async ({ page }) => {
      await page.addInitScript((platform) => {
        Object.defineProperty(navigator, "platform", {
          configurable: true,
          value: platform,
        });
      }, platform);
      const ids = ["platform-input", "platform-second"];
      const [first] = await terminalTransportFixture(
        page,
        browserWorkspace,
        ids,
      );
      await openFixtureTerminal(page);
      await expect(
        page.getByRole("status", { name: "Controlling", exact: true }),
      ).toBeVisible();
      const input = page.locator(
        ".terminal-views__item:not([hidden]) .xterm-helper-textarea",
      );

      await test.step("interrupt, native clipboard and palette focus", async () => {
        await input.focus();
        await input.press("Control+c");
        await expect.poll(() => first!.inputs.join("")).toBe("\u0003");

        first!.write("COPY_ME\r\n");
        // Let the small output frame reach the real canvas renderer before drag.
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        const selectOutput = async () => {
          const box = await page
            .locator(".terminal-view--active .xterm-screen")
            .boundingBox();
          if (!box) throw new Error("Terminal screen is unavailable");
          const dimensions = first!.resizes.at(-1)!;
          const cell = box.width / dimensions.cols;
          const y = box.y + box.height / dimensions.rows / 2;
          await page.mouse.move(box.x + cell * 0.1, y);
          await page.mouse.down();
          await page.mouse.move(box.x + cell * 7, y);
          await page.mouse.up();
          await expect(
            page.getByRole("button", { name: "Copy terminal selection" }),
          ).toBeVisible();
        };
        await selectOutput();
        const beforeCopy = first!.inputs.join("");
        // Replay native clipboard events against real xterm on either layout.
        const nativeClipboard = (action: "copy" | "paste") =>
          input.evaluate(
            (el, { action, mac }) => {
              const key = action === "copy" ? "c" : "v";
              const accepted = el.dispatchEvent(
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
              // Some engines isolate synthetic ClipboardEvent data from the
              // DataTransfer passed to the constructor.
              let text = action === "paste" ? "PASTED_TEXT" : "";
              const clipboard = new Event(action, {
                bubbles: true,
                cancelable: true,
              });
              Object.defineProperty(clipboard, "clipboardData", {
                value: {
                  getData: (type: string) =>
                    type === "text/plain" ? text : "",
                  setData: (type: string, value: string) => {
                    if (type === "text/plain") text = value;
                  },
                },
              });
              el.dispatchEvent(clipboard);
              return { accepted, text };
            },
            { action, mac: platform === "MacIntel" },
          );
        expect(await nativeClipboard("copy")).toEqual({
          text: "COPY_ME",
          accepted: true,
        });
        expect(first!.inputs.join("")).toBe(beforeCopy);

        if (platform === "MacIntel") {
          await input.press("Control+c");
          await expect
            .poll(() => first!.inputs.join(""))
            .toBe(beforeCopy + "\u0003");
          await input.press("Control+v");
          await expect
            .poll(() => first!.inputs.join(""))
            .toBe(beforeCopy + "\u0003\u0016");
        }
        const beforePaste = first!.inputs.join("");
        expect((await nativeClipboard("paste")).accepted).toBe(true);
        await expect
          .poll(() => first!.inputs.join(""))
          .toBe(beforePaste + "PASTED_TEXT");

        const beforePalette = first!.inputs.join("");
        await input.focus();
        await page.keyboard.press(
          platform === "MacIntel" ? "Meta+k" : "Control+k",
        );
        const palette = page.getByRole("dialog", { name: "Command palette" });
        await expect(palette).toBeVisible();
        await palette
          .getByRole("combobox", { name: "Filter commands" })
          .press("Escape");
        expect(first!.inputs.join("")).toBe(beforePalette);
      });

      await test.step("international characters and tab shortcuts", async () => {
        await input.focus();
        const initialInput = first!.inputs.join("");
        // Replay OS-layout events through real xterm. Synthetic keydown alone
        // cannot generate a native keypress, so supply both parts of that contract.
        const character = platform === "MacIntel" ? "|" : "[";
        expect(
          await input.evaluate(
            (el, { platform, character }) => {
              const native = {
                altKey: true,
                ctrlKey: platform === "Win32",
                modifierAltGraph: platform === "Win32",
              };
              const down = new KeyboardEvent("keydown", {
                ...native,
                key: character,
                code: platform === "MacIntel" ? "Digit7" : "Digit8",
                keyCode: platform === "MacIntel" ? 55 : 56,
                bubbles: true,
                cancelable: true,
              });
              el.dispatchEvent(down);
              el.dispatchEvent(
                new KeyboardEvent("keypress", {
                  ...native,
                  key: character,
                  charCode: character.charCodeAt(0),
                  keyCode: character.charCodeAt(0),
                  bubbles: true,
                  cancelable: true,
                }),
              );
              el.dispatchEvent(
                new KeyboardEvent("keyup", {
                  ...native,
                  key: character,
                  bubbles: true,
                }),
              );
              return down.defaultPrevented;
            },
            { platform, character },
          ),
        ).toBe(false);
        await expect
          .poll(() => first!.inputs.join(""))
          .toBe(initialInput + character);
        await expect(page.locator("#terminal-tab-" + ids[0])).toHaveAttribute(
          "aria-selected",
          "true",
        );

        if (platform === "MacIntel") {
          await input.evaluate((el) => {
            const area = el as HTMLTextAreaElement;
            area.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "Dead",
                code: "KeyE",
                keyCode: 69,
                altKey: true,
                bubbles: true,
              }),
            );
            area.dispatchEvent(
              new KeyboardEvent("keyup", {
                key: "Dead",
                code: "KeyE",
                altKey: true,
                bubbles: true,
              }),
            );
            area.value = "";
            area.dispatchEvent(
              new CompositionEvent("compositionstart", { bubbles: true }),
            );
            area.value = "é";
            area.dispatchEvent(
              new CompositionEvent("compositionupdate", {
                data: "é",
                bubbles: true,
              }),
            );
            area.dispatchEvent(
              new CompositionEvent("compositionend", {
                data: "é",
                bubbles: true,
              }),
            );
          });
          await expect
            .poll(() => first!.inputs.join(""))
            .toBe(initialInput + "|é");
          await input.press("x");
          await expect
            .poll(() => first!.inputs.join(""))
            .toBe(initialInput + "|éx");
        }
        const beforeTabs = first!.inputs.join("");
        await input.press("Alt+2");
        // On a real OS this chord is a shortcut only if key remains "2";
        // Playwright's physical chord reports the digit independent of layout.
        await expect(page.locator("#terminal-tab-" + ids[1])).toHaveAttribute(
          "aria-selected",
          "true",
        );
        expect(first!.inputs.join("")).toBe(beforeTabs);
        // The shared strip can overflow the inactive tab into More tabs.
        await input.press("Alt+1");
        await expect(page.locator("#terminal-tab-" + ids[0])).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await showTerminalControls(page);
        await page
          .getByRole("button", { name: "Search terminal output", exact: true })
          .click();
        const search = page.getByRole("textbox", {
          name: "Search terminal output",
          exact: true,
        });
        expect(
          await search.evaluate((el) =>
            el.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "[",
                code: "Digit8",
                ctrlKey: true,
                altKey: true,
                modifierAltGraph: true,
                bubbles: true,
                cancelable: true,
              }),
            ),
          ),
        ).toBe(true);
        await search.press("Alt+2");
        await expect(page.locator("#terminal-tab-" + ids[0])).toHaveAttribute(
          "aria-selected",
          "true",
        );
        await expect(search).toBeFocused();

        if (platform === "MacIntel") {
          await search.press("Escape");
          const openSettings = async () => {
            const commands = await openCommandPalette(page);
            await commands
              .getByLabel("Filter commands")
              .fill("Terminal settings");
            await commands
              .getByRole("option", { name: /Terminal settings/ })
              .click();
            const settings = page.getByRole("dialog", {
              name: "Terminal settings",
            });
            await settings
              .getByRole("button", { name: "Interaction", exact: true })
              .click();
          };
          await openSettings();
          const option = page.getByRole("switch", {
            name: "Use Option as Meta",
          });
          const close = page.getByRole("button", {
            name: "Close terminal settings",
          });
          await expect(option).not.toBeChecked();
          await option.locator("..").click();
          await close.click();
          await input.focus();
          await input.evaluate((el) => {
            el.dispatchEvent(
              new KeyboardEvent("keydown", {
                key: "¬",
                code: "KeyL",
                keyCode: 76,
                altKey: true,
                bubbles: true,
                cancelable: true,
              }),
            );
            el.dispatchEvent(
              new KeyboardEvent("keyup", {
                key: "¬",
                code: "KeyL",
                altKey: true,
                bubbles: true,
              }),
            );
          });
          await expect
            .poll(() => first!.inputs.join(""))
            .toBe(beforeTabs + "\u001bl");
          await openSettings();
          await expect(option).toBeChecked();
        }
      });
    });
  }
});

test("terminal search, last output, and asynchronous paste follow the active tab", async ({
  context,
  page,
}) => {
  const firstId = "compact-terminal-a";
  const secondId = "compact-terminal-b";
  const terminals = await terminalTransportFixture(page, browserWorkspace, [
    firstId,
    secondId,
  ]);
  const firstTerminal = terminals[0]!;
  const secondTerminal = terminals[1]!;
  const selectTab = async (id: string) => {
    const name = new RegExp(`^${id}(?:,|\\s|$)`);
    const tab = page.getByRole("tab", { name });
    if (await tab.isVisible()) {
      await tab.click();
    } else {
      await page
        .getByRole("combobox", { name: "More tabs", exact: true })
        .click();
      await page.getByRole("option", { name }).click();
    }
    await expect(tab).toHaveAttribute("aria-selected", "true");
  };
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  await page.evaluate(() =>
    localStorage.setItem(
      "inspire:terminal-ui-settings:v1",
      JSON.stringify({ screenReaderMode: true }),
    ),
  );
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await openProjectTerminal(page);
  await expect(
    page.getByRole("tab", { name: firstId, exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await expect(
    page.getByRole("status", { name: "Controlling", exact: true }),
  ).toBeVisible();
  const activeView = page.locator(".terminal-views__item:not([hidden])");
  const input = activeView.locator(".xterm-helper-textarea");
  // Wait for the live view's initial fit before sending ordered marker/text
  // bytes. ConPTY may reorder synthetic OSC relative to rendered shell text.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect.poll(() => firstTerminal.resizes.length).toBeGreaterThan(0);
  firstTerminal.write(
    "测量一\r\n测量二\r\nfixture$ run\r\n" +
      "\u001b]6973;C1;fixture\u0007TERMINAL_REDESIGN_A\r\n" +
      "\u001b]6973;D;0\u0007fixture$ ",
  );
  await expect(activeView.locator(".xterm-accessibility-tree")).toContainText(
    "TERMINAL_REDESIGN_A",
  );
  const dimensions = () => {
    const { cols, rows } = firstTerminal.descriptor;
    return { cols, rows };
  };
  const beforeSearch = dimensions();
  const searchButton = page.getByRole("button", {
    name: "Search terminal output",
    exact: true,
  });
  await showTerminalControls(page);
  await searchButton.click();
  const searchInput = page.getByRole("textbox", {
    name: "Search terminal output",
    exact: true,
  });
  await expect(searchInput).toBeFocused();
  await searchInput.fill("TERMINAL_REDESIGN_A");
  await expect(page.locator(".terminal-search__count")).not.toHaveText("0/0");
  expect(dimensions()).toEqual(beforeSearch);
  await selectTab(secondId);
  await expect.poll(() => secondTerminal.resizes.length).toBeGreaterThan(0);
  await expect(searchButton).toHaveAttribute("aria-expanded", "false");
  await showTerminalControls(page);
  await searchButton.click();
  await expect(searchInput).toHaveValue("");
  await searchInput.fill("SECOND_VIEW_QUERY");
  // Search owns the floating corner while open; dismiss it before utilities.
  await searchInput.press("Escape");
  await showTerminalControls(page);
  await page.getByLabel("Terminal actions", { exact: true }).click();
  await expect(
    page.getByRole("button", { name: "Copy last output", exact: true }),
  ).toBeDisabled();
  await selectTab(firstId);
  await expect(searchInput).toHaveValue("TERMINAL_REDESIGN_A");
  await page.getByRole("button", { name: "Close terminal search" }).click();
  // xterm retains the search match as a selection, which owns the tools corner.
  await activeView.locator(".xterm-screen").click({ position: { x: 8, y: 8 } });

  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  const utility = async (name: string) => {
    await showTerminalControls(page);
    await page.getByLabel("Terminal actions", { exact: true }).click();
    return page.getByRole("button", { name, exact: true });
  };
  await (await utility("Copy last output")).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe("TERMINAL_REDESIGN_A");

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
  await (await utility("Paste into terminal")).click();
  await selectTab(secondId);
  await selectTab(firstId);
  await deliverPaste("TERMINAL_CLIPBOARD_STALE");
  expect(firstTerminal.inputs).toEqual([]);
  expect(secondTerminal.inputs).toEqual([]);
  await (await utility("Paste into terminal")).click();
  await deliverPaste("TERMINAL_CLIPBOARD_FRESH");
  await expect
    .poll(() => firstTerminal.inputs)
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
  await expect(activeView.locator(".xterm-accessibility-tree")).toContainText(
    "TERMINAL_REDESIGN_A",
  );

  await page.setViewportSize({ width: 320, height: 844 });
  await showTerminalControls(page);
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
    await openFixtureSession(page, /Review extension event lifecycle/);
    const composer = page.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await composer.fill("Existing question");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const response = await hostRequest(page).post("/api/terminals", {
      headers: await terminalMutationHeaders(page),
      data: { cwd: browserWorkspace },
    });
    expect(response.ok()).toBe(true);
    const terminal = (await response.json()) as { id: string };
    try {
      await page.getByRole("button", { name: "Toggle resources panel" }).tap();
      await openProjectTerminal(page);
      await page.locator(`#terminal-tab-${terminal.id}`).tap();
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
      await expect.poll(() => output).toContain("TOUCH_COPY_中文");
      const more = page.getByLabel("Terminal actions", { exact: true });
      const selectText = async () => {
        await more.tap();
        await page
          .getByRole("button", { name: "Select text", exact: true })
          .tap();
      };
      await selectText();
      const dialog = page.getByRole("dialog", { name: "Select terminal text" });
      const text = dialog.getByRole("textbox", {
        name: "Terminal output",
        exact: true,
      });
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
      await expect(dialog).toBeInViewport({ ratio: 1 });
      const bounds = (await dialog.boundingBox())!;
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

      const pageDown = keys.getByRole("button", { name: "PgDn", exact: true });
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
    } finally {
      await hostRequest(page).delete(
        `/api/terminals/${encodeURIComponent(terminal.id)}?force=1`,
        { headers: await terminalMutationHeaders(page) },
      );
    }
  });
});
