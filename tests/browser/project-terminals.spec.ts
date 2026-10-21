import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import {
  decodeTerminalInputFrame,
  decodeTerminalServerDataFrame,
  encodeTerminalServerDataFrame,
} from "../../shared/terminal-contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { actionGeometry } from "./support/action-geometry";
import { focusRingClipping } from "./support/focus-bounds";
import { hostRequest } from "./support/host-request";
import { routeMockSnapshots } from "./support/mock-host";
import { openMockSession, pairedPage } from "./support/navigation";
import { terminalWriteCommand } from "./support/terminal-command";
import { terminalMutationHeaders } from "./support/terminal-operations";
import { terminalTransportFixture } from "./support/terminal-transport";
import { firstTextBaseline } from "./support/text-baseline";
import { textOverflowsInlineBounds } from "./support/text-bounds";

test("terminal failures use shared error feedback with copy and explicit dismissal", async ({
  page,
  context,
}) => {
  const message =
    "A terminal endpoint is listening, but its authenticated data connection failed. " +
    "Existing terminal processes were left running. Inspect the owning service before deciding whether replacement is needed.\n" +
    "Connection check: Client network socket disconnected before secure TLS connection was established";
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.route(/\/api\/terminals(?:\?|$)/, (route) =>
    route.fulfill({ status: 503, json: { error: message } }),
  );
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const error = page.locator(".terminal-pane__error");
  await expect(error).toBeVisible();
  await expect(error).toHaveClass(/notice--error/);
  await expect(error).toHaveAttribute("role", "alert");
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(error).toBeInViewport({ ratio: 1 });
      expect(await error.evaluate(textOverflowsInlineBounds)).toBe(false);
      await expect(
        error.getByRole("button", { name: "Copy error" }),
      ).toBeInViewport({ ratio: 1 });
    }
  }
  await error.locator(".notice__text").click();
  await expect(error).toBeVisible();
  await error.getByRole("button", { name: "Copy error" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(message);
  await error.getByRole("button", { name: "Dismiss terminal error" }).click();
  await expect(error).toBeHidden();
});

for (const touch of [false, true]) {
  test.describe(`foreign-project terminal context · ${touch ? "touch" : "mouse"}`, () => {
    test.use({ hasTouch: touch, deviceScaleFactor: touch ? 2 : 1 });
    test("keeps the return action reachable and returns to the session project", async ({
      page,
    }) => {
      const otherCwd = "/workspace/other-calibration";
      const [foreign] = await terminalTransportFixture(page, otherCwd, [
        "Other calibration",
      ]);
      await page.route(/\/api\/terminals(?:\?|$)/, (route) => {
        const cwd = new URL(route.request().url()).searchParams.get("cwd");
        return route.fulfill({
          json: {
            catalogEpoch: foreign!.descriptor.catalogEpoch,
            revision: foreign!.descriptor.catalogRevision,
            terminals: !cwd || cwd === otherCwd ? [foreign!.descriptor] : [],
            profiles: [],
          },
        });
      });
      await pairedPage(page);
      await openMockSession(page, /Review extension event lifecycle/);
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await page.getByLabel("Terminal actions", { exact: true }).click();
      await page
        .getByLabel("Terminals in all projects", { exact: true })
        .click();
      await page
        .locator(".terminal-menu__projects")
        .getByRole("button", { name: "Other calibration", exact: true })
        .click();
      const context = page.locator(".terminal-project-context");
      const back = context.getByRole("button", {
        name: "Back to current project",
        exact: true,
      });
      await expect(context).toContainText("Viewing other-calibration");
      for (const [width, height] of [
        [1280, 844],
        [820, 844],
        [390, 844],
        [320, 844],
        [568, 320],
      ]) {
        await page.setViewportSize({ width, height });
        await page.keyboard.press("Tab");
        await back.focus();
        await expect(back).toBeFocused();
        await expect(back).toHaveCSS("outline-style", "solid");
        expect((await back.boundingBox())!.height).toBeGreaterThanOrEqual(
          touch ? 44 : 24,
        );
        await expect
          .poll(() => back.evaluate(focusRingClipping))
          .toBeLessThanOrEqual(0.5);
        await expect(back).toBeInViewport();
        if (!touch) {
          await back.hover();
          await expect(back).toHaveCSS("text-decoration-line", "underline");
          await page.mouse.move(0, 0);
        }
      }
      await expect.poll(() => foreign!.resizes.length).toBeGreaterThan(0);
      if (touch) await back.tap();
      else await back.click();
      await expect(context).toHaveCount(0);
      await expect(page.locator(".terminal-tab")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "New terminal", exact: true }).first(),
      ).toBeVisible();
    });
  });
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
  await openMockSession(page, /Review extension event lifecycle/);
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
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
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

test("terminal profiles keep long labels, the default marker, and keyboard focus within the menu", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const [terminal] = await terminalTransportFixture(page, browserWorkspace, [
    "profile-menu-terminal",
  ]);
  const profiles = [
    {
      id: "research",
      label: "CalibrationResearchEnvironmentShell",
      available: true,
      isDefault: true,
    },
    { id: "bash", label: "Bash", available: true, isDefault: false },
    {
      id: "spectrometry",
      label: "光谱校准与测量不确定度分析专用交互环境",
      available: true,
      isDefault: false,
    },
    {
      id: "powershell",
      label: "Windows PowerShell",
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
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  const trigger = page.getByLabel("Choose terminal profile", { exact: true });
  await trigger.focus();
  await trigger.press("Enter");
  const menu = page.locator(".terminal-menu__popover--profiles");
  await expect(menu).toBeVisible();
  const current = menu.getByRole("button", {
    name: `${profiles[0]!.label} Default`,
    exact: true,
  });
  const short = menu.getByRole("button", { name: "Bash", exact: true });
  for (const theme of ["light", "dark"]) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [1280, 820, 390, 320]) {
      for (const height of [900, 420]) {
        await page.setViewportSize({ width, height });
        await page.evaluate(() => document.fonts.ready);
        await expect(menu).toBeVisible();
        await expect
          .poll(() => menu.evaluate((el) => el.scrollWidth - el.clientWidth))
          .toBe(0);
        for (const row of await menu.getByRole("button").all()) {
          await expect
            .poll(() => row.evaluate(textOverflowsInlineBounds))
            .toBe(false);
        }
        const baseline = await current
          .locator("span")
          .evaluate(firstTextBaseline);
        const markerBaseline = await current
          .locator("small")
          .evaluate(firstTextBaseline);
        expect(baseline).not.toBeNull();
        expect(markerBaseline).not.toBeNull();
        expect(Math.abs(baseline! - markerBaseline!)).toBeLessThanOrEqual(0.5);
        const shortSize = await short.evaluate((el) => {
          const row = el.getBoundingClientRect();
          const text = el.querySelector("span")!.getBoundingClientRect();
          return {
            height: row.height,
            minHeight: Number.parseFloat(getComputedStyle(el).minHeight),
            centerOffset: (text.top + text.bottom - row.top - row.bottom) / 2,
          };
        });
        expect(shortSize.height).toBeCloseTo(shortSize.minHeight, 1);
        expect(Math.abs(shortSize.centerOffset)).toBeLessThanOrEqual(0.5);
      }
    }
  }
  await trigger.focus();
  await trigger.press("Tab");
  await expect(current).toBeFocused();
  await current.press("Escape");
  await expect(menu).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

for (const theme of ["light", "dark"] as const) {
  for (const source of ["catalog", "connection"] as const) {
    test(`long terminal ${source} errors remain contained and dismissible in ${theme} mode`, {
      tag: "@platform-ui",
    }, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await routeMockSnapshots(page, {
        bootstrap(body) {
          body.preferences.theme = theme;
        },
      });
      await terminalTransportFixture(
        page,
        browserWorkspace,
        source === "connection" ? ["error-wrap-terminal"] : [],
      );
      const message =
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
      await pairedPage(page);
      await openMockSession(page, /Review extension event lifecycle/);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      const pane = page.locator(".ctx");
      await pane.getByRole("button", { name: "Terminal", exact: true }).click();
      const error = pane.locator(
        source === "catalog"
          ? ".terminal-pane__error"
          : ".terminal-view__error",
      );
      for (const width of [1280, 820, 390, 320]) {
        for (const height of [900, 420]) {
          await page.setViewportSize({ width, height });
          await expect(error).toHaveText(message);
          await page.evaluate(() => document.fonts.ready);
          await expect
            .poll(() => error.evaluate(textOverflowsInlineBounds))
            .toBe(false);
          await expect
            .poll(() =>
              error.evaluate((element) => {
                const frame = element.getBoundingClientRect();
                const pane = element
                  .closest(".terminal-pane")!
                  .getBoundingClientRect();
                return (
                  frame.left >= pane.left &&
                  frame.right <= pane.right &&
                  frame.top >= pane.top &&
                  frame.bottom <= pane.bottom
                );
              }),
            )
            .toBe(true);
        }
      }
      // Let the actual dismiss click win before restoring the transport.
      // Otherwise its automatic reconnect can remove the click target first.
      await error.click();
      recover = true;
      await expect(error).toHaveCount(0);
    });
  }
}

test("project terminals survive browser detach and keep multiple tabs", {
  tag: "@cross-browser",
}, async ({ context, page, browserName }) => {
  // Real typing, replay, accessibility analysis, two clients and confirmed
  // serial PTY retirement share this budget; each operation keeps its deadline.
  test.setTimeout(60_000);
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
    const response = await hostRequest(page).get(
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
    await terminalInput.pressSequentially(
      terminalWriteCommand("INSPIRE_TERMINAL_E2E\n"),
    );
    await terminalInput.press("Enter");
    await expect
      .poll(async () => (await readTerminals()).terminals[0]!.nextOutputOffset)
      .toBeGreaterThan(firstTerminal.nextOutputOffset);
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
      const response = await hostRequest(page).delete(
        `/api/terminals/${encodeURIComponent(terminalId)}?force=1`,
        { headers: await terminalMutationHeaders(page) },
      );
      expect(response.ok()).toBe(true);
    }
  }
  await expect.poll(async () => (await readTerminals()).terminals).toEqual([]);
});

test("terminal menus share alignment, mutual exclusion, and nested Escape ownership", async ({
  page,
}) => {
  await page.route(/\/api\/terminals(?:\?|$)/, async (route) => {
    const response = await route.fetch();
    const catalog = await response.json();
    await route.fulfill({
      response,
      json: {
        ...catalog,
        profiles: [
          {
            id: "menu-default",
            label: "Default profile",
            available: true,
            isDefault: true,
          },
          {
            id: "menu-alternate",
            label: "Alternate profile",
            available: true,
            isDefault: false,
          },
        ],
      },
    });
  });
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  const created = await hostRequest(page).post("/api/terminals", {
    headers: await terminalMutationHeaders(page),
    data: { cwd: browserWorkspace },
  });
  expect(created.ok()).toBe(true);
  const terminal = (await created.json()) as { id: string };
  try {
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      if (!(await page.locator(".ctx").count()))
        await page
          .getByRole("button", { name: "Toggle resources panel" })
          .click();
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await page.locator(`#terminal-tab-${terminal.id}`).click();
      await expect(
        page.locator(".terminal-view--active .xterm-helper-textarea"),
      ).toBeVisible();
      await expect(
        page.getByRole("status", { name: "Controlling", exact: true }),
      ).toBeVisible();

      const centers = await page
        .locator(
          ".terminal-tab__label, .terminal-tab__status, .terminal-tab__close, .terminal-tabs__new > .icon-button, .terminal-tabs-shell .terminal-menu > summary, .terminal-view-controls > .icon-button, .terminal-view__keyboard, .terminal-tabs__focus",
        )
        .evaluateAll((controls) =>
          controls
            .filter((control) => control.getClientRects().length > 0)
            .map((control) => {
              const mark = [...control.querySelectorAll("svg")].find(
                (svg) => svg.getBoundingClientRect().width > 0,
              );
              const icon = (mark ?? control).getBoundingClientRect();
              return icon.top + icon.height / 2;
            }),
        );
      expect(centers.length).toBeGreaterThanOrEqual(4);
      expect(Math.max(...centers) - Math.min(...centers)).toBeLessThanOrEqual(
        0.5,
      );

      const tab = page.locator(`#terminal-tab-${terminal.id}`);
      const label = tab.locator(".terminal-tab__label");
      const anchor = await label.boundingBox();
      await tab.dblclick();
      const editor = page.getByRole("textbox", {
        name: "Terminal name",
        exact: true,
      });
      await expect(editor).toBeFocused();
      const editGeometry = await editor.evaluate((el) => {
        const box = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        const shell = el
          .closest(".terminal-tabs-shell")!
          .getBoundingClientRect();
        return {
          x:
            box.left +
            parseFloat(style.borderLeftWidth) +
            parseFloat(style.paddingLeft),
          y: box.y + box.height / 2,
          inside: box.top >= shell.top && box.bottom <= shell.bottom,
        };
      });
      expect(editGeometry.x).toBeCloseTo(anchor!.x, 1);
      expect(editGeometry.y).toBeCloseTo(anchor!.y + anchor!.height / 2, 1);
      expect(editGeometry.inside).toBe(true);
      await editor.press("Escape");
      await expect(tab).toBeVisible();

      const overflowingTargets = await page
        .locator(".terminal-tabs-shell")
        .evaluate((el) => {
          const row = el.getBoundingClientRect();
          return [
            ...el.querySelectorAll(
              ".terminal-tab__close, .icon-button, summary",
            ),
          ]
            .filter((control) => control.checkVisibility())
            .map((control) => {
              const box = control.getBoundingClientRect();
              return {
                name:
                  control.getAttribute("aria-label") ||
                  control.textContent?.trim(),
                top: box.top - row.top,
                bottom: box.bottom - row.bottom,
              };
            })
            .filter((box) => box.top < 0 || box.bottom > 0);
        });
      expect(overflowingTargets).toEqual([]);

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
      await profiles.focus();
      await profiles.press("Enter");
      await expect(openMenus).toHaveCount(1);
      await expect(profiles.locator("..")).toHaveAttribute("open", "");
      await expect(actions.locator("..")).not.toHaveAttribute("open");
      await actions.focus();
      await actions.press("Enter");
      await expect(actions.locator("..")).toHaveAttribute("open", "");
      await expect(profiles.locator("..")).not.toHaveAttribute("open");
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

      const focus = page.getByRole("button", {
        name: "Focus terminal",
        exact: true,
      });
      if (!(await focus.isVisible())) await actions.click();
      await focus.click();
      await expect(page.locator(".terminal-pane--focused")).toBeVisible();
      await page.locator(".xterm-helper-textarea").first().focus();
      // The narrow context drawer owns global shortcuts as a modal. Its
      // existing focus control remains the exit path at every viewport.
      const exit = page.getByRole("button", {
        name: "Exit focused terminal",
        exact: true,
      });
      if (!(await exit.isVisible())) await actions.click();
      await exit.click();
      await expect(page.locator(".terminal-pane--focused")).toHaveCount(0);
      await expect(page.locator(".ctx")).toBeVisible();
      if (width <= 390) {
        await actions.focus();
        await actions.press("Escape");
        await expect(page.locator(".ctx")).toHaveCount(0);
      }
    }
  } finally {
    await hostRequest(page).delete(
      `/api/terminals/${encodeURIComponent(terminal.id)}?force=1`,
      { headers: await terminalMutationHeaders(page) },
    );
  }
});

for (const hasTouch of [false, true]) {
  test.describe(
    hasTouch ? "touch terminal search" : "mouse terminal search",
    () => {
      test.use({ hasTouch });
      test("keeps search and close together without changing keyboard order", async ({
        page,
      }) => {
        await terminalTransportFixture(page, browserWorkspace, [
          "search-layout-terminal",
        ]);
        await pairedPage(page);
        await openMockSession(page, /Review extension event lifecycle/);
        const resources = page.getByRole("button", {
          name: "Toggle resources panel",
          exact: true,
        });
        if ((await resources.getAttribute("aria-expanded")) === "false")
          await resources.click();
        await page
          .getByRole("button", { name: "Terminal", exact: true })
          .click();
        await expect(
          page.getByRole("status", { name: "Controlling", exact: true }),
        ).toBeVisible();
        await page
          .getByRole("button", { name: "Search terminal output", exact: true })
          .click();
        const searchInput = page.getByRole("textbox", {
          name: "Search terminal output",
          exact: true,
        });
        await searchInput.fill("layout");
        for (const width of [1280, 820, 390, 320]) {
          await page.setViewportSize({ width, height: 900 });
          const layout = await page
            .locator(".terminal-search")
            .evaluate((el) => {
              const box = (selector: string) =>
                el.querySelector(selector)!.getBoundingClientRect();
              const field = box("input"),
                close = box(".terminal-search__close");
              const bounds = el.getBoundingClientRect();
              return {
                closeDelta: Math.abs(
                  close.y + close.height / 2 - field.y - field.height / 2,
                ),
                height: bounds.height,
                contained: [...el.children].every((child) => {
                  const r = child.getBoundingClientRect();
                  return (
                    r.left >= bounds.left &&
                    r.right <= bounds.right &&
                    r.top >= bounds.top &&
                    r.bottom <= bounds.bottom
                  );
                }),
              };
            });
          expect(layout.contained).toBe(true);
          expect(layout.closeDelta).toBeLessThanOrEqual(0.5);
          if (hasTouch || width <= 720)
            expect(layout.height).toBeLessThanOrEqual(110);
        }
        await page.setViewportSize({ width: 1280, height: 900 });
        await searchInput.press("Tab");
        await expect(
          page.getByRole("button", { name: "Match case", exact: true }),
        ).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(searchInput).toBeFocused();
      });
    },
  );
}

test.describe("terminal clipboard and focus ownership", () => {
  test.use({ serviceWorkers: "block" });

  for (const platform of ["Win32", "MacIntel"]) {
    test(platform +
      " preserves interrupt, native clipboard and palette focus toggle", {
      tag: "@cross-browser",
    }, async ({ page }) => {
      await page.addInitScript((platform) => {
        Object.defineProperty(navigator, "platform", {
          configurable: true,
          value: platform,
        });
      }, platform);
      const [terminal] = await terminalTransportFixture(
        page,
        browserWorkspace,
        ["clipboard-focus"],
      );
      await pairedPage(page);
      await openMockSession(page, /Review extension event lifecycle/);
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await expect(
        page.getByRole("status", { name: "Controlling", exact: true }),
      ).toBeVisible();
      const input = page.locator(
        ".terminal-view--active .xterm-helper-textarea",
      );
      await input.focus();
      await input.press("Control+c");
      await expect.poll(() => terminal!.inputs.join("")).toBe("\u0003");

      terminal!.write("COPY_ME\r\n");
      // Let the small output frame reach the real canvas renderer before drag.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      const selectOutput = async () => {
        const box = await page
          .locator(".terminal-view--active .xterm-screen")
          .boundingBox();
        if (!box) throw new Error("Terminal screen is unavailable");
        const dimensions = terminal!.resizes.at(-1)!;
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
      const beforeCopy = terminal!.inputs.join("");
      // A platform replay cannot operate the other OS's clipboard. Supply the
      // native clipboard event contract to real xterm with a controlled payload.
      expect(
        await input.evaluate((el, platform) => {
          const down = new KeyboardEvent("keydown", {
            key: "c",
            code: "KeyC",
            keyCode: 67,
            bubbles: true,
            cancelable: true,
            ctrlKey: platform !== "MacIntel",
            metaKey: platform === "MacIntel",
          });
          el.dispatchEvent(down);
          let text = "";
          const copy = new Event("copy", { bubbles: true, cancelable: true });
          Object.defineProperty(copy, "clipboardData", {
            value: {
              setData: (type: string, value: string) => {
                if (type === "text/plain") text = value;
              },
            },
          });
          el.dispatchEvent(copy);
          return { text, prevented: down.defaultPrevented };
        }, platform),
      ).toEqual({ text: "COPY_ME", prevented: false });
      expect(terminal!.inputs.join("")).toBe(beforeCopy);

      if (platform === "MacIntel") {
        await input.press("Control+c");
        await expect
          .poll(() => terminal!.inputs.join(""))
          .toBe(beforeCopy + "\u0003");
        await input.press("Control+v");
        await expect
          .poll(() => terminal!.inputs.join(""))
          .toBe(beforeCopy + "\u0003\u0016");
      }
      const beforePaste = terminal!.inputs.join("");
      const pastePrevented = await input.evaluate((el, platform) => {
        const down = new KeyboardEvent("keydown", {
          key: "v",
          code: "KeyV",
          keyCode: 86,
          bubbles: true,
          cancelable: true,
          ctrlKey: platform !== "MacIntel",
          metaKey: platform === "MacIntel",
        });
        el.dispatchEvent(down);
        const paste = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(paste, "clipboardData", {
          value: {
            getData: (type: string) =>
              type === "text/plain" ? "PASTED_TEXT" : "",
          },
        });
        el.dispatchEvent(paste);
        return down.defaultPrevented;
      }, platform);
      expect(pastePrevented).toBe(false);
      await expect
        .poll(() => terminal!.inputs.join(""))
        .toBe(beforePaste + "PASTED_TEXT");

      const beforePalette = terminal!.inputs.join("");
      for (const focused of [true, false]) {
        await input.focus();
        await page.keyboard.press(
          platform === "MacIntel" ? "Meta+k" : "Control+k",
        );
        const filter = page.getByRole("combobox", { name: "Filter commands" });
        await filter.fill("Toggle terminal focus");
        await filter.press("Enter");
        await expect(
          page.getByRole("dialog", { name: "Command palette" }),
        ).toHaveCount(0);
        await expect(page.locator(".terminal-pane--focused")).toHaveCount(
          focused ? 1 : 0,
        );
      }
      expect(terminal!.inputs.join("")).toBe(beforePalette);
    });
  }
});

test.describe("international terminal keyboard input", () => {
  test.use({ serviceWorkers: "block" });

  for (const platform of ["Win32", "MacIntel"]) {
    test(platform + " preserves native characters and explicit tab chords", {
      tag: "@cross-browser",
    }, async ({ page }) => {
      await page.addInitScript((platform) => {
        Object.defineProperty(navigator, "platform", {
          configurable: true,
          value: platform,
        });
      }, platform);
      const ids = ["international-input", "international-second"];
      const [first] = await terminalTransportFixture(
        page,
        browserWorkspace,
        ids,
      );
      await pairedPage(page);
      await openMockSession(page, /Review extension event lifecycle/);
      await page
        .getByRole("button", { name: "Toggle resources panel" })
        .click();
      await page.getByRole("button", { name: "Terminal", exact: true }).click();
      await expect(
        page.getByRole("status", { name: "Controlling", exact: true }),
      ).toBeVisible();
      const input = page.locator(
        ".terminal-views__item:not([hidden]) .xterm-helper-textarea",
      );
      await input.focus();
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
      await expect.poll(() => first!.inputs.join("")).toBe(character);
      await expect(page.locator("#terminal-tab-" + ids[0])).toHaveAttribute(
        "aria-pressed",
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
        await expect.poll(() => first!.inputs.join("")).toBe("|é");
        await input.press("x");
        await expect.poll(() => first!.inputs.join("")).toBe("|éx");
      }
      const beforeTabs = first!.inputs.join("");
      await input.press("Alt+2");
      // On a real OS this chord is a shortcut only if key remains "2";
      // Playwright's physical chord reports the digit independent of layout.
      await expect(page.locator("#terminal-tab-" + ids[1])).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(first!.inputs.join("")).toBe(beforeTabs);
      await page.locator("#terminal-tab-" + ids[0]).click();
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
        "aria-pressed",
        "true",
      );
      await expect(search).toBeFocused();

      if (platform === "MacIntel") {
        await search.press("Escape");
        await input.evaluate((el) =>
          el.setAttribute("data-keyboard-continuity", "same"),
        );
        const palette = page.getByRole("button", {
          name: "Open command palette",
          exact: true,
        });
        await palette.click();
        const commands = page.getByRole("dialog", { name: "Command palette" });
        await commands.getByLabel("Filter commands").fill("Terminal settings");
        await commands
          .getByRole("option", { name: /Terminal settings/ })
          .click();
        const settings = page.getByRole("dialog", {
          name: "Terminal settings",
          exact: true,
        });
        await settings
          .getByRole("button", { name: "Interaction", exact: true })
          .click();
        const option = settings.getByRole("switch", {
          name: "Use Option as Meta",
        });
        await expect(option).not.toBeChecked();
        await option.locator("..").click();
        await settings
          .getByRole("button", { name: "Close terminal settings" })
          .click();
        await expect(input).toHaveAttribute("data-keyboard-continuity", "same");
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
      }
    });
  }
});

test("terminal search keeps IME keys native before ordinary match navigation", async ({
  page,
}) => {
  const [terminal] = await terminalTransportFixture(page, browserWorkspace, [
    "composition-search",
  ]);
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(
    page.getByRole("status").filter({ hasText: "Controlling" }),
  ).toBeVisible();
  terminal!.write("测量一\r\n测量二\r\n");
  await page
    .getByRole("button", { name: "Search terminal output", exact: true })
    .click();
  const input = page.getByRole("textbox", {
    name: "Search terminal output",
    exact: true,
  });
  const result = page.locator(".terminal-search__count");
  await input.fill("测量");
  await expect(result).toHaveText("1/2");
  for (const ime of [
    { isComposing: true },
    { isComposing: false, keyCode: 229 },
  ]) {
    for (const key of ["Enter", "Escape"]) {
      expect(
        await input.evaluate(
          (el, init) =>
            el.dispatchEvent(
              new KeyboardEvent("keydown", {
                ...init,
                bubbles: true,
                cancelable: true,
              }),
            ),
          { key, ...ime },
        ),
      ).toBe(true);
      await expect(input).toBeFocused();
      await expect(input).toHaveValue("测量");
      await expect(result).toHaveText("1/2");
    }
  }
  await input.press("Enter");
  await expect(result).toHaveText("2/2");
  await input.press("Escape");
  await expect(input).toHaveCount(0);
});

test("compact terminal controls keep selection, search, and output scoped to the active view", async ({
  context,
  page,
}) => {
  const ids = ["compact-terminal-a", "compact-terminal-b"];
  const terminals = await terminalTransportFixture(page, browserWorkspace, ids);
  const firstTerminal = terminals[0]!;
  const secondTerminal = terminals[1]!;
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.evaluate(() =>
    localStorage.setItem(
      "inspire:terminal-ui-settings:v1",
      JSON.stringify({ screenReaderMode: true }),
    ),
  );
  const prompts: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/prompt"
    )
      prompts.push(request.url());
  });
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await page.locator(`#terminal-tab-${ids[0]}`).click();
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
    "fixture$ run\r\n" +
      "\u001b]6973;C1;fixture\u0007TERMINAL_REDESIGN_A\r\n" +
      "\u001b]6973;D;0\u0007fixture$ ",
  );
  await expect(activeView.locator(".xterm-accessibility-tree")).toContainText(
    "TERMINAL_REDESIGN_A",
  );
  await input.evaluate((element) =>
    element.setAttribute("data-continuity", "retained"),
  );
  const dimensions = () => {
    const { cols, rows } = firstTerminal.descriptor;
    return { cols, rows };
  };
  const beforeSearch = dimensions();
  const beforeSearchResizes = firstTerminal.resizes.length;
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
  expect(dimensions()).toEqual(beforeSearch);
  // A newly used font can request another fit without resizing the PTY.
  // Check every reported geometry, not the timing-dependent number of fits.
  expect(
    firstTerminal.resizes
      .slice(beforeSearchResizes)
      .every(
        (size) =>
          size.cols === beforeSearch.cols && size.rows === beforeSearch.rows,
      ),
  ).toBe(true);
  await page.locator(`#terminal-tab-${ids[1]}`).click();
  await expect.poll(() => secondTerminal.resizes.length).toBeGreaterThan(0);
  secondTerminal.write("TERMINAL_REDESIGN_B\r\n");
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
  const beforeSelectionResizes = firstTerminal.resizes.length;
  await more.click();
  await page.getByRole("button", { name: "Select text", exact: true }).click();
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
  expect(dimensions()).toEqual(beforeSearch);
  expect(
    firstTerminal.resizes
      .slice(beforeSelectionResizes)
      .every(
        (size) =>
          size.cols === beforeSearch.cols && size.rows === beforeSearch.rows,
      ),
  ).toBe(true);
  await expect(textOutput).not.toHaveValue(/TERMINAL_REDESIGN_B/);
  await page.evaluate(() => document.fonts.ready);
  await textDialog.evaluate((el) =>
    Promise.allSettled(
      el.getAnimations().map((animation) => animation.finished),
    ),
  );
  const copyActions = textDialog.locator(".terminal-text-dialog__copy-actions");
  const copyGeometry = await actionGeometry(copyActions);
  await textOutput.press("ControlOrMeta+a");
  await expect(
    textDialog.getByRole("button", { name: "Copy selection", exact: true }),
  ).toBeVisible();
  expect(await actionGeometry(copyActions)).toEqual(copyGeometry);
  await textDialog
    .getByRole("button", { name: "Copy selection", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toContain("TERMINAL_REDESIGN_A");
  await expect(
    textDialog.getByRole("button", { name: "Copied", exact: true }),
  ).toBeVisible();
  expect(await actionGeometry(copyActions)).toEqual(copyGeometry);
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
  await more.click();
  await page
    .getByRole("button", { name: "Paste into terminal", exact: true })
    .click();
  await page.locator(`#terminal-tab-${ids[1]}`).click();
  await page.locator(`#terminal-tab-${ids[0]}`).click();
  await deliverPaste("TERMINAL_CLIPBOARD_STALE");
  expect(firstTerminal.inputs).toEqual([]);
  expect(secondTerminal.inputs).toEqual([]);
  await more.click();
  await page
    .getByRole("button", { name: "Paste into terminal", exact: true })
    .click();
  await deliverPaste("TERMINAL_CLIPBOARD_FRESH");
  await expect
    .poll(() => firstTerminal.inputs)
    .toEqual(["TERMINAL_CLIPBOARD_FRESH"]);
  expect(secondTerminal.inputs).toEqual([]);
  await expect(input).toBeFocused();
  await page.evaluate(() =>
    Reflect.deleteProperty(navigator.clipboard, "readText"),
  );

  const accessibility = await new AxeBuilder({ page })
    .include(".terminal-pane")
    .analyze();
  expect(accessibility.violations).toEqual([]);
  // Height-only changes preserve output; a short panel also scrolls its menu.
  const beforeHeight = dimensions();
  const beforeHeightResizes = firstTerminal.resizes.length;
  await page
    .locator(".terminal-pane")
    .evaluate((element) => (element.style.flex = "0 0 280px"));
  await expect.poll(() => dimensions().rows).toBeLessThan(beforeHeight.rows);
  expect(dimensions().cols).toBe(beforeHeight.cols);
  expect(
    firstTerminal.resizes
      .slice(beforeHeightResizes)
      .every(({ cols }) => cols === beforeHeight.cols),
  ).toBe(true);
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

  await more.click();
  await page
    .locator(".terminal-pane")
    .evaluate((element) => element.style.removeProperty("flex"));

  for (const width of [1280, 320]) {
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

    const overflow = await page
      .locator(".terminal-tabs-shell")
      .evaluate((element) => element.scrollWidth - element.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
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
    const response = await hostRequest(page).post("/api/terminals", {
      headers: await terminalMutationHeaders(page),
      data: { cwd: browserWorkspace },
    });
    expect(response.ok()).toBe(true);
    const terminal = (await response.json()) as { id: string };
    try {
      await page.getByRole("button", { name: "Toggle resources panel" }).tap();
      await page.getByRole("button", { name: "Terminal", exact: true }).tap();
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
      for (const width of [320, 390]) {
        await page.setViewportSize({ width, height: 844 });
        const arrows = keys
          .getByRole("group", { name: "Arrow keys", exact: true })
          .getByRole("button");
        for (const arrow of await arrows.all())
          await expect(arrow).toBeInViewport({ ratio: 1 });
        const position = await arrows.first().boundingBox();
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
                return {
                  count: visible.length,
                  complete: visible.every(
                    (rect) =>
                      rect.left >= viewport.left - 1 &&
                      rect.right <= viewport.right + 1,
                  ),
                };
              }),
            )
            .toEqual({ count: width === 320 ? 2 : 3, complete: true });
        };
        await expectCompleteKeys();
        // An arbitrary drag offset must settle on whole keys, not clipped labels.
        await scroll.evaluate((node) => {
          node.scrollLeft += 83;
        });
        await expectCompleteKeys();
        await scroll.evaluate((node) => {
          node.scrollLeft = node.scrollWidth;
        });
        await expect(
          keys.locator(".terminal-touch-keys__extras"),
        ).toHaveAttribute("data-scroll-end", "false");
        await expect(
          keys.getByRole("button", { name: "PgDn", exact: true }),
        ).toBeInViewport({ ratio: 1 });
        await expectCompleteKeys();
        expect(await arrows.first().boundingBox()).toEqual(position);
        await scroll.evaluate((node) => {
          node.scrollLeft = 0;
        });
        await expect(
          keys.locator(".terminal-touch-keys__extras"),
        ).toHaveAttribute("data-scroll-start", "false");
        await expect(
          keys.locator(".terminal-touch-keys__extras"),
        ).toHaveAttribute("data-scroll-end", "true");
      }
      await input.evaluate((node) => node.blur());
      for (const [name, final] of [
        ["Arrow left", "D"],
        ["Arrow up", "A"],
        ["Arrow down", "B"],
        ["Arrow right", "C"],
      ]) {
        await keys.getByRole("button", { name, exact: true }).tap();
        await expect
          .poll(() => inputs.at(-1))
          .toMatch(new RegExp(String.raw`^\x1b(?:\[|O)${final}$`));
        await expect(input).not.toBeFocused();
      }
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
      await keys.getByRole("button", { name: "Arrow down", exact: true }).tap();
      await expect(input).not.toBeFocused();
      await ctrl.tap();
      await page.getByRole("button", { name: "Focus terminal input" }).tap();
      await expect(ctrl).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.insertText("u");
      await expect.poll(() => inputs.at(-1)).toBe("\u0015");

      // Ctrl+U above tests PTY bytes, not cmd.exe's line editing. Clear its
      // pending input using the native shell's own editing key before execution.
      await input.press(process.platform === "win32" ? "Escape" : "Control+u");
      await page.keyboard.insertText(terminalWriteCommand("TOUCH_COPY_中文\n"));
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
              value === "dark" ? "hydrangea" : "chimonanthus";
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
      await hostRequest(page).delete(
        `/api/terminals/${encodeURIComponent(terminal.id)}?force=1`,
        { headers: await terminalMutationHeaders(page) },
      );
    }
  });
});
