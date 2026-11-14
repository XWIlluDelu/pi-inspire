import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { renderedColors } from "./support/colors";
import { hostRequest } from "./support/host-request";
import {
  openCommandPalette,
  openFixtureSession,
  openSettings,
  pairedPage,
  reloadSession,
} from "./support/navigation";
import { textOverflowsInlineBounds } from "./support/text-bounds";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });

const draft = "Keep the unfinished comparison";

test("a failed clone leaves its action menu available instead of silently dismissing it", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  let attempts = 0;
  await page.route("**/api/branches/clone", (route) => {
    attempts++;
    return route.fulfill({
      status: 503,
      json: { error: "Clone is unavailable" },
    });
  });
  await page.getByRole("button", { name: /^Session actions:/ }).click();
  const menu = page.getByRole("menu", { name: "Session actions" });
  const clone = menu.getByRole("menuitem", {
    name: "Clone current branch",
    exact: true,
  });
  await expect(clone).toBeEnabled();
  await clone.click();
  await expect(menu).toBeVisible();
  await expect(
    page.getByRole("status").filter({ hasText: "Clone is unavailable" }),
  ).toBeVisible();
  await expect(clone).toBeEnabled();
  expect(attempts).toBe(1);
  await clone.click();
  await expect.poll(() => attempts).toBe(2);
  await expect(menu).toBeVisible();
});

async function namedSession(page: Page, withConversation = false) {
  await pairedPage(page);
  const response = await hostRequest(page).post("/api/sessions/new", {
    data: {
      cwd: browserWorkspace,
      name: "Calibration notes for this session with a long title covering model selection, tool execution, and follow-up analysis",
    },
  });
  expect(response.ok()).toBe(true);
  const sessionId = (await response.json()).active.sessionId;
  if (withConversation) {
    const bootstrap = await (
      await hostRequest(page).get("/api/bootstrap")
    ).json();
    const accepted = await hostRequest(page).post("/api/prompt", {
      data: {
        sessionId,
        message: "Save a conversation for the native export.",
        operationId: randomUUID(),
        authorityId: bootstrap.authorityId,
      },
    });
    expect(accepted.ok()).toBe(true);
    await expect
      .poll(async () => {
        const snapshot = await hostRequest(page).get(
          `/api/snapshot?detail=${sessionId}`,
        );
        return (await snapshot.json()).sessionStatuses[sessionId]?.runState;
      })
      .toBe("idle");
  }
  await reloadSession(page, sessionId);
  const title = page.getByRole("button", { name: /^Session actions:/ });
  await expect(title).toContainText("Calibration notes");
  const composer = page.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  await composer.fill(draft);
  return { title, composer, sessionId };
}
test.describe("phone session actions", () => {
  test.use({ viewport: { width: 320, height: 740 }, hasTouch: true });

  test("uses saved action order and preserves IME, clipboard and newer name edits", async ({
    page,
    context,
  }) => {
    const { title, composer, sessionId } = await namedSession(page);
    const host = hostRequest(page);
    const savedOrder = async () =>
      (await (await host.get("/api/preferences")).json()).preferences
        .sessionActionOrder;
    const original = await savedOrder();
    const response = Promise.withResolvers<void>();
    try {
      await host.patch("/api/preferences", {
        data: {
          sessionActionOrder: [
            "rename",
            "copy-id",
            "clone",
            "switch-branch",
            "export",
          ],
        },
      });
      await page.reload();
      await openSettings(page);
      await page.getByRole("button", { name: "Behavior", exact: true }).tap();
      await page.getByRole("button", { name: "Move Export session… up" }).tap();
      await expect
        .poll(savedOrder)
        .toEqual(["rename", "copy-id", "clone", "export", "switch-branch"]);

      await page.reload();
      await context.grantPermissions(["clipboard-read", "clipboard-write"]);
      await title.press("Enter");
      const menu = page.getByRole("menu", { name: "Session actions" });
      const rename = menu.getByRole("menuitem", { name: "Rename session" });
      await expect(rename).toBeFocused();
      await expect(menu.getByRole("menuitem")).toHaveText([
        "Rename session",
        "Copy session ID",
        "Clone current branch",
        "Export session…",
        "Switch branch…",
      ]);
      const bounds = await menu.boundingBox();
      await menu.getByRole("menuitem", { name: "Copy session ID" }).tap();
      await expect(
        menu.getByRole("menuitem", { name: "ID copied" }),
      ).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        sessionId,
      );
      const copiedBounds = await menu.boundingBox();
      expect(copiedBounds?.width).toBeCloseTo(bounds!.width, 1);
      expect(copiedBounds?.height).toBeCloseTo(bounds!.height, 1);
      await page.keyboard.press("End");
      await expect(
        menu.getByRole("menuitem", { name: "Switch branch…" }),
      ).toBeFocused();
      await page.keyboard.press("ArrowUp");
      await expect(
        menu.getByRole("menuitem", { name: "Export session…" }),
      ).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(title).toBeFocused();
      await title.press("Enter");

      const input = page.getByRole("textbox", { name: "Session name" });
      await rename.tap();
      await expect(menu).toHaveCount(0);
      await expect(
        page.getByRole("dialog", { name: "Rename session" }),
      ).toBeInViewport();
      await expect(input).toBeFocused();
      await input.fill("Calibration 仪器");
      await expectCompositionEscape(input, "Calibration 仪器");
      await input.press("Escape");
      await expect(input).toHaveCount(0);
      await expect(title).toBeFocused();
      await expect(title).not.toContainText("Calibration 仪器");

      await page.route(
        "**/api/sessions/rename",
        async (route) => {
          await response.promise;
          await route.continue();
        },
        { times: 1 },
      );
      await title.press("Enter");
      await rename.tap();
      await input.fill("Earlier save");
      const requested = page.waitForRequest("**/api/sessions/rename");
      const saved = page.waitForResponse("**/api/sessions/rename");
      const refreshed = page.waitForResponse(
        (reply) => new URL(reply.url()).pathname === "/api/sessions",
      );
      await input.press("Enter");
      await requested;
      await input.fill("Newer calibration notes");
      response.resolve();
      await saved;
      await refreshed;
      await expect(input).toHaveValue("Newer calibration notes");
      await expect(input).toBeFocused();
      await expect(
        page.getByRole("button", { name: "Save session name" }),
      ).toBeEnabled();
      await input.press("Enter");
      await expect(title).toContainText("Newer calibration notes");
      await expect(title).toBeFocused();
      await expect(composer).toHaveValue(draft);
    } finally {
      response.resolve();
      await host.patch("/api/preferences", {
        data: { sessionActionOrder: original },
      });
    }
  });

  test("workspace search leaves IME Escape to the input", async ({ page }) => {
    await pairedPage(page);
    await openFixtureSession(page, /Review extension event lifecycle/);
    await page.getByRole("button", { name: "Toggle resources panel" }).tap();
    const pane = page.locator(".ctx");
    await pane.getByRole("tab", { name: "Files", exact: true }).tap();
    const search = pane.getByRole("searchbox", {
      name: "Search workspace files",
    });
    await search.fill("calibration 仪器");
    await expectCompositionEscape(search, "calibration 仪器");
    await search.press("Escape");
    await expect(search).toHaveValue("");
    await expect(search).toBeFocused();
    await search.press("Escape");
    await expect(search).not.toBeFocused();
    await expect(pane).toBeVisible();
  });
});

async function expectCompositionEscape(field: Locator, value: string) {
  for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
    expect(
      await field.evaluate(
        (element, ime) =>
          element.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Escape",
              ...ime,
              bubbles: true,
              cancelable: true,
            }),
          ),
        ime,
      ),
    ).toBe(true);
    await expect(field).toHaveValue(value);
    await expect(field).toBeFocused();
  }
}

test("export failure keeps long diagnostics readable and retries the selected format", async ({
  page,
}) => {
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill(draft);
  const authority = (await hostRequest(page).get("/api/preferences")).headers()[
    "x-inspire-authority"
  ]!;
  const message =
    "Cannot read /workspace/archive/TemperatureDependentReferenceSpectrometerCalibrationRepeatabilityAndMeasurementUncertaintyDecompositionAnalysis.jsonl: EACCES (permission denied).";
  const exportReady = Promise.withResolvers<void>();
  await page.route(
    "**/api/sessions/export",
    async (route) => {
      await exportReady.promise;
      await route.fulfill({
        status: 409,
        headers: { "X-Inspire-Authority": authority },
        json: { error: message },
      });
    },
    { times: 1 },
  );
  await page.getByRole("button", { name: /^Session actions:/ }).click();
  await page
    .getByRole("menuitem", { name: "Export session…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Export session",
    exact: true,
  });
  const format = dialog.getByRole("radio", { name: "JSONL Current branch" });
  await format.check();
  await page.evaluate(() => document.fonts.ready);
  const download = dialog.getByRole("button", {
    name: "Download",
    exact: true,
  });
  const size = (await download.boundingBox())!;
  try {
    await download.click();
    const exporting = dialog.getByRole("button", {
      name: "Exporting…",
      exact: true,
    });
    await expect(exporting).toBeDisabled();
    expect(await exporting.boundingBox()).toMatchObject({
      width: size.width,
      height: size.height,
    });
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeEnabled();
  } finally {
    exportReady.resolve();
  }
  const error = dialog.getByRole("alert");
  await expect(error).toHaveText(message);
  expect((await renderedColors(error)).contrast).toBeGreaterThanOrEqual(4.5);
  await page.setViewportSize({ width: 320, height: 320 });
  expect(await error.evaluate(textOverflowsInlineBounds)).toBe(false);
  await expect(format).toBeChecked();
  for (const name of ["Cancel", "Download"]) {
    const action = dialog.getByRole("button", { name, exact: true });
    await action.scrollIntoViewIfNeeded();
    await expect(action).toBeInViewport({ ratio: 1 });
  }
  const retry = page.waitForRequest("**/api/sessions/export");
  const downloaded = page.waitForEvent("download");
  await download.click();
  expect((await retry).postDataJSON().format).toBe("jsonl");
  expect((await downloaded).suggestedFilename()).toMatch(/\.jsonl$/u);
  await expect(dialog).toHaveCount(0);
  await expect(composer).toHaveValue(draft);
});

test("exports download the chosen format even if the dialog closes, preserving draft attachments", async ({
  page,
}, info) => {
  const { title: actions, composer } = await namedSession(page, true);
  await page.locator('input[type="file"]').setInputFiles({
    name: "draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Preserve the export draft artifact"),
  });
  await expect(page.locator(".attachment--ready")).toBeVisible();
  await actions.click();
  await page
    .getByRole("menuitem", { name: "Export session…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Export session",
    exact: true,
  });
  await dialog.getByText("Current branch", { exact: true }).click();
  await expect(
    dialog.getByRole("radio", { name: "JSONL Current branch" }),
  ).toBeChecked();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(actions).toBeFocused();

  const exports: unknown[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/sessions/export")
      exports.push(request.postDataJSON());
  });
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/sessions/export", async (route) => {
    if (route.request().postDataJSON().format === "jsonl") await pending;
    await route.fallback();
  });
  const paletteExport = async () => {
    const palette = await openCommandPalette(page);
    await palette.getByLabel("Filter commands").fill("export");
    await palette.getByRole("option", { name: /Export session/ }).click();
    await expect(palette).toHaveCount(0);
  };
  for (const format of ["html", "jsonl"]) {
    if (format === "html") {
      await actions.click();
      await page
        .getByRole("menuitem", { name: "Export session…", exact: true })
        .click();
    } else {
      await paletteExport();
      await dialog.getByRole("radio", { name: "JSONL Current branch" }).check();
    }
    const downloaded = page.waitForEvent("download");
    if (format === "html") {
      await expect(
        dialog.getByRole("radio", { name: "HTML Whole session" }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
    } else {
      try {
        await dialog
          .getByRole("button", { name: "Download", exact: true })
          .click();
        await expect(
          dialog.getByRole("button", { name: "Exporting…" }),
        ).toBeDisabled();
        await dialog
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await paletteExport();
        await expect(
          dialog.getByRole("radio", { name: "JSONL Current branch" }),
        ).toBeChecked();
        await expect(
          dialog.getByRole("button", { name: "Exporting…" }),
        ).toBeDisabled();
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
      } finally {
        release();
      }
    }
    const download = await downloaded;
    expect(download.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
    expect(await download.failure()).toBeNull();
    if (format === "jsonl") {
      const path = info.outputPath("branch-copy.jsonl");
      await download.saveAs(path);
      const records = (await readFile(path, "utf8"))
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      expect(records[0]?.type).toBe("session");
      expect(records).toContainEqual(
        expect.objectContaining({
          type: "message",
          message: expect.objectContaining({ role: "user" }),
        }),
      );
    }
    await expect(page.locator(".attachment")).toContainText("draft.txt");
    await expect(dialog).toHaveCount(0);
    await expect(composer).toHaveValue(draft);
    await expect(
      format === "html"
        ? actions
        : page.getByRole("button", {
            name: "Open command palette",
            exact: true,
          }),
    ).toBeFocused();
  }
  expect(exports).toMatchObject([{ format: "html" }, { format: "jsonl" }]);
});
