import { expect, type Page, test } from "@playwright/test";
import type { HostUpdateStatus } from "../../shared/contracts";
import {
  type HostRestartRequest,
  type HostRestartStatus,
  restartObservation,
} from "../../shared/host-restart";
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
    allPiAvailable: false,
    allPiReason: "Restart all requires installed Linux systemd services.",
    operation: null,
  });
  const ready = readyStatus();
  let status: HostRestartStatus = {
    ...ready,
    available: false,
    reason: "Installed service required.",
  };
  const submitted: HostRestartRequest[] = [];
  const statusReady = Promise.withResolvers<void>();
  const receiptReady = Promise.withResolvers<void>();
  await page.route("**/api/host/restart", async (route) => {
    if (route.request().method() === "GET") {
      await statusReady.promise;
      return route.fulfill({ json: status });
    }
    expect(route.request().method()).toBe("POST");
    const request = route.request().postDataJSON() as HostRestartRequest;
    submitted.push(request);
    const attempt = {
      id: request.operationId,
      scope: request.scope,
      interruptWork: request.interruptWork,
    };
    let operation: NonNullable<HostRestartStatus["operation"]>;
    if (submitted.length === 1)
      operation = {
        ...attempt,
        phase: "rejected",
        busyReason: "restart-pending",
        error: "Restart unavailable",
      };
    else if (submitted.length === 2)
      operation = {
        ...attempt,
        phase: "rejected",
        busyReason: "in-flight-operation",
        error: "A request is still in progress",
      };
    else if (submitted.length === 3)
      operation = {
        ...attempt,
        phase: "rejected",
        stopUnconfirmed: true,
        error: "Could not confirm Stop for session A",
      };
    else if (submitted.length === 4) return route.abort("failed");
    else {
      await receiptReady.promise;
      operation = {
        ...attempt,
        phase: "submitted",
        skipAttachedStop: request.skipAttachedStop,
      };
    }
    status = { ...status, operation };
    await route.fulfill({ json: restartObservation(request, operation) });
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
      name: "Restart",
      exact: true,
    });
    const all = settings.getByRole("button", {
      name: "Restart all",
      exact: true,
    });
    const force = settings.getByRole("button", {
      name: "Stop work and restart",
      exact: true,
    });
    const retry = row.getByRole("button", { name: "Retry same request" });
    await expect(restart).toBeDisabled();
    await expect(all).toBeDisabled();
    await expect(row.getByRole("status")).toHaveCount(0);
    statusReady.resolve();
    await expect(
      settings.getByText("Installed service required."),
    ).toBeVisible();
    await expect(restart).toBeDisabled();
    await expect(all).toBeDisabled();
    status = ready;
    await expect(restart).toBeEnabled();
    await expect(settings.getByText(ready.allPiReason!)).toBeVisible();
    await expect(all).toBeDisabled();
    const before = (await row.boundingBox())!.height;
    const stable = async (phase: string) =>
      expect((await row.boundingBox())!.height, phase).toBeCloseTo(before, 1);

    const confirmRestart = async () => {
      await restart.click();
      await dialog
        .getByRole("button", { name: "Restart", exact: true })
        .click();
    };
    await confirmRestart();
    await expect(row.getByRole("alert")).toHaveText(
      "Last restart attempt: Restart unavailable",
    );
    await expect(force).toHaveCount(0);
    await confirmRestart();
    await expect(force).toBeVisible();
    const idleAttempt = submitted.at(-1)!;
    expect(idleAttempt.scope).toBe("host");
    expect(idleAttempt.interruptWork).toBeUndefined();
    await stable("busy");

    await force.click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(() => submitted.at(-1)?.interruptWork).toBe(true);
    expect(submitted.at(-1)).toMatchObject({
      scope: "host",
      hostId: idleAttempt.hostId,
    });
    expect(submitted.at(-1)?.operationId).not.toBe(idleAttempt.operationId);
    await expect(row.getByRole("alert")).toContainText("session A");

    const anyway = settings.getByRole("button", {
      name: "Restart anyway",
      exact: true,
    });
    await anyway.click();
    await expect(retry).toBeVisible();
    const unconfirmed = submitted.at(-1)!;
    expect(unconfirmed).toMatchObject({
      hostId: ready.hostId,
      scope: "host",
      interruptWork: true,
      skipAttachedStop: true,
    });
    await expect(anyway).toBeDisabled();
    await retry.click();
    await expect(message).toHaveText("Preparing restart…");
    await expect.poll(() => submitted.length).toBe(5);
    expect(submitted.at(-1)).toEqual(unconfirmed);
    await stable("sending");

    receiptReady.resolve();
    await expect(message).toHaveText("Restart requested.");
    await expect(retry).toHaveCount(0);
    await stable("submitted");

    status = readyStatus();
    await row.getByRole("button", { name: "Recheck status" }).click();
    await expect(message).toHaveText("Host reconnected.");
    await expect(restart).toBeEnabled();
    await stable("reconnected");
  } finally {
    statusReady.resolve();
    receiptReady.resolve();
  }
  expect(submitted).toHaveLength(5);
});

test("Restart all previews the current Herdr scope and submits only after confirmation", async ({
  page,
}) => {
  const status: HostRestartStatus = {
    hostId: crypto.randomUUID(),
    available: true,
    allPiAvailable: true,
    allPiIncludesHerdr: false,
    operation: null,
  };
  const submitted: HostRestartRequest[] = [];
  await page.route("**/api/host/restart", async (route) => {
    if (route.request().method() === "GET")
      return route.fulfill({ json: status });
    const request = route.request().postDataJSON() as HostRestartRequest;
    submitted.push(request);
    status.operation = {
      id: request.operationId,
      scope: request.scope,
      interruptWork: true,
      phase: "submitted",
    };
    return route.fulfill({
      json: restartObservation(request, status.operation),
    });
  });
  await pairedPage(page);
  const settings = await openSystemSettings(page);
  const restart = settings.getByRole("button", {
    name: "Restart all",
    exact: true,
  });
  const dialog = page.getByRole("alertdialog", { name: "Restart all?" });
  await restart.click();
  await expect(dialog).toContainText(
    "Your Pi sessions outside Herdr will close.",
  );
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(submitted).toHaveLength(0);

  status.allPiIncludesHerdr = true;
  await expect(
    settings.getByText("Close all Pi sessions and restart Inspire.", {
      exact: true,
    }),
  ).toBeVisible();
  await restart.click();
  await expect(dialog).toContainText(
    "All your Pi sessions, including Herdr sessions, will close.",
  );
  await expect(dialog).toContainText(
    "Project terminals will close and running tasks will stop.",
  );
  await dialog
    .getByRole("button", { name: "Restart all", exact: true })
    .click();
  await expect(settings.locator(".host-restart__status")).toHaveText(
    "Restart requested.",
  );
  expect(submitted).toEqual([
    expect.objectContaining({
      scope: "all-pi",
      interruptWork: true,
      hostId: status.hostId,
    }),
  ]);
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
        const bounds = (await settings
          .locator(".dialog.settings")
          .boundingBox())!;
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

test("narrow Settings keeps footer actions usable and preserves preferences after a cancelled reset", async ({
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
  const footer = dialog.locator(".settings__footer");
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
  const send = dialog.getByRole("group", { name: "Send key", exact: true });
  expect(await send.evaluate(textOverflowsInlineBounds)).toBe(false);
  await reset.click();
  await savePreference(() => confirm.click());
  const activity = dialog.getByRole("combobox", { name: "Activity groups" });
  await savePreference(async () => {
    await activity.selectOption("collapsed");
  });
  await page.reload();
  await openConversation();
  await expect(activity).toHaveValue("collapsed");

  await reset.click();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(reset).toBeFocused();
  await expect(activity).toHaveValue("collapsed");
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
