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
  await page.route("**/api/branches/clone", (route) =>
    route.fulfill({ status: 503, json: { error: "Clone is unavailable" } }),
  );
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
      const launch = page.getByRole("combobox", { name: "On launch" });
      await launch.tap();
      const choices = page.getByRole("listbox", { name: "On launch" });
      const current = choices.getByRole("option", { selected: true });
      const row = (await current.boundingBox())!;
      const popup = (await choices.boundingBox())!;
      expect(row.width).toBeCloseTo(popup.width, 0);
      await current.tap({ position: { x: row.width - 8, y: row.height / 2 } });
      await expect(choices).toBeHidden();
      const copyGrip = page.getByRole("button", {
        name: "Reorder Copy session ID",
      });
      await copyGrip.press("Alt+ArrowUp");
      await expect(copyGrip).toBeFocused();
      await copyGrip.press("Enter");
      await expect(
        page.getByRole("menuitem", { name: "Move Copy session ID up" }),
      ).toBeDisabled();
      const copyDown = page.getByRole("menuitem", {
        name: "Move Copy session ID down",
      });
      await expect(copyDown).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(copyGrip).toBeFocused();
      await copyGrip.tap();
      await copyDown.tap();
      await expect(copyGrip).toBeFocused();

      const exportGrip = page.getByRole("button", {
        name: "Reorder Export session…",
      });
      await exportGrip.scrollIntoViewIfNeeded();
      const origin = (await exportGrip.boundingBox())!;
      const target = (await page
        .getByRole("button", { name: "Reorder Switch branch…" })
        .boundingBox())!;
      const x = Math.round(origin.x + origin.width / 2);
      const y = Math.round(origin.y + origin.height / 2);
      const touch = await context.newCDPSession(page);
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchStart",
        touchPoints: [{ x, y }],
      });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: Math.round(target.y + target.height / 2) }],
      });
      await touch.send("Input.dispatchTouchEvent", {
        type: "touchEnd",
        touchPoints: [],
      });
      await touch.detach();
      await expect
        .poll(savedOrder)
        .toEqual(["rename", "copy-id", "clone", "export", "switch-branch", "tool-loadout"]);

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
        "Tool Loadout…",
      ]);
      await menu.getByRole("menuitem", { name: "Copy session ID" }).tap();
      await expect(
        menu.getByRole("menuitem", { name: "ID copied" }),
      ).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        sessionId,
      );
      await page.keyboard.press("End");
      await expect(menu.getByRole("menuitem", { name: "Tool Loadout…" })).toBeFocused();
      await page.keyboard.press("ArrowUp");
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
      await expect(input).toBeInViewport();
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

test("export failure keeps long diagnostics and the selected format reachable", async ({
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
  const download = dialog.getByRole("button", {
    name: "Download",
    exact: true,
  });
  try {
    await download.click();
    const exporting = dialog.getByRole("button", {
      name: "Exporting…",
      exact: true,
    });
    await expect(exporting).toBeDisabled();
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
  await expect(composer).toHaveValue(draft);
});

test("exports download the chosen format even if the dialog closes, preserving draft attachments", async ({
  page,
}, info) => {
  const { composer } = await namedSession(page, true);
  await page.locator('input[type="file"]').setInputFiles({
    name: "draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Preserve the export draft artifact"),
  });
  await expect(page.locator(".attachment--ready")).toBeVisible();
  const dialog = page.getByRole("dialog", {
    name: "Export session",
    exact: true,
  });
  const exports: unknown[] = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/sessions/export")
      exports.push(request.postDataJSON());
  });
  const { promise: pending, resolve: release } = Promise.withResolvers<void>();
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
  await paletteExport();
  await dialog.getByRole("radio", { name: "JSONL Current branch" }).check();
  const downloaded = page.waitForEvent("download");
  const exporting = dialog.getByRole("button", { name: "Exporting…" });
  try {
    await dialog.getByRole("button", { name: "Download", exact: true }).click();
    await expect(exporting).toBeDisabled();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
    await paletteExport();
    await expect(
      dialog.getByRole("radio", { name: "JSONL Current branch" }),
    ).toBeChecked();
    await expect(exporting).toBeDisabled();
    await page.keyboard.press("Escape");
  } finally {
    release();
  }
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/\.jsonl$/);
  const path = info.outputPath("branch-copy.jsonl");
  await download.saveAs(path);
  const records = (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(records[0]?.type).toBe("session");
  expect(records).toContainEqual(
    expect.objectContaining({
      type: "message",
      message: expect.objectContaining({ role: "user" }),
    }),
  );
  await expect(page.locator(".attachment")).toContainText("draft.txt");
  await expect(dialog).toHaveCount(0);
  await expect(composer).toHaveValue(draft);
  expect(exports).toMatchObject([{ format: "jsonl" }]);
});
