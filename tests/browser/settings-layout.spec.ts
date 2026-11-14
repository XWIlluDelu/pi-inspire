import { expect, type Page, test } from "@playwright/test";
import {
  type HostRestartRequest,
  type HostRestartStatus,
  restartObservation,
} from "../../shared/host-restart";
import { openSettings, pairAndOpen, pairedPage } from "./support/navigation";

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

test("busy Host restarts preserve the interruption grant across receipt retry", async ({
  page,
}) => {
  const ready: HostRestartStatus = {
    hostId: crypto.randomUUID(),
    available: true,
    allPiAvailable: false,
    allPiReason: "Restart all requires installed Linux systemd services.",
    operation: null,
  };
  const submitted: HostRestartRequest[] = [];
  let status: HostRestartStatus = ready;
  const receiptReady = Promise.withResolvers<void>();
  await page.route("**/api/host/restart", async (route) => {
    if (route.request().method() === "GET") {
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
    const faults = [
      {
        busyReason: "in-flight-operation",
        error: "A request is still in progress",
      },
      { stopUnconfirmed: true, error: "Could not confirm Stop for session A" },
    ] as const;
    if (submitted.length === 3) return route.abort("failed");
    const fault = faults[submitted.length - 1];
    if (!fault) await receiptReady.promise;
    const operation: NonNullable<HostRestartStatus["operation"]> = fault
      ? { ...attempt, ...fault, phase: "rejected" }
      : {
          ...attempt,
          phase: "submitted",
          skipAttachedStop: request.skipAttachedStop,
        };
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
    await expect(restart).toBeEnabled();
    await expect(settings.getByText(ready.allPiReason!)).toBeVisible();
    await expect(all).toBeDisabled();

    const confirmRestart = async () => {
      await restart.click();
      await dialog
        .getByRole("button", { name: "Restart", exact: true })
        .click();
    };
    await confirmRestart();
    await expect(force).toBeVisible();
    const idleAttempt = submitted.at(-1)!;
    expect(idleAttempt.scope).toBe("host");
    expect(idleAttempt.interruptWork).toBeUndefined();

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
    await expect.poll(() => submitted.length).toBe(4);
    expect(submitted.at(-1)).toEqual(unconfirmed);

    receiptReady.resolve();
    await expect(message).toHaveText("Restart requested.");
    await expect(retry).toHaveCount(0);

  } finally {
    receiptReady.resolve();
  }
  expect(submitted).toHaveLength(4);
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

test("narrow Settings keeps footer actions usable after a cancelled reset", async ({
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
  await expect(reset).toBeInViewport();
  const activity = dialog.getByRole("combobox", { name: "Activity groups" });
  await savePreference(() => activity.selectOption("collapsed"));

  await reset.click();
  await page.keyboard.press("Escape");
  await expect(confirmation).toBeHidden();
  await expect(reset).toBeFocused();
  await expect(activity).toHaveValue("collapsed");
  await reset.click();
  await savePreference(() => confirm.click());
});
