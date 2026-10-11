import { expect, test } from "@playwright/test";
import type { ActiveSnapshot, BootstrapPayload } from "../../shared/contracts";
import {
  openCommandPalette,
  openMockSession,
  pairedPage,
} from "./support/navigation";

test("unavailable-project history keeps its reading surface at desktop and phone widths", async ({
  page,
}) => {
  let available = false;
  const availability = (snapshot: ActiveSnapshot) => {
    if (snapshot.active) {
      snapshot.active.readOnlyReason = available
        ? undefined
        : "workspace-unavailable";
      if (!available) snapshot.active.stats = undefined;
    }
    return snapshot;
  };
  // UI projection only: source-admission tests cover the real missing directory,
  // unchanged JSONL, and absence of any Pi/model-discovery process.
  await page.route("**/api/bootstrap**", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const payload = (await response.json()) as BootstrapPayload;
    payload.snapshot = availability(payload.snapshot);
    await route.fulfill({ response, json: payload });
  });
  for (const url of ["**/api/snapshot**", "**/api/sessions/open"]) {
    await page.route(url, async (route) => {
      const response = await route.fetch();
      if (!response.ok()) return route.fulfill({ response });
      await route.fulfill({
        response,
        json: availability(await response.json()),
      });
    });
  }

  await page.routeWebSocket("**/events**", (client) => {
    const upstream = client.connectToServer();
    upstream.onMessage((message) => {
      const event = JSON.parse(String(message));
      if (event.type === "snapshot" && event.data)
        event.data = availability(event.data);
      client.send(JSON.stringify(event));
    });
  });

  await page.setViewportSize({ width: 1280, height: 900 });
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  const note = page.getByText(
    "Project folder unavailable. This session is read-only.",
  );
  await expect(note).toBeVisible();
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator(".topbar__title-button")).toBeDisabled();

  const palette = await openCommandPalette(page);
  await palette.getByLabel("Filter commands").fill("history");
  await palette.getByRole("option", { name: /Open History/ }).click();
  await expect(
    page.getByRole("searchbox", { name: "Find in history" }),
  ).toBeVisible();
  await expect(page.locator(".history-outline")).toContainText(
    "Show me a formula-rich example",
  );

  const usagePalette = await openCommandPalette(page);
  await usagePalette.getByLabel("Filter commands").fill("/session");
  await usagePalette.getByRole("option", { name: /Session & usage/ }).click();
  await expect(
    page.getByText("Usage information is unavailable."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Dismiss /session result" }).click();

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    if (width === 390) {
      const context = page.getByRole("dialog", { name: "Context panel" });
      await expect(context).toBeVisible();
      await context.getByRole("button", { name: "Close context pane" }).click();
      await expect(context).toHaveCount(0);
    }
    await expect(note).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
  }

  available = true;
  await openMockSession(page, /Review extension event lifecycle/);
  await expect(note).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toBeVisible();
});
