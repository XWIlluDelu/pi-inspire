import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type {
  ActiveSnapshot,
  ExtensionDisplay,
  SupportedExtensionUiRequest,
} from "../../shared/contracts";
import { modelSettingsScenario } from "./fixtures/model-settings";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { clipboardLines } from "./support/clipboard";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import { moveCaretToEnd } from "./support/native-input";
import { openSettings, pairedPage, reloadSession } from "./support/navigation";

// Audit settled dialog colors, not intermediate entrance-animation opacity.
test.use({
  serviceWorkers: "block",
  contextOptions: { reducedMotion: "reduce" },
});

type DemoDisplay =
  | { id: string; method: "setStatus"; statusKey: string; statusText?: string }
  | {
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    };

// The portable example is exercised against real Pi in the native integration test.
// This fixture owns its matching browser questions while the isolated test Host
// supplies pairing, navigation and snapshots; it never opens a user extension.
async function openExample(page: Page, theme: "light" | "dark") {
  let sessionId: string | null = null;
  let pending: SupportedExtensionUiRequest | null = null;
  let displays: ExtensionDisplay[] = [];
  const statuses: Record<string, string> = {};
  const responses: Record<string, unknown>[] = [];
  const transport = await routeSnapshots(page, {
    snapshot: (snapshot) => {
      if (snapshot.active?.sessionId === sessionId) {
        snapshot.pendingExtensionUiRequests = pending ? [pending] : [];
        snapshot.extensionStatuses = { ...statuses };
        snapshot.extensionDisplays = displays;
      }
    },
    bootstrap: (data) => {
      data.preferences.theme = theme;
    },
  });
  const emit = (event: Record<string, unknown>) => {
    expect(
      transport.ready(sessionId!),
      "Fixture events require the current synchronized connection",
    ).toBe(true);
    transport.send({ ...event, sessionId });
  };
  await page.route("**/api/extension-ui", async (route) => {
    const response = route.request().postDataJSON();
    expect(response.sessionId).toBe(sessionId);
    responses.push(response);
    if (pending?.id === response.id) pending = null;
    emit({ type: "extension_ui_remove", id: response.id, reason: "answered" });
    await route.fulfill({ json: { ok: true } });
  });
  await pairedPage(page);
  const created = await hostRequest(page).post("/api/sessions/new", {
    data: { cwd: browserWorkspace, name: "Native UI example" },
  });
  expect(created.ok()).toBe(true);
  const createdSnapshot: ActiveSnapshot = await created.json();
  expect(createdSnapshot.active?.sessionId).toBeTruthy();
  const exampleSessionId = createdSnapshot.active!.sessionId;
  sessionId = exampleSessionId;
  const reload = async (load?: () => Promise<unknown>) => {
    await transport.reload(exampleSessionId, load);
    await expect(
      page.getByRole("button", { name: /^Session actions:/ }),
    ).toHaveText("Native UI example");
    await expect(
      page.getByRole("main").locator(".banner--warning"),
    ).toHaveCount(0);
  };
  await reload(() => reloadSession(page, exampleSessionId));
  return {
    responses,
    emit,
    reload,
    question(fields: Omit<SupportedExtensionUiRequest, "sessionId">) {
      pending = { ...fields, sessionId: sessionId! };
      emit({ type: "extension_ui_request", ...pending });
    },
    display(fields: DemoDisplay) {
      // Mirror the Host's normalized one-way projection, not raw Pi widget RPC.
      if (fields.method === "setStatus") {
        if (fields.statusText === undefined) delete statuses[fields.statusKey];
        else statuses[fields.statusKey] = fields.statusText;
        emit({
          type: "extension_ui_request",
          id: fields.id,
          method: fields.method,
          responseRequired: false,
          extensionStatuses: statuses,
        });
      } else {
        const id = `setWidget:${fields.widgetKey}`;
        displays = displays.filter((display) => display.id !== id);
        if (fields.widgetLines !== undefined)
          displays.push({
            id,
            kind: "widget",
            label: fields.widgetKey,
            source: "Pi extension",
            placement: fields.widgetPlacement ?? "aboveEditor",
            lines: fields.widgetLines,
          });
        emit({
          type: "extension_ui_request",
          id: fields.id,
          method: fields.method,
          responseRequired: false,
          extensionDisplays: displays,
        });
      }
    },
    message() {
      emit({
        type: "message_end",
        message: {
          role: "custom",
          customType: "review_prepared",
          display: true,
          content:
            "**Code review:** Shared interaction\n\nCheck keyboard.\nCheck touch.",
          details: {
            topic: "Code",
            name: "Shared interaction",
            notes: "Check keyboard.\nCheck touch.",
          },
          timestamp: 1_900_000_000_000,
        },
      });
    },
  };
}

test("phone Back cancels the active extension question, not the Settings behind it", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("about:blank#outside-inspire");
  const demo = await openExample(page, "light");
  const inspireUrl = page.url();
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep this draft through the question");
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  demo.question({
    id: "phone-back-question",
    method: "confirm",
    title: "Keep native ownership?",
    message: "The native extension is waiting.",
  });
  const question = page.getByRole("dialog", {
    name: "Keep native ownership?",
    exact: true,
  });
  await expect(question).toBeVisible();
  await page.goBack();
  await expect(question).toHaveCount(0);
  expect(demo.responses).toEqual([
    {
      sessionId: expect.any(String),
      id: "phone-back-question",
      cancelled: true,
    },
  ]);
  await expect(page).toHaveURL(inspireUrl);
  await expect(settings).toBeVisible();
  await settings
    .getByRole("button", { name: "Close settings", exact: true })
    .click();
  await expect(settings).toHaveCount(0);
  await expect(draft).toHaveValue("Keep this draft through the question");
  await expect
    .poll(() =>
      page.evaluate(() => history.state?.__inspireWorkbench?.depth ?? 0),
    )
    .toBe(0);
  await page.goBack();
  await expect(page).toHaveURL("about:blank#outside-inspire");
});

test("phone Back retains a failed native cancellation and can cancel the next queued question", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  const demo = await openExample(page, "dark");
  const inspireUrl = page.url();
  let refuse = true;
  let releaseCancellation!: () => void;
  const cancellation = new Promise<void>((resolve) => {
    releaseCancellation = resolve;
  });
  let attempts = 0;
  await page.route("**/api/extension-ui", async (route) => {
    attempts++;
    if (refuse) {
      await cancellation;
      await route.fulfill({
        status: 409,
        json: { error: "The extension is still waiting. Try again." },
      });
    } else await route.fallback();
  });
  demo.question({
    id: "first-back",
    method: "input",
    title: "First native question",
  });
  demo.question({
    id: "next-back",
    method: "input",
    title: "Next native question",
  });
  const first = page.getByRole("dialog", {
    name: "First native question",
    exact: true,
  });
  await expect(first).toBeVisible();
  await page.goBack();
  try {
    await expect(first).toHaveAttribute("aria-busy", "true");
    await expect
      .poll(() => page.evaluate(() => history.state?.__inspireWorkbench?.depth))
      .toBe(1);
    await page.goBack();
    await expect
      .poll(() => page.evaluate(() => history.state?.__inspireWorkbench?.depth))
      .toBe(1);
    await expect(page).toHaveURL(inspireUrl);
    expect(attempts).toBe(1);
  } finally {
    releaseCancellation();
  }
  await expect(first.getByRole("alert")).toContainText("Try again");
  await expect(page).toHaveURL(inspireUrl);
  expect(demo.responses).toEqual([]);
  refuse = false;
  await page.goBack();
  await expect(first).toHaveCount(0);
  const next = page.getByRole("dialog", {
    name: "Next native question",
    exact: true,
  });
  await expect(next).toBeVisible();
  await page.goBack();
  await expect(next).toHaveCount(0);
  await expect(page).toHaveURL(inspireUrl);
  expect(
    demo.responses.map(({ id, cancelled }) => ({ id, cancelled })),
  ).toEqual([
    { id: "first-back", cancelled: true },
    { id: "next-back", cancelled: true },
  ]);
  await expect
    .poll(() =>
      page.evaluate(() => history.state?.__inspireWorkbench?.depth ?? 0),
    )
    .toBe(0);
});

test("Escape cancels an extension question during work and aborts during a projection conflict", async ({
  page,
}) => {
  const demo = await openExample(page, "light");
  let aborts = 0;
  await page.route("**/api/control/abort", (route) => {
    aborts++;
    return route.fulfill({ json: { steering: [], followUp: [] } });
  });
  demo.emit({ type: "agent_start" });
  await expect(
    page.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();
  demo.question({
    id: "during-run",
    method: "confirm",
    title: "Continue work?",
  });
  const normal = page.getByRole("dialog", { name: "Continue work?" });
  await expect(normal).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(normal).toHaveCount(0);
  expect(demo.responses).toMatchObject([{ id: "during-run", cancelled: true }]);
  expect(aborts).toBe(0);

  demo.question({
    id: "during-conflict",
    method: "confirm",
    title: "Pending question",
  });
  demo.emit({
    type: "session_projection_conflict",
    conflict: {
      kind: "external-change",
      message: "External writer conflict",
      revision: 2,
      incidentId: "inc_extension_recovery",
    },
    sessionStatus: { runState: "conflict" },
  });
  const blocked = page.getByRole("dialog", { name: "Pending question" });
  await expect(blocked).toBeVisible();
  await expect(page.locator(".banner")).toContainText(
    "External writer conflict",
  );
  await expect(
    page.locator('[aria-label="Diagnostic incident"]'),
  ).toContainText("inc_extension_recovery");
  await page.keyboard.press("Escape");
  await expect.poll(() => aborts).toBe(1);
  expect(demo.responses).toHaveLength(1);
});

for (const touch of [false, true]) {
  test.describe(`settings interrupted by extension UI · ${touch ? "touch" : "mouse"}`, () => {
    test.use({ hasTouch: touch, deviceScaleFactor: touch ? 2 : 1 });
    test("returns to its unsaved provider form after the native question owns focus", async ({
      page,
    }) => {
      await page.setViewportSize({ width: touch ? 390 : 1280, height: 844 });
      await modelSettingsScenario(page, touch ? "dark" : "light");
      const fixture = await openExample(page, touch ? "dark" : "light");
      const writes: string[] = [];
      page.on("request", (request) => {
        if (
          request.url().includes("/api/model-settings") &&
          request.method() === "PATCH"
        )
          writes.push(request.postData() ?? "");
      });
      await openSettings(page);
      const settings = page.getByRole("dialog", {
        name: "Settings",
        exact: true,
      });
      await settings
        .getByRole("button", { name: "Models", exact: true })
        .click();
      await settings
        .getByRole("button", { name: "Add provider", exact: true })
        .click();
      const id = settings.getByLabel("Provider ID", { exact: true });
      await id.fill("pending-provider");
      await settings
        .getByLabel("Base URL", { exact: true })
        .fill("https://example.invalid/v1");
      fixture.question({
        id: "interrupt-settings",
        method: "select",
        title: "Review before continuing",
        options: ["Continue", "Stop"],
      });
      const native = page.getByRole("dialog", {
        name: "Review before continuing",
        exact: true,
      });
      await expect(native).toBeVisible();
      await expect(settings).toBeHidden();
      await page.keyboard.press("Tab");
      expect(
        await native.evaluate((el) => el.contains(document.activeElement)),
      ).toBe(true);
      await native
        .getByRole("option", { name: "Continue", exact: true })
        .click();
      await expect(native).toHaveCount(0);
      await expect(settings).toBeVisible();
      await expect(
        settings.getByRole("button", { name: "Models", exact: true }),
      ).toHaveAttribute("aria-current", "location");
      await expect(id).toHaveValue("pending-provider");
      await expect(
        settings.getByLabel("Base URL", { exact: true }),
      ).toHaveValue("https://example.invalid/v1");
      await id.focus();
      await expect(id).toBeFocused();
      await settings
        .getByRole("button", { name: "Reset preferences", exact: true })
        .click();
      const reset = page.getByRole("alertdialog", {
        name: "Reset preferences?",
        exact: true,
      });
      await expect(reset).toBeVisible();
      fixture.question({
        id: "interrupt-confirmation",
        method: "select",
        title: "Review before continuing",
        options: ["Continue", "Stop"],
      });
      await expect(native).toBeVisible();
      await expect(reset).toHaveCount(0);
      await native
        .getByRole("option", { name: "Continue", exact: true })
        .click();
      await expect(native).toHaveCount(0);
      await expect(reset).toBeVisible();
      await reset.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(id).toHaveValue("pending-provider");
      expect(writes).toEqual([]);
      await page.keyboard.press("Escape");
      await expect(settings).toHaveCount(0);
      await expect(
        page.viewportSize()!.width <= 900
          ? page.getByRole("button", { name: "Toggle navigation", exact: true })
          : page.getByRole("button", { name: "Settings", exact: true }),
      ).toBeFocused();
      expect(fixture.responses).toMatchObject([
        { id: "interrupt-settings", value: "Continue" },
        { id: "interrupt-confirmation", value: "Continue" },
      ]);
    });
  });
}

const choice = {
  method: "select" as const,
  title: "Choose a review",
  options: ["Documentation", "Code", "Tests"],
};
for (const theme of ["light", "dark"] as const) {
  test(`a failed extension response stays in its dialog and can be retried in ${theme}`, async ({
    page,
  }) => {
    await page.setViewportSize({
      width: theme === "light" ? 1280 : 390,
      height: 844,
    });
    const fixture = await openExample(page, theme);
    let refuse = true;
    await page.route("**/api/extension-ui", async (route) => {
      if (refuse)
        await route.fulfill({
          status: 409,
          json: {
            error:
              "The extension could not accept this response. Please choose again.",
          },
        });
      else await route.fallback();
    });
    fixture.question({ id: "retry-choice", ...choice });
    const dialog = page.getByRole("dialog", { name: choice.title });
    const option = dialog.getByRole("option", { name: "Code", exact: true });
    await option.click();
    await expect(dialog.getByRole("alert")).toContainText(
      "Please choose again",
    );
    await expect(option).toBeEnabled();
    await expect(page.getByRole("main").locator(".banner")).toHaveCount(0);
    await expect(page.locator(".notice--error, .notice--warning")).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    refuse = false;
    await option.press("Enter");
    await expect(dialog).toHaveCount(0);
    expect(fixture.responses.at(-1)).toMatchObject({
      id: "retry-choice",
      value: "Code",
    });
  });
}

test("long extension question text stays inside dialog content edges", async ({
  page,
}) => {
  const fixture = await openExample(page, "light");
  const path =
    "/workspace/calibration/reference_measurement_comparison_for_multichannel_calibration_and_residual_validation_2026_10_17_results.json";
  const title = `Review ${path}`;
  for (const method of ["input", "editor", "confirm", "select"] as const) {
    const id = `wrapped-${method}`;
    fixture.question({
      id,
      method,
      title,
      message: `Use ${path} as the reference for the next calibration step?`,
      prefill: "Keep the original notes.\nCompare the residuals.",
      options: ["Review the reference measurements", "检查原始测量与标定结果"],
      expiresAt: Date.now() + 120_000,
    });
    const dialog = page.getByRole("dialog", { name: title, exact: true });
    await expect(dialog).toBeVisible();
    for (const width of [1280, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.evaluate(() => document.fonts.ready);
      const geometry = await dialog.evaluate((root) => {
        const bounds = root.getBoundingClientRect(),
          style = getComputedStyle(root);
        const left =
          bounds.left +
          Number.parseFloat(style.borderLeftWidth) +
          Number.parseFloat(style.paddingLeft);
        const right =
          bounds.right -
          Number.parseFloat(style.borderRightWidth) -
          Number.parseFloat(style.paddingRight);
        return {
          client: root.clientWidth,
          scroll: root.scrollWidth,
          textFits: [
            ...root.querySelectorAll(".dialog__title,.dialog__message"),
          ].every((node) => {
            const range = document.createRange();
            range.selectNodeContents(node);
            return [...range.getClientRects()].every(
              (rect) => rect.left >= left - 0.5 && rect.right <= right + 0.5,
            );
          }),
          fieldsMatch: [...root.querySelectorAll("input,textarea")].every(
            (node) => {
              const rect = node.getBoundingClientRect();
              return (
                Math.abs(rect.left - left) <= 0.5 &&
                Math.abs(rect.right - right) <= 0.5
              );
            },
          ),
          actionsFit: [
            ...root.querySelectorAll(".dialog__actions button"),
          ].every((node) => {
            const rect = node.getBoundingClientRect();
            return rect.left >= left - 0.5 && rect.right <= right + 0.5;
          }),
        };
      });
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client);
      expect(geometry.textFits).toBe(true);
      expect(geometry.fieldsMatch).toBe(true);
      expect(geometry.actionsFit).toBe(true);
      await expect(
        dialog.getByRole("heading", { name: title, exact: true }),
      ).toHaveText(title);
    }
    if (method === "editor") {
      await expect(
        dialog.getByRole("textbox", { name: title, exact: true }),
      ).toHaveValue("Keep the original notes.\nCompare the residuals.");
      await page.setViewportSize({ width: 820, height: 420 });
      const save = dialog.getByRole("button", { name: "Save", exact: true });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
      const heading = dialog.getByRole("heading", { name: title, exact: true });
      await heading.scrollIntoViewIfNeeded();
      await expect(heading).toBeInViewport();
    }
    await dialog.press("Escape");
    await expect(dialog).toHaveCount(0);
    expect(fixture.responses.at(-1)).toMatchObject({ id, cancelled: true });
  }
});

const summaryLines = [
  "Code: Shared interaction",
  "Run /ui-demo clear to remove the demo displays.",
];
const noteLines = ["Check keyboard.", "Check touch."];

function publishDisplays(
  fixture: Awaited<ReturnType<typeof openExample>>,
  status: string,
) {
  fixture.display({
    id: "status",
    method: "setStatus",
    statusKey: "example.ui",
    statusText: status,
  });
  fixture.display({
    id: "above",
    method: "setWidget",
    widgetKey: "example.ui-summary",
    widgetLines: summaryLines,
    widgetPlacement: "aboveEditor",
  });
  fixture.display({
    id: "below",
    method: "setWidget",
    widgetKey: "example.ui-notes",
    widgetLines: noteLines,
    widgetPlacement: "belowEditor",
  });
  fixture.message();
}

function clearDisplays(fixture: Awaited<ReturnType<typeof openExample>>) {
  fixture.display({
    id: "clear-status",
    method: "setStatus",
    statusKey: "example.ui",
  });
  fixture.display({
    id: "clear-above",
    method: "setWidget",
    widgetKey: "example.ui-summary",
  });
  fixture.display({
    id: "clear-below",
    method: "setWidget",
    widgetKey: "example.ui-notes",
  });
}

test("native dialog keyboard/pointer flow, deadline reconnect and content-first desktop reading", async ({
  page,
  context,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1280, height: 900 });
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const fixture = await openExample(page, "light");
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep this unsent draft");
  await draft.focus();
  fixture.question({ id: "select-keyboard", ...choice });
  const code = page.getByRole("option", { name: "Code", exact: true });
  await expect(
    page.getByRole("option", { name: "Documentation", exact: true }),
  ).toBeFocused();
  await expect(page.getByRole("listbox").locator("svg")).toHaveCount(0);
  const hoverChoice = page.getByRole("option", { name: "Tests", exact: true });
  const restingBackground = await hoverChoice.evaluate(
    (el) => getComputedStyle(el).backgroundColor,
  );
  await hoverChoice.hover();
  await expect
    .poll(() =>
      hoverChoice.evaluate((el) => getComputedStyle(el).backgroundColor),
    )
    .not.toBe(restingBackground);
  expect(
    await hoverChoice.evaluate(
      (element) => getComputedStyle(element).boxShadow,
    ),
  ).not.toBe("none");
  await page.mouse.move(0, 0);
  expect(fixture.responses).toHaveLength(0);
  await page.keyboard.press("ArrowDown");
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(code).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("ArrowDown");

  expect(
    (await new AxeBuilder({ page }).include(".dialog").analyze()).violations,
  ).toEqual([]);
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.responses).toMatchObject([
    { id: "select-keyboard", value: "Code" },
  ]);
  await expect(draft).toBeFocused();
  await expect(draft).toHaveValue("Keep this unsent draft");
  fixture.question({ id: "select-pointer", ...choice });
  await page.getByRole("option", { name: "Tests", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.responses.at(-1)).toMatchObject({
    id: "select-pointer",
    value: "Tests",
  });
  fixture.question({
    id: "confirm",
    method: "confirm",
    title: "Prepare this review?",
    message: "Code",
  });
  const confirm = page.getByRole("dialog", { name: "Prepare this review?" });
  await expect(confirm.getByRole("button")).toHaveText(["No", "Yes"]);
  await expect(confirm).toHaveAttribute("aria-busy", "false");
  await expect(
    confirm.getByRole("button", { name: "Yes", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(confirm).toHaveCount(0);
  expect(fixture.responses.at(-1)).toMatchObject({
    id: "confirm",
    cancelled: true,
  });
  fixture.question({ id: "input", method: "input", title: "Review name" });
  await page
    .getByRole("textbox", { name: "Review name", exact: true })
    .fill("Shared interaction");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.responses.at(-1)).toMatchObject({
    id: "input",
    value: "Shared interaction",
  });
  fixture.question({
    id: "editor",
    method: "editor",
    title: "Review notes",
    prefill: "Check keyboard.\nCheck touch.",
  });
  const editor = page.getByRole("textbox", {
    name: "Review notes",
    exact: true,
  });
  await expect(editor).toHaveValue(noteLines.join("\n"));
  await expect(editor).toBeEnabled();
  await moveCaretToEnd(editor);
  await editor.press("Enter");
  await editor.pressSequentially("Record the outcome.");
  await expect(
    page.getByRole("dialog", { name: "Review notes" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  expect(fixture.responses.at(-1)).toMatchObject({
    id: "editor",
    value: "Check keyboard.\nCheck touch.\nRecord the outcome.",
  });
  const expiresAt = Date.now() + 15_000;
  fixture.question({
    id: "timed",
    method: "input",
    title: "Timed note",
    timeout: 15_000,
    expiresAt,
  });
  await expect(page.locator(".dialog__remaining")).toBeVisible();
  await page.waitForTimeout(1_200);
  await fixture.reload();
  await expect(page.getByRole("dialog", { name: "Timed note" })).toBeVisible();
  const remaining = Number(
    (await page.locator(".dialog__remaining").textContent())!.split("s")[0],
  );
  expect(remaining).toBeLessThan(15);
  expect(remaining).toBeLessThanOrEqual(
    Math.ceil((expiresAt - Date.now()) / 1_000),
  );
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  const status = "Code review ready: Shared interaction";
  publishDisplays(fixture, status);
  await expect(page.locator(".topbar__extension-status")).toHaveText(status);
  const above = page.getByRole("region", {
    name: "Extension content above composer",
  });
  await expect(above).toContainText(summaryLines.join("\n"));
  await expect(
    page.getByText("example.ui-summary", { exact: true }),
  ).toHaveCount(0);
  await above
    .getByRole("button", { name: "Copy extension widget", exact: true })
    .click();
  await expect.poll(() => clipboardLines(page)).toEqual(summaryLines);
  const message = page.getByRole("article", { name: "Review prepared" });
  await expect(message).toContainText("Check touch.");
  await expect(message.locator(".custom-message__body strong")).toHaveText(
    "Code review:",
  );

  clearDisplays(fixture);
  await expect(
    page.locator(".topbar__extension-status, .extension-dock"),
  ).toHaveCount(0);
  await expect(message).toBeVisible();
  expect(errors).toEqual([]);
});

test.describe("short touch workbench", () => {
  test.use({ hasTouch: true });
  test("short windows share space between the transcript, draft and both widget placements", async ({
    page,
  }) => {
    const fixture = await openExample(page, "light");
    publishDisplays(fixture, "Review ready");
    const draft =
      "Review the change\nCheck the layout\nPreserve the draft\nCheck the controls\nContinue";
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill(draft);
    for (const [width, height] of [
      [901, 390],
      [844, 390],
      [568, 320],
    ]) {
      await page.setViewportSize({ width, height });
      for (const lines of [
        ["Review ready"],
        Array.from({ length: 8 }, (_, index) => `Review detail ${index + 1}`),
      ]) {
        for (const placement of ["above", "below"] as const) {
          fixture.display({
            id: `${placement}-${lines.length}`,
            method: "setWidget",
            widgetKey:
              placement === "above" ? "example.ui-summary" : "example.ui-notes",
            widgetLines: lines,
            widgetPlacement:
              placement === "above" ? "aboveEditor" : "belowEditor",
          });
        }
        await expect(page.locator(".extension-display__text")).toHaveText([
          lines.join("\n"),
          lines.join("\n"),
        ]);
        await expect
          .poll(() =>
            page.evaluate(() => {
              const bounds = (selector: string) =>
                document.querySelector(selector)!.getBoundingClientRect();
              const stage = bounds(".reading-stage");
              const transcript = bounds(".transcript");
              const above = bounds(".extension-dock--above");
              const composer = bounds(".composer");
              const toolbar = bounds(".composer__meta");
              const below = bounds(".extension-dock--below");
              return (
                transcript.bottom <= above.top &&
                above.bottom <= composer.top &&
                composer.bottom <= below.top &&
                toolbar.bottom <= composer.bottom &&
                below.bottom <= stage.bottom &&
                transcript.height >= 48
              );
            }),
          )
          .toBe(true);
        await expect(input).toHaveValue(draft);
        if ((width === 844 || width === 568) && lines.length > 1) {
          await input.fill("First line of the draft\nSecond line of the draft");
          await input.evaluate((element: HTMLTextAreaElement) => {
            element.setSelectionRange(0, 0);
            element.scrollTop = 0;
          });
          await input.hover();
          await page.mouse.wheel(0, 100);
          await expect
            .poll(() =>
              input.evaluate(
                (element) =>
                  element.scrollHeight -
                  element.clientHeight -
                  element.scrollTop,
              ),
            )
            .toBeLessThanOrEqual(1);
          await input.fill(draft);
        }
        await page
          .getByRole("button", { name: "Send message", exact: true })
          .click({ trial: true });
        for (const placement of ["above", "below"]) {
          const widget = page.getByRole("region", {
            name: `Extension content ${placement} composer`,
          });
          await widget.focus();
          await widget.press("Home");
          const copy = widget.getByRole("button", {
            name: "Copy extension widget",
            exact: true,
          });
          await expect
            .poll(() =>
              copy.evaluate((button) => {
                const box = button.getBoundingClientRect();
                return (
                  box.width >= 32 &&
                  box.height >= 32 &&
                  [
                    [box.left + box.width / 2, box.top + 2],
                    [box.left + box.width / 2, box.bottom - 2],
                    [box.left + 2, box.top + box.height / 2],
                    [box.right - 2, box.top + box.height / 2],
                  ].every(([x, y]) =>
                    button.contains(document.elementFromPoint(x, y)),
                  )
                );
              }),
            )
            .toBe(true);
          if (lines.length > 1) {
            await widget.press("End");
            await expect
              .poll(() => widget.evaluate((el) => el.scrollTop))
              .toBeGreaterThan(0);
          }
          const lineHeight = await widget
            .locator("pre")
            .evaluate((el) => getComputedStyle(el).lineHeight);
          expect(Number.parseFloat(lineHeight)).toBeGreaterThanOrEqual(18);
        }
      }
    }
    // Larger windows restore the complete headings and natural content heights.
    await page.setViewportSize({ width: 1366, height: 900 });
    await expect(
      page.locator(".extension-display__head > span").first(),
    ).toBeVisible();
    await expect(input).toHaveValue(draft);
  });
});

test.describe("narrow touch reading", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("chooses directly and reads complete topbar status on touch", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const fixture = await openExample(page, "dark");
    fixture.question({ id: "select-touch", ...choice });
    const code = page.getByRole("option", { name: "Code", exact: true });
    await expect
      .poll(async () => (await code.boundingBox())?.height ?? 0)
      .toBeGreaterThanOrEqual(44);
    await code.tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(fixture.responses.at(-1)).toMatchObject({
      id: "select-touch",
      value: "Code",
    });
    const status =
      "Code review ready: Shared interaction. " +
      "Check the shared keyboard and touch behavior. ".repeat(18) +
      "\nComplete status end.";
    publishDisplays(fixture, status);
    await expect(
      page
        .getByRole("article", { name: "Review prepared" })
        .locator(".custom-message__body strong"),
    ).toHaveText("Code review:");
    const summary = page.getByRole("button", {
      name: "Extension status",
      exact: true,
    });
    await expect(summary).toBeVisible();
    expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(
      await page
        .locator(".topbar__extension-text")
        .evaluate((element) => element.scrollWidth > element.clientWidth),
    ).toBe(true);
    await expect(page.locator(".topbar__extension-status")).toBeVisible();

    await summary.tap();
    const full = page.getByRole("dialog", {
      name: "Extension status",
      exact: true,
    });
    await expect(full).toHaveText(status);
    await expect(full).toBeFocused();
    await page.keyboard.press("End");
    await expect
      .poll(() => full.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
    expect(
      await page
        .locator(".center")
        .evaluate((element) => element.scrollWidth <= element.clientWidth),
    ).toBe(true);
    expect(
      (
        await new AxeBuilder({ page })
          .include(".topbar__extension-status")
          .include(".extension-status-popover")
          .include(".extension-dock")
          .analyze()
      ).violations,
    ).toEqual([]);

    await summary.tap();
    await expect(full).toBeHidden();
    for (const widget of await page.locator(".extension-display").all()) {
      const spacing = await widget.evaluate((el) => {
        const card = el.getBoundingClientRect();
        const head = el
          .querySelector(".extension-display__head")!
          .getBoundingClientRect();
        const body = el
          .querySelector(".extension-display__text")!
          .getBoundingClientRect();
        const copy = el
          .querySelector(".extension-display__copy")!
          .getBoundingClientRect();
        return {
          headerHeight: head.height,
          gap: body.top - head.bottom,
          verticalBalance: head.top - card.top - (card.bottom - body.bottom),
          copyHeight: copy.height,
          copyInside: copy.top >= card.top + 2 && copy.bottom <= body.top,
        };
      });
      expect(spacing.headerHeight).toBeCloseTo(24, 2);
      expect(spacing.gap).toBeCloseTo(4, 2);
      expect(Math.abs(spacing.verticalBalance)).toBeLessThanOrEqual(1);
      expect(spacing.copyHeight).toBeGreaterThanOrEqual(32);
      expect(spacing.copyInside).toBe(true);
    }
    const below = page.getByRole("region", {
      name: "Extension content below composer",
      exact: true,
    });
    await below
      .getByRole("button", { name: "Copy extension widget", exact: true })
      .tap();
    await expect.poll(() => clipboardLines(page)).toEqual(noteLines);
    clearDisplays(fixture);
    await expect(
      page.locator(
        ".topbar__extension-status, .extension-status-popover, .extension-dock",
      ),
    ).toHaveCount(0);
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
  });
});
