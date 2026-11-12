import { expect, type Page, test } from "@playwright/test";
import type { HostUpdateStatus } from "../../shared/contracts";
import type {
  HostRestartRequest,
  HostRestartStatus,
} from "../../shared/host-restart";
import { modelSettingsScenario } from "./fixtures/model-settings";
import { clipboardLines } from "./support/clipboard";
import { focusRingClipping } from "./support/focus-bounds";
import { routeSnapshots } from "./support/host-events";
import { openSettings, pairAndOpen, pairedPage } from "./support/navigation";
import { textMarkOffsets } from "./support/text-baseline";
import { textOverflowsInlineBounds } from "./support/text-bounds";

// These suites own mocked Host responses, not Service Worker fetch handling.
test.use({ serviceWorkers: "block" });

async function openSystemSettings(page: Page) {
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings
    .getByRole("navigation", { name: "Settings categories" })
    .getByRole("button", { name: "System", exact: true })
    .click();
  return settings;
}

test("narrow System keeps update actions stable and copies details while snoozed", {
  tag: "@platform-ui",
}, async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  let status: HostUpdateStatus = {
    revision: 10_000,
    piUpdateCheck: null,
    inspireUpdateCheck: null,
    piUpdateChecking: false,
    inspireUpdateChecking: false,
    availableUpdateIdentity: null,
    updateSnoozedUntil: Date.now() + 3_600_000,
  };
  await routeSnapshots(page, {
    bootstrap: (body) => {
      body.updateStatus = status;
    },
  });
  const responseReady = Promise.withResolvers<void>();
  await page.route(/\/api\/(?:pi-)?update\?refresh=1$/, async (route) => {
    await responseReady.promise;
    await route.fulfill({ json: { updateStatus: status } });
  });
  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  const versions = (await openSystemSettings(page)).getByRole("region", {
    name: "Versions",
    exact: true,
  });
  const check = versions.getByRole("button", { name: "Check for updates" });
  const label = check.locator(".system-versions__check-label");
  await page.evaluate(() => document.fonts.ready);

  try {
    await expect(label).toHaveText("Check updates");
    const before = (await check.boundingBox())!;
    const expectStableAction = async (text: string) => {
      await expect(label).toHaveText(text);
      const after = (await check.boundingBox())!;
      for (const key of ["x", "y", "width", "height"] as const)
        expect(after[key], `${text} / ${key}`).toBeCloseTo(before[key], 1);
    };
    await check.click();
    await expectStableAction("Checking…");
    status = {
      ...status,
      revision: status.revision + 1,
      piUpdateCheck: {
        currentVersion: "1.0.0",
        installedVersion: "1.0.1",
        pi: {
          kind: "available",
          latestVersion: "1.0.2",
          releaseUrl: "https://example.invalid/pi",
        },
        extensions: { kind: "none" },
      },
      inspireUpdateCheck: { kind: "unreleased" },
      availableUpdateIdentity: JSON.stringify([["pi", "1.0.2"]]),
    };
    responseReady.resolve();
    await expectStableAction("Check again");
    await expect(versions.getByText("Restart Host to apply")).toBeVisible();
    const copy = versions.getByRole("button", { name: "Copy update details" });
    await copy.focus();
    await copy.press("Enter");
    await expect(
      versions.getByRole("button", { name: "Update details copied" }),
    ).toBeVisible();
    await expect
      .poll(() => clipboardLines(page))
      .toEqual([
        "Pi 1.0.1 → 1.0.2",
        "Run pi update",
        "https://example.invalid/pi",
      ]);
  } finally {
    responseReady.resolve();
  }
});

test("busy Host restarts submit directly and keep narrow status stable", async ({
  page,
}) => {
  const readyStatus = (): HostRestartStatus => ({
    hostId: crypto.randomUUID(),
    available: true,
    allAvailable: true,
    operation: null,
  });
  let status = readyStatus();
  const submitted: HostRestartRequest[] = [];
  const receiptReady = Promise.withResolvers<void>();
  await page.route("**/api/host/restart", async (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({ json: status });
    }
    expect(route.request().method()).toBe("POST");
    const request = route.request().postDataJSON() as HostRestartRequest;
    submitted.push(request);
    const operation = {
      id: request.operationId,
      scope: request.scope,
      ...(request.interruptWork
        ? { phase: "submitted" as const, interruptWork: true as const }
        : {
            phase: "rejected" as const,
            busyReason: "in-flight-operation" as const,
            error:
              "Finish Pi work and pending operations before restarting, or choose Stop work and restart.",
          }),
    };
    if (request.interruptWork) await receiptReady.promise;
    status = { ...status, operation };
    await route.fulfill({ json: operation });
  });

  await page.setViewportSize({ width: 320, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  const settings = await openSystemSettings(page);
  const row = settings.locator(".host-restart__status-row");
  const message = row.locator(".host-restart__status");
  const dialog = page.getByRole("alertdialog");
  await expect(row).toBeVisible();
  await page.evaluate(() => document.fonts.ready);

  try {
    const restart = settings.getByRole("button", {
      name: "Restart all",
      exact: true,
    });
    await expect(restart).toBeEnabled();
    const before = (await row.boundingBox())!.height;
    const stable = async (phase: string) =>
      expect((await row.boundingBox())!.height, phase).toBeCloseTo(before, 1);

    await restart.click();
    await dialog.getByRole("button", { name: "Restart all" }).click();
    const force = settings.getByRole("button", {
      name: "Stop work and restart all",
      exact: true,
    });
    await expect(force).toBeVisible();
    const idleAttempt = submitted.at(-1)!;
    expect(idleAttempt.scope).toBe("all");
    expect(idleAttempt.interruptWork).toBeUndefined();
    await stable("busy");

    await force.click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => submitted.at(-1)?.interruptWork).toBe(true);
    expect(submitted.at(-1)).toMatchObject({
      scope: "all",
      hostId: idleAttempt.hostId,
    });
    expect(submitted.at(-1)?.operationId).not.toBe(idleAttempt.operationId);
    await expect(message).toHaveText("Preparing restart…");
    await stable("sending");

    receiptReady.resolve();
    await expect(message).toHaveText("Restart requested.");
    await stable("submitted");

    status = readyStatus();
    await row.getByRole("button", { name: "Recheck status" }).click();
    await expect(message).toHaveText("Host reconnected.");
    await expect(restart).toBeEnabled();
    await stable("reconnected");
  } finally {
    receiptReady.resolve();
  }
  expect(submitted).toHaveLength(2);
});

test("selected Settings categories remain visible across responsive layouts without trapping manual navigation scrolling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1366, height: 768 });
  await pairAndOpen(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const navigation = settings.getByRole("navigation", {
    name: "Settings categories",
  });
  await navigation.getByRole("button", { name: "System", exact: true }).click();
  for (const [width, height] of [
    [320, 640],
    [844, 390],
    [1366, 768],
  ]) {
    await page.setViewportSize({ width, height });
    const safe =
      width === 844
        ? { left: 44, right: 44, bottom: 21 }
        : { left: 0, right: 0, bottom: 0 };
    await page.evaluate((safe) => {
      for (const [edge, value] of Object.entries(safe))
        document.documentElement.style.setProperty(
          `--safe-${edge}`,
          `${value}px`,
        );
    }, safe);
    await expect
      .poll(async () => {
        const bounds = (await settings.boundingBox())!;
        return Math.max(
          safe.left - bounds.x,
          bounds.x + bounds.width - (width - safe.right),
          bounds.y + bounds.height - (height - safe.bottom),
        );
      })
      .toBeLessThanOrEqual(0.5);
    const active = navigation.locator('[aria-current="location"]');
    await expect(active).toHaveText("System");
    await expect
      .poll(() =>
        active.evaluate((element) => {
          const item = element.getBoundingClientRect();
          const strip = element.closest("nav")!;
          const viewport = strip.getBoundingClientRect();
          const label = element
            .querySelector(".settings__nav-label")!
            .getBoundingClientRect();
          const fade = getComputedStyle(strip).maskImage === "none" ? 0 : 16;
          return Math.max(
            viewport.left - item.left,
            item.right - viewport.right,
            viewport.top - item.top,
            item.bottom - viewport.bottom,
            viewport.left + fade - label.left,
            label.right + fade - viewport.right,
            0,
          );
        }),
      )
      .toBeLessThanOrEqual(0.5);
  }
  // Browsing the category strip deliberately must not fight an active-item loop.
  await page.setViewportSize({ width: 320, height: 640 });
  await expect
    .poll(() => navigation.evaluate((el) => el.scrollLeft))
    .toBeGreaterThan(0);
  const content = settings.locator(".settings__content");
  await content.evaluate((el) => {
    el.scrollTop = 8;
  });
  await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBe(8);
  await page.setViewportSize({ width: 390, height: 640 });
  await expect.poll(() => content.evaluate((el) => el.scrollTop)).toBe(8);
  await navigation.evaluate((el) => {
    el.scrollLeft = 0;
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect
    .poll(() => navigation.evaluate((el) => el.scrollLeft))
    .toBeLessThanOrEqual(0.5);
  await navigation
    .getByRole("button", { name: "Display", exact: true })
    .click();
  await expect(
    navigation.getByRole("button", { name: "Display", exact: true }),
  ).toHaveAttribute("aria-current", "location");
  const heading = settings.getByRole("heading", {
    name: "Display",
    exact: true,
  });
  await expect(heading).toHaveCSS("font-family", /IBM Plex Sans SC/);
  await expect(settings.locator(".settings__field-label").first()).toHaveCSS(
    "font-family",
    /IBM Plex Sans SC/,
  );
  await page.evaluate(() => document.fonts.ready);
  const [offset] = await heading.locator("..").evaluate(textMarkOffsets, {
    label: ".settings__section-title",
    marks: ".settings__section-icon",
  });
  expect(Math.abs(offset!)).toBeLessThan(0.5);

  const system = navigation.getByRole("button", {
    name: "System",
    exact: true,
  });
  await system.focus();
  await expect(system).toBeInViewport();
  await expect
    .poll(() => system.evaluate(focusRingClipping))
    .toBeLessThanOrEqual(0.5);
  await system.press("Enter");
  await expect(system).toBeFocused();
  await expect(system).toHaveAttribute("aria-current", "location");
  await expect(
    settings.getByRole("region", { name: "Versions" }),
  ).toBeInViewport();
});

test("Settings dropdown escapes the scroller, separates hover from keyboard selection, and closes when clipped", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 460 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "Behavior", exact: true }).click();
  await page.evaluate(() => document.fonts.ready);
  const trigger = settings.getByRole("combobox", {
    name: "On launch",
    exact: true,
  });
  const content = settings.locator(".settings__content");
  // Leave viewport room beyond the scroller so the menu must escape its clip.
  await trigger.evaluate((el) => {
    const content = el.closest<HTMLElement>(".settings__content")!;
    const height =
      el.getBoundingClientRect().bottom - content.getBoundingClientRect().top;
    content.style.maxHeight = `${height + 12}px`;
  });
  expect(
    await content.evaluate((el) => el.scrollHeight > el.clientHeight),
  ).toBe(true);
  await trigger.click();
  const menu = page.getByRole("listbox", {
    name: "On launch",
    exact: true,
  });
  const last = menu.getByRole("option").last();
  await expect(menu).toBeVisible();
  const clipBounds = (await content.boundingBox())!;
  const menuBounds = (await menu.boundingBox())!;
  expect(
    menuBounds.y < clipBounds.y ||
      menuBounds.y + menuBounds.height > clipBounds.y + clipBounds.height,
  ).toBe(true);
  await last.hover({ trial: true });
  await expect(trigger).toBeFocused();
  const first = menu.getByRole("option").first();
  const active = await first.getAttribute("id");
  expect(active).toBeTruthy();
  await last.hover();
  await trigger.press("Home");
  await expect(trigger).toHaveAttribute("aria-activedescendant", active!);
  await trigger.press("Escape");
  await expect(menu).toHaveCount(0);
  await content.evaluate((el) => el.style.removeProperty("max-height"));

  await trigger.click();
  const bounds = (await content.boundingBox())!;
  await page.mouse.move(bounds.x + 72, bounds.y + 206);
  await page.mouse.wheel(0, 40);
  await expect
    .poll(() => content.evaluate((el) => el.scrollTop))
    .toBeGreaterThan(0);
  await expect(menu).toBeVisible();
  await page.mouse.wheel(0, 85);
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test("category switches retain model search and a login arriving while hidden", async ({
  page,
}) => {
  const scenario = await modelSettingsScenario(page);
  let releaseLogin!: () => void;
  const loginResponse = new Promise<void>((resolve) => {
    releaseLogin = resolve;
  });
  await page.route("**/api/provider-auth**", async (route) => {
    if (route.request().postDataJSON().operation === "start")
      await loginResponse;
    await route.fallback();
  });
  await pairAndOpen(page);
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const nav = settings.getByRole("navigation", { name: "Settings categories" });
  await nav.getByRole("button", { name: "Models", exact: true }).click();
  const grid = settings.getByRole("grid", { name: "Available models" });
  await expect(grid.getByRole("row").first()).toBeVisible();
  const search = settings.getByRole("combobox", {
    name: "Search available models",
  });
  const query = scenario.snapshot().models[0]!.id;
  await search.fill(query);
  await expect(grid.getByRole("row").first()).toBeVisible();

  const credentials = settings.getByRole("region", {
    name: "Login & API keys",
  });
  await credentials
    .getByRole("button", { name: "Manage Anthropic", exact: true })
    .click();
  await credentials
    .getByRole("button", { name: "Anthropic API key", exact: true })
    .click();
  const display = nav.getByRole("button", { name: "Display", exact: true });
  await display.click();
  const loginArrived = page.waitForResponse("**/api/provider-auth**");
  releaseLogin();
  expect((await loginArrived).ok()).toBe(true);
  await expect(display).toBeFocused();
  await expect(
    settings.getByRole("textbox", { name: "API key", exact: true }),
  ).toHaveCount(0);
  await nav.getByRole("button", { name: "Models", exact: true }).click();
  await expect(search).toHaveValue(query);

  const secret = credentials.getByLabel("API key", { exact: true });
  await secret.fill("SYNTHETIC_CATEGORY_KEY");
  await nav.getByRole("button", { name: "Conversation", exact: true }).click();
  await nav.getByRole("button", { name: "Models", exact: true }).click();
  await expect(secret).toHaveValue("SYNTHETIC_CATEGORY_KEY");
  await credentials
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(
    credentials.getByText("Login complete.", { exact: true }),
  ).toBeVisible();
  expect(
    scenario.authOperations.filter(
      (operation) => operation.operation === "start",
    ),
  ).toHaveLength(1);
  expect(
    scenario.authOperations.some(
      (operation) => operation.operation === "cancel",
    ),
  ).toBe(false);

  expect(scenario.errors).toEqual([]);
});

test("narrow Conversation settings persist preferences and restore focus when reset is cancelled", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await pairedPage(page);
  const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
  const openConversation = async () => {
    await openSettings(page);
    await dialog
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
  };
  const confirmation = page.getByRole("alertdialog", {
    name: "Reset preferences?",
  });
  const reset = dialog.getByRole("button", {
    name: "Reset preferences",
    exact: true,
  });
  const confirm = confirmation.getByRole("button", {
    name: "Reset preferences",
    exact: true,
  });
  const savePreference = async (action: () => Promise<void>) => {
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/preferences") &&
        response.request().method() === "PATCH",
    );
    await action();
    expect((await saved).ok()).toBe(true);
  };
  await openConversation();
  const send = dialog.getByRole("group", { name: "Send key", exact: true });
  expect(await send.evaluate(textOverflowsInlineBounds)).toBe(false);
  await reset.click();
  await savePreference(() => confirm.click());
  const activity = dialog.getByRole("combobox", { name: "Activity groups" });
  await activity.click();
  const choices = page.getByRole("listbox", { name: "Activity groups" });
  await savePreference(() =>
    choices.getByRole("option", { name: /Collapsed/ }).click(),
  );
  await page.reload();
  await openConversation();
  await expect(activity).toHaveText("Collapsed");

  await reset.click();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(reset).toBeFocused();
  await expect(activity).toHaveText("Collapsed");
  await reset.click();
  await savePreference(() => confirm.click());
});

test("long Herdr diagnostics leave availability recheck usable", {
  tag: "@platform-ui",
}, async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const diagnostic =
    "无法连接校准工作区 /run/user/1000/herdr/instrument_calibration_reference_acquisition_control.sock，请重新检查安装。";
  let issue = "Herdr is unavailable on this Host.";
  await page.route("**/api/host/herdr", (route) =>
    route.fulfill({
      json: {
        enabled: false,
        ready: false,
        supported: true,
        installed: true,
        running: false,
        compatible: true,
        version: "1.0.0",
        issue,
      },
    }),
  );
  await pairedPage(page);
  const settings = await openSystemSettings(page);
  await expect(settings.getByText(issue, { exact: true })).toBeVisible();
  issue = diagnostic;
  const recheck = settings.getByRole("button", {
    name: "Recheck availability",
  });
  await recheck.click();
  const status = settings.getByText(diagnostic, { exact: true });
  await expect(status).toBeVisible();
  expect(await status.evaluate(textOverflowsInlineBounds)).toBe(false);
  await recheck.click({ trial: true });
});

test("fits installation, status and reset inside the narrow footer", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openSettings(page);
  const footer = page
    .getByRole("dialog", { name: "Settings", exact: true })
    .locator(".settings__footer");
  await expect(
    footer.getByRole("button", { name: "Reset preferences" }),
  ).toBeVisible();
  await page.evaluate(() => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    Object.assign(event, {
      prompt: () => Promise.resolve(),
      userChoice: Promise.resolve({ outcome: "dismissed" }),
    });
    window.dispatchEvent(event);
  });
  await page.evaluate(() => document.fonts.ready);
  for (const name of ["Install app", "Reset preferences"]) {
    const action = footer.getByRole("button", { name, exact: true });
    await expect(action).toBeInViewport({ ratio: 1 });
    await action.focus();
    expect(await action.evaluate(focusRingClipping)).toBeLessThanOrEqual(0.5);
    expect(await action.evaluate(textOverflowsInlineBounds)).toBe(false);
  }
  await page.evaluate(() => {
    const matchMedia = window.matchMedia.bind(window);
    window.matchMedia = (query) => {
      const result = matchMedia(query);
      if (query === "(display-mode: standalone)")
        Object.defineProperty(result, "matches", { value: true });
      return result;
    };
    window.dispatchEvent(new Event("appinstalled"));
  });
  const installed = footer.getByText("App installed", { exact: true });
  await expect(installed).toBeVisible();
  await expect(footer.getByRole("button", { name: "Install app" })).toHaveCount(
    0,
  );
  expect(await installed.evaluate(textOverflowsInlineBounds)).toBe(false);
});
