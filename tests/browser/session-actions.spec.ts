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

test.use({ serviceWorkers: "block" });

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
    page.getByText("Clone is unavailable", { exact: true }),
  ).toBeVisible();
  await expect(clone).toBeEnabled();
  expect(attempts).toBe(1);
  await clone.click();
  await expect.poll(() => attempts).toBe(2);
  await expect(menu).toBeVisible();
});

async function namedSession(page: Page, withConversation = false) {
  await page.emulateMedia({ reducedMotion: "reduce" });
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
        return (await snapshot.json()).runState;
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
  await composer.fill("Keep the unfinished comparison");
  return { title, composer, sessionId };
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
    test(
      touch
        ? "a touch drag persists action order across the disclosure boundary"
        : "dragging across overflow syncs with Settings and Escape cancels a drag",
      async ({ page }) => {
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
                "switch-branch",
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
              name: "Reorder Switch branch…",
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
            "Switch branch…",
          ]);
          expect(writes).toHaveLength(0);
          await up();
          await expect
            .poll(savedOrder)
            .toEqual(["rename", "copy-id", "clone", "export", "switch-branch"]);
          expect(writes).toHaveLength(1);
          if (touch) {
            await expect(composer).toHaveValue(
              "Keep the unfinished comparison",
            );
            return;
          }
          await page.keyboard.press("Escape");
          await openSettings(page);
          await page
            .getByRole("button", { name: "Behavior", exact: true })
            .click();
          const settingsList = page.getByRole("list", {
            name: "Session action order",
          });
          await expect(
            settingsList.locator(".session-action-order__label"),
          ).toHaveText([
            "Rename session",
            "Copy session ID",
            "Clone current branch",
            "Export session…",
            "Switch branch…",
          ]);
          const exportHandle = settingsList.getByRole("button", {
            name: "Reorder Export session…",
          });
          await exportHandle.click();
          const moveUp = page.getByRole("menuitem", {
            name: "Move Export session… up",
          });
          await expect(moveUp).toBeFocused();
          await page.keyboard.press("Escape");
          await expect(moveUp).toHaveCount(0);
          await expect(exportHandle).toBeFocused();
          await exportHandle.click();
          await moveUp.click();
          const reordered = [
            "rename",
            "copy-id",
            "export",
            "clone",
            "switch-branch",
          ];
          await expect.poll(savedOrder).toEqual(reordered);
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
            "Switch branch…",
          ]);
          expect(writes).toHaveLength(writeCount);
          await expect.poll(savedOrder).toEqual(reordered);
          await expect(composer).toHaveValue("Keep the unfinished comparison");
        } finally {
          await touchClient?.detach();
          await preferences.patch("/api/preferences", {
            data: { sessionActionOrder: original },
          });
        }
      },
    );
  });
}
test("composition Escape preserves title and workspace edits without consuming IME keys", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
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
    await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await pane.getByRole("tab", { name: "Files", exact: true }).click();
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

test("keeps copy feedback in place and anchors rename without losing the draft", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  const { title, composer, sessionId } = await namedSession(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const titleBox = (await title.boundingBox())!;
  await title.press("Enter");
  const menu = page.getByRole("menu", { name: "Session actions" });
  const rename = menu.getByRole("menuitem", {
    name: "Rename session",
    exact: true,
  });
  await expect(rename).toBeFocused();
  await menu.evaluate((el) =>
    Promise.all(el.getAnimations().map((animation) => animation.finished)),
  );
  const before = (await menu.boundingBox())!;
  await menu
    .getByRole("menuitem", { name: "Copy session ID", exact: true })
    .click();
  await expect(menu.getByRole("menuitem", { name: "ID copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    sessionId,
  );
  expect(await menu.boundingBox()).toEqual(before);

  await rename.click();
  const input = page.getByRole("textbox", {
    name: "Session name",
    exact: true,
  });
  await expect(menu).toHaveCount(0);
  await expect(input).toBeFocused();
  const editor = (await input.boundingBox())!;
  expect(editor.x).toBeCloseTo(titleBox.x, 0);
  expect(editor.y + editor.height / 2).toBeCloseTo(
    titleBox.y + titleBox.height / 2,
    0,
  );
  await input.fill("Reviewed calibration notes");
  await input.press("Enter");
  await expect(title).toContainText("Reviewed calibration notes");
  await expect(title).toBeFocused();
  await expect(composer).toHaveValue("Keep the unfinished comparison");
});

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
test("export failure keeps long diagnostics readable and every action reachable", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/);
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep the unfinished comparison");
  const authority = (await hostRequest(page).get("/api/preferences")).headers()[
    "x-inspire-authority"
  ]!;
  const message =
    "Cannot read /workspace/archive/TemperatureDependentReferenceSpectrometerCalibrationRepeatabilityAndMeasurementUncertaintyDecompositionAnalysis.jsonl: EACCES (permission denied).";
  let releaseExport!: () => void;
  const exportReady = new Promise<void>((resolve) => {
    releaseExport = resolve;
  });
  await page.route("**/api/sessions/export", async (route) => {
    await exportReady;
    return route.fulfill({
      status: 409,
      headers: { "X-Inspire-Authority": authority },
      json: { error: message },
    });
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
    releaseExport();
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
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(draft).toHaveValue("Keep the unfinished comparison");
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
  await page.getByRole("menuitem", { name: "More actions" }).click();
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
      await page.getByRole("menuitem", { name: "More actions" }).click();
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
