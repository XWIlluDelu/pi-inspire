import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { hostRequest } from "./support/host-request";
import { openMockSession, pairedPage } from "./support/navigation";
import { firstTextBaseline } from "./support/text-baseline";
import { textOverflowsInlineBounds } from "./support/text-bounds";

test.use({ serviceWorkers: "block" });

test("a failed clone leaves its action menu available instead of silently dismissing it", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
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
    page.getByText("Clone is unavailable", { exact: true }),
  ).toBeVisible();
  await expect(clone).toBeEnabled();
  expect(attempts).toBe(1);
  await clone.click();
  await expect.poll(() => attempts).toBe(2);
  await expect(menu).toBeVisible();
});

async function namedSession(page: Page) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  const response = await hostRequest(page).post("/api/sessions/new", {
    data: {
      cwd: browserWorkspace,
      name: "Calibration notes for this session with a long title covering model selection, tool execution, and follow-up analysis",
    },
  });
  expect(response.ok()).toBe(true);
  await page.reload();
  const title = page.getByRole("button", { name: /^Session actions:/ });
  await expect(title).toContainText("Calibration notes");
  const composer = page.getByRole("textbox", {
    name: "Message",
    exact: true,
  });
  await composer.fill("Keep the unfinished comparison");
  return { title, composer };
}
async function openRename(page: Page) {
  await page.getByRole("button", { name: /^Session actions:/ }).click();
  await page
    .getByRole("menuitem", { name: "Rename session", exact: true })
    .click();
}
for (const touch of [false, true]) {
  test.describe(touch ? "touch title actions" : "desktop title actions", () => {
    test.use({
      viewport: touch
        ? { width: 320, height: 740 }
        : { width: 1280, height: 900 },
      hasTouch: touch,
    });
    test("drag handles reorder across overflow, persist to Settings, and cancel without executing actions", async ({
      page,
    }) => {
      const { title, composer } = await namedSession(page);
      const preferences = hostRequest(page);
      const original = (
        await (await preferences.get("/api/preferences")).json()
      ).sessionActionOrder;
      const touchClient = touch
        ? await page.context().newCDPSession(page)
        : null;
      let pointer = { x: 0, y: 0 };
      const move = async (x: number, y: number) => {
        pointer = { x, y };
        if (touchClient)
          await touchClient.send("Input.dispatchTouchEvent", {
            type: "touchMove",
            touchPoints: [pointer],
          });
        else await page.mouse.move(x, y, { steps: 6 });
      };
      const down = async (handle: Locator) => {
        const box = (await handle.boundingBox())!;
        pointer = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        if (touchClient)
          await touchClient.send("Input.dispatchTouchEvent", {
            type: "touchStart",
            touchPoints: [pointer],
          });
        else {
          await page.mouse.move(pointer.x, pointer.y);
          await page.mouse.down();
        }
      };
      const up = async () => {
        if (touchClient)
          await touchClient.send("Input.dispatchTouchEvent", {
            type: "touchEnd",
            touchPoints: [],
          });
        else await page.mouse.up();
      };
      const savedOrder = async () =>
        (await (await preferences.get("/api/preferences")).json())
          .sessionActionOrder;
      try {
        await preferences.patch("/api/preferences", {
          data: {
            sessionActionOrder: [
              "rename",
              "copy-id",
              "terminal",
              "clone",
              "export",
            ],
          },
        });
        await page.reload();
        await title.click();
        const menu = page.getByRole("menu", { name: "Session actions" });
        const actions = menu.locator("[data-session-action]");
        const writes: unknown[] = [];
        page.on("request", (request) => {
          if (
            request.method() === "PATCH" &&
            new URL(request.url()).pathname === "/api/preferences"
          )
            writes.push(request.postDataJSON().sessionActionOrder);
        });
        // Dragging expands the compact menu so a visible action can cross into overflow.
        await down(
          page.getByRole("menuitem", {
            name: "Reorder Use in terminal…",
            exact: true,
          }),
        );
        await move(pointer.x, pointer.y + 8);
        const exportAction = menu.getByRole("menuitem", {
          name: "Export session…",
          exact: true,
        });
        await expect(exportAction).toBeVisible();
        await expect(
          menu.getByRole("menuitem", { name: "Fewer actions", exact: true }),
        ).toBeInViewport();
        const destination = (await exportAction.boundingBox())!;
        await move(pointer.x, destination.y + destination.height / 2);
        await expect(actions).toHaveText([
          "Rename session",
          "Copy session ID",
          "Clone current branch",
          "Export session…",
          "Use in terminal…",
        ]);
        expect(writes).toHaveLength(0);
        await up();
        await expect
          .poll(savedOrder)
          .toEqual(["rename", "copy-id", "clone", "export", "terminal"]);
        expect(writes).toHaveLength(1);
        await expect(
          page.getByRole("dialog", { name: "Use in terminal", exact: true }),
        ).toHaveCount(0);
        await page.keyboard.press("Escape");
        await page
          .getByRole("button", { name: "Settings", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Behavior", exact: true })
          .click();
        const settingsList = page.getByRole("list", {
          name: "Session action order",
        });
        const settingsLabels = settingsList.locator(
          ".session-action-order__label",
        );
        await expect(settingsLabels).toHaveText([
          "Rename session",
          "Copy session ID",
          "Clone current branch",
          "Export session…",
          "Use in terminal…",
        ]);
        const copyHandle = page.getByRole("button", {
          name: "Reorder Copy session ID",
          exact: true,
        });
        await copyHandle.click();
        const copyMenu = page.getByRole("menu", {
          name: "Move options for Copy session ID",
        });
        await expect(
          copyMenu.getByRole("menuitem", {
            name: "Move Copy session ID up",
            exact: true,
          }),
        ).toBeFocused();
        await page.keyboard.press("ArrowDown");
        await expect(
          copyMenu.getByRole("menuitem", {
            name: "Move Copy session ID down",
            exact: true,
          }),
        ).toBeFocused();
        await page.keyboard.press("Escape");
        await expect(copyMenu).toHaveCount(0);
        await expect(copyHandle).toBeFocused();
        await expect(
          page.getByRole("dialog", { name: "Settings" }),
        ).toBeVisible();

        const exportHandle = page.getByRole("button", {
          name: "Reorder Export session…",
          exact: true,
        });
        await exportHandle.click();
        await page
          .getByRole("menuitem", {
            name: "Move Export session… up",
            exact: true,
          })
          .click();
        await expect
          .poll(savedOrder)
          .toEqual(["rename", "copy-id", "export", "clone", "terminal"]);
        await expect(settingsLabels).toHaveText([
          "Rename session",
          "Copy session ID",
          "Export session…",
          "Clone current branch",
          "Use in terminal…",
        ]);

        // Starting a drag dismisses an already-open move menu.
        await settingsList.scrollIntoViewIfNeeded();
        const cloneRowBox = (await page
          .locator('.session-action-order__row[data-session-action-id="clone"]')
          .boundingBox())!;
        await exportHandle.click();
        await down(exportHandle);
        await move(pointer.x, pointer.y + 8);
        await expect(
          page.getByRole("menu", { name: "Move options for Export session…" }),
        ).toHaveCount(0);
        await move(pointer.x, cloneRowBox.y + cloneRowBox.height / 2);
        await up();
        await expect
          .poll(savedOrder)
          .toEqual(["rename", "copy-id", "clone", "export", "terminal"]);
        await expect(settingsLabels).toHaveText([
          "Rename session",
          "Copy session ID",
          "Clone current branch",
          "Export session…",
          "Use in terminal…",
        ]);

        // A click-menu move is also reflected in the title menu after reload.
        await exportHandle.click();
        await page
          .getByRole("menuitem", {
            name: "Move Export session… up",
            exact: true,
          })
          .click();
        await expect
          .poll(savedOrder)
          .toEqual(["rename", "copy-id", "export", "clone", "terminal"]);
        await page.reload();
        await title.click();
        await expect(actions).toHaveText([
          "Rename session",
          "Copy session ID",
          "Export session…",
        ]);
        const writeCount = writes.length;
        await down(
          page.getByRole("menuitem", {
            name: "Reorder Export session…",
            exact: true,
          }),
        );
        const rename = (await menu
          .getByRole("menuitem", { name: "Rename session", exact: true })
          .boundingBox())!;
        await move(pointer.x, rename.y + rename.height / 2);
        await expect(actions.first()).toHaveText("Export session…");
        await page.keyboard.press("Escape");
        await up();
        await expect(actions).toHaveText([
          "Rename session",
          "Copy session ID",
          "Export session…",
          "Clone current branch",
          "Use in terminal…",
        ]);
        expect(writes).toHaveLength(writeCount);
        await expect
          .poll(savedOrder)
          .toEqual(["rename", "copy-id", "export", "clone", "terminal"]);
        await expect(composer).toHaveValue("Keep the unfinished comparison");
      } finally {
        await touchClient?.detach();
        await preferences.patch("/api/preferences", {
          data: { sessionActionOrder: original },
        });
      }
    });

    test("terminal handoff keeps the browser draft and requires explicit continuation", async ({
      page,
    }, testInfo) => {
      const { title, composer } = await namedSession(page);
      await title.click();
      await page
        .getByRole("menuitem", { name: "More actions", exact: true })
        .click();
      await page
        .getByRole("menuitem", { name: "Use in terminal…", exact: true })
        .click();
      const dialog = page.getByRole("dialog", {
        name: "Use in terminal",
        exact: true,
      });
      await expect(dialog).toBeVisible();
      await expect(dialog).toContainText("Other sessions keep running");
      await page.screenshot({
        path: testInfo.outputPath("terminal-handoff-before.png"),
      });
      await dialog
        .getByRole("button", { name: "Use in terminal", exact: true })
        .click();
      await expect(dialog).toContainText("pi --session");
      await expect(
        dialog.getByRole("button", { name: "Copy command", exact: true }),
      ).toBeEnabled();
      await expect(page.locator("html")).toHaveJSProperty(
        "scrollWidth",
        touch ? 320 : 1280,
      );
      await page.screenshot({
        path: testInfo.outputPath("terminal-handoff-after.png"),
      });
      await dialog.getByRole("button", { name: "Close", exact: true }).click();
      await expect(
        page.getByRole("button", { name: "Continue in Inspire" }),
      ).toBeVisible();
      await page.reload();
      await page.getByRole("button", { name: "Continue in Inspire" }).click();
      await expect(composer).toHaveValue("Keep the unfinished comparison");
    });
    test("composition Escape preserves title and workspace edits without consuming IME keys", async ({
      page,
    }) => {
      const { title, composer } = await namedSession(page);
      await openRename(page);
      const name = page.getByRole("textbox", {
        name: "Session name",
        exact: true,
      });
      await name.fill("Calibration 仪器");
      const composingKeys = [
        { key: "Escape", isComposing: true },
        { key: "Escape", isComposing: false, keyCode: 229 },
      ];
      const dispatch = (element: Element, init: KeyboardEventInit) =>
        element.dispatchEvent(
          new KeyboardEvent("keydown", {
            ...init,
            bubbles: true,
            cancelable: true,
          }),
        );
      for (const key of composingKeys) {
        expect(await name.evaluate(dispatch, key)).toBe(true);
        await expect(name).toHaveValue("Calibration 仪器");
        await expect(name).toBeFocused();
      }
      await name.press("Escape");
      await expect(name).toHaveCount(0);
      await expect(title).not.toContainText("Calibration 仪器");
      await expect(composer).toHaveValue("Keep the unfinished comparison");

      const pane = page.locator(".ctx");
      if (!(await pane.isVisible()))
        await page
          .getByRole("button", { name: "Toggle resources panel" })
          .click();
      await pane.getByRole("button", { name: "Files", exact: true }).click();
      const search = pane.getByRole("searchbox", {
        name: "Search workspace files",
        exact: true,
      });
      await search.fill("calibration 仪器");
      for (const key of composingKeys) {
        expect(await search.evaluate(dispatch, key)).toBe(true);
        await expect(search).toHaveValue("calibration 仪器");
        await expect(search).toBeFocused();
      }
      await search.press("Escape");
      await expect(search).toHaveValue("");
      await expect(search).toBeFocused();
      await search.press("Escape");
      await expect(search).not.toBeFocused();
      await expect(pane).toBeVisible();
      await expect(composer).toHaveValue("Keep the unfinished comparison");
    });

    test("keeps copy feedback stable and anchors in-place rename with keyboard focus restoration", async ({
      page,
    }) => {
      const { title, composer } = await namedSession(page);
      const rect = (await title.boundingBox())!;
      const heading = (await page.locator(".topbar__heading").boundingBox())!;
      expect(rect.width).toBeGreaterThanOrEqual(44);
      await expect(page.locator(".topbar__heading > button")).toHaveCount(0);
      await expect(title).toHaveAttribute("aria-haspopup", "menu");
      await expect(page.locator(".topbar__project .lucide-folder")).toHaveCount(
        0,
      );
      const x = rect.x + Math.min(60, rect.width / 2);
      const y = rect.y + rect.height / 2;
      const click = () =>
        touch ? page.touchscreen.tap(x, y) : page.mouse.click(x, y);
      await click();
      const menu = page.getByRole("menu", { name: "Session actions" });
      await expect(menu).toBeVisible();
      await expect(title).toHaveAttribute("aria-expanded", "true");
      await expect(menu.locator("[data-session-action]")).toHaveText([
        "Rename session",
        "Copy session ID",
        "Clone current branch",
      ]);
      await expect(
        menu.getByRole("menuitem", { name: "More actions" }),
      ).toBeVisible();
      const input = page.getByRole("textbox", { name: "Session name" });
      await expect(input).toHaveCount(0);
      const rename = menu.getByRole("menuitem", {
        name: "Rename session",
        exact: true,
      });
      await expect(rename).toBeFocused();
      await menu.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations().map((animation) => animation.finished),
        );
      });
      const menuBeforeCopy = (await menu.boundingBox())!;
      await page
        .context()
        .grantPermissions(["clipboard-read", "clipboard-write"]);
      await menu
        .getByRole("menuitem", { name: "Copy session ID", exact: true })
        .click();
      await expect(
        menu.getByRole("menuitem", { name: "ID copied", exact: true }),
      ).toBeVisible();
      const menuAfterCopy = (await menu.boundingBox())!;
      expect(menuAfterCopy.width).toBeCloseTo(menuBeforeCopy.width, 1);
      expect(menuAfterCopy.height).toBeCloseTo(menuBeforeCopy.height, 1);
      if (touch) await rename.tap();
      else await rename.click();
      await expect(menu).toHaveCount(0);
      await expect(input).toBeFocused();
      await expect
        .poll(async () => Math.abs((await input.boundingBox())!.x - rect.x))
        .toBeLessThanOrEqual(1);
      const editor = (await input.boundingBox())!;
      expect(editor.width).toBeGreaterThan(160);
      expect(
        Math.abs(editor.y + editor.height / 2 - heading.y - heading.height / 2),
      ).toBeLessThanOrEqual(1);
      await input.fill("Reviewed calibration notes");
      await input.press("Enter");
      await expect(title).toContainText("Reviewed calibration notes");
      await expect(title).toBeFocused();
      await expect(title).toHaveCSS("outline-style", "none");
      await page.keyboard.press("Tab");
      await page.keyboard.press("Shift+Tab");
      await expect(title).toBeFocused();
      await expect(title).toHaveCSS("outline-style", "solid");
      await expect(composer).toHaveValue("Keep the unfinished comparison");

      await openRename(page);
      await input.fill("Saved outside the editor");
      const bar = (await page.locator(".topbar").boundingBox())!;
      const outside = { x: bar.x + bar.width / 2, y: bar.y + bar.height - 1 };
      if (touch) await page.touchscreen.tap(outside.x, outside.y);
      else await page.mouse.click(outside.x, outside.y);
      await expect(input).toHaveCount(0);
      await expect(title).toContainText("Saved outside the editor");
      await expect(composer).toHaveValue("Keep the unfinished comparison");

      await title.focus();
      await page.keyboard.press("Enter");
      await expect(rename).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        menu.getByRole("menuitem", {
          name: "Reorder Rename session",
          exact: true,
        }),
      ).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(
        menu.getByRole("menuitem", { name: "Copy session ID", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Home");
      await page.keyboard.press("Enter");
      await expect(input).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(title).toBeFocused();
      await page.keyboard.press("ArrowDown");
      await expect(rename).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
      await expect(title).toBeFocused();
      await expect(title).toHaveAttribute("aria-expanded", "false");
    });
  });
}
test("a delayed blur save cannot replace a newer name still being edited", async ({
  page,
}) => {
  const { title, composer } = await namedSession(page);
  const input = page.getByRole("textbox", { name: "Session name" });
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => {
    releaseSave = resolve;
  });
  await page.route(
    "**/api/sessions/rename",
    async (route) => {
      await saveGate;
      await route.continue();
    },
    { times: 1 },
  );
  await openRename(page);
  await input.fill("Earlier blur save");
  const saving = page.waitForResponse("**/api/sessions/rename");
  const requested = page.waitForRequest("**/api/sessions/rename");
  await composer.click();
  await requested;
  await input.fill("Newer name still being edited");
  const refreshed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/sessions",
  );
  releaseSave();
  await saving;
  await refreshed;
  await expect(input).toBeFocused();
  await expect(input).toHaveValue("Newer name still being edited");
  await input.press("Enter");
  await expect(title).toContainText("Newer name still being edited");
  await expect(composer).toHaveValue("Keep the unfinished comparison");
});
test("export failure keeps long diagnostics readable and the selected format retryable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep the unfinished comparison");
  const authority = (await hostRequest(page).get("/api/preferences")).headers()[
    "x-inspire-authority"
  ]!;
  const message =
    "Cannot read /workspace/archive/TemperatureDependentReferenceSpectrometerCalibrationRepeatabilityAndMeasurementUncertaintyDecompositionAnalysis.jsonl: EACCES (permission denied).";
  let fail = true;
  let releaseExport!: () => void;
  const exportReady = new Promise<void>((resolve) => {
    releaseExport = resolve;
  });
  await page.route("**/api/sessions/export", async (route) => {
    await exportReady;
    return fail
      ? route.fulfill({
          status: 409,
          headers: { "X-Inspire-Authority": authority },
          json: { error: message },
        })
      : route.fallback();
  });
  await page.getByRole("button", { name: /^Session actions:/ }).click();
  await page.getByRole("menuitem", { name: "More actions" }).click();
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
  const geometry = (await download.boundingBox())!;
  await download.click();
  try {
    const exporting = dialog.getByRole("button", {
      name: "Exporting…",
      exact: true,
    });
    await expect(exporting).toBeDisabled();
    // Pending exports add guidance and allow closing; only the submitted
    // action's label footprint remains fixed.
    expect(await exporting.boundingBox()).toMatchObject({
      width: geometry.width,
      height: geometry.height,
    });
    await expect(
      dialog.getByRole("button", { name: "Close", exact: true }),
    ).toBeEnabled();
  } finally {
    releaseExport();
  }
  const error = dialog.getByRole("alert");
  await expect(error).toHaveText(message);
  for (const [width, height] of [
    [1280, 900],
    [844, 390],
    [390, 844],
    [320, 640],
    [568, 320],
    [320, 320],
  ]) {
    await page.setViewportSize({ width, height });
    await page.evaluate(() => document.fonts.ready);
    await expect
      .poll(() => error.evaluate(textOverflowsInlineBounds))
      .toBe(false);
    await expect
      .poll(() => dialog.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBe(0);
    await expect(format).toBeChecked();
    // The existing overlay scroll, not horizontal panning, reaches every action.
    for (const name of ["Cancel", "Download"]) {
      const button = dialog.getByRole("button", { name, exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport({ ratio: 1 });
    }
    await error.scrollIntoViewIfNeeded();
    await expect(error).toBeInViewport({ ratio: 1 });
  }
  const html = dialog.getByRole("radio", { name: "HTML Whole session" });
  await html.check();
  await expect(html).toBeChecked();
  await format.check();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(draft).toHaveValue("Keep the unfinished comparison");
  await page.getByRole("button", { name: /^Session actions:/ }).click();
  await page.getByRole("menuitem", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Export session…", exact: true })
    .click();
  await format.check();
  fail = false;
  const downloaded = page.waitForEvent("download");
  await dialog.getByRole("button", { name: "Download", exact: true }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toMatch(/\.jsonl$/);
  expect(await file.failure()).toBeNull();
  await expect(dialog).toHaveCount(0);
  await expect(draft).toHaveValue("Keep the unfinished comparison");
});

test("title/palette exports download the selected format and branch without consuming draft attachments", async ({
  page,
}, info) => {
  const { title: actions, composer } = await namedSession(page);
  await page.locator('input[type="file"]').setInputFiles({
    name: "draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Preserve the export draft artifact"),
  });
  await expect(page.locator(".attachment--ready")).toBeVisible();
  await actions.click();
  await page.getByRole("menuitem", { name: "More actions" }).click();
  await page
    .getByRole("menuitem", { name: "Export session…", exact: true })
    .click();
  const dialog = page.getByRole("dialog", {
    name: "Export session",
    exact: true,
  });
  await expect(
    dialog.getByRole("group", { name: "Export format" }),
  ).toBeVisible();
  await expect(
    dialog.getByRole("radio", { name: "HTML Whole session" }),
  ).toBeFocused();
  await page.evaluate(() => document.fonts.ready);
  for (const width of [1280, 820, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const row of await dialog
      .locator(".export-dialog__formats label")
      .all()) {
      const copy = row.locator(".export-dialog__format-copy");
      const [format, description] = await Promise.all([
        copy.locator("span").evaluate(firstTextBaseline),
        copy.locator("small").evaluate(firstTextBaseline),
      ]);
      expect(format).not.toBeNull();
      expect(description).not.toBeNull();
      expect(Math.abs(format! - description!)).toBeLessThanOrEqual(0.5);
      const [control, box] = await Promise.all([
        row.locator("input").boundingBox(),
        row.boundingBox(),
      ]);
      expect(control!.width).toBe(14);
      expect(control!.height).toBe(14);
      expect(
        Math.abs(control!.y + control!.height / 2 - box!.y - box!.height / 2),
      ).toBeLessThanOrEqual(0.5);
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
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
  for (const format of ["html", "jsonl"]) {
    if (format === "html") {
      await actions.click();
      await page.getByRole("menuitem", { name: "More actions" }).click();
      await page
        .getByRole("menuitem", { name: "Export session…", exact: true })
        .click();
    } else {
      await page
        .getByRole("button", { name: "Open command palette", exact: true })
        .click();
      const palette = page.getByRole("dialog", { name: "Command palette" });
      await palette.getByLabel("Filter commands").fill("export");
      await palette.getByRole("option", { name: /Export session/ }).click();
      await expect(palette).toHaveCount(0);
      await dialog.getByRole("radio", { name: "JSONL Current branch" }).check();
    }
    await expect(dialog.getByRole("textbox")).toHaveCount(0);

    const downloaded = page.waitForEvent("download");
    if (format === "html") {
      await expect(
        dialog.getByRole("radio", { name: "HTML Whole session" }),
      ).toBeFocused();
      await page.keyboard.press("Enter");
    } else
      await dialog
        .getByRole("button", { name: "Download", exact: true })
        .click();
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
      expect(records[0]).toMatchObject({ type: "session", version: 3 });
    }
    await expect(page.locator(".attachment")).toContainText("draft.txt");
    await expect(dialog).toHaveCount(0);
    await expect(composer).toHaveValue("Keep the unfinished comparison");
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
