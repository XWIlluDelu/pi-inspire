import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import type {
  ActiveSnapshot,
  ExtensionDisplay,
  SupportedExtensionUiRequest,
} from "../../shared/contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";

test.use({ serviceWorkers: "block" });

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
// This fixture owns its matching browser questions while the isolated mock Host
// supplies pairing, navigation and snapshots; it never opens a user extension.
async function openExample(page: Page, theme: "light" | "dark") {
  let socket: WebSocketRoute | undefined;
  let readySocket: WebSocketRoute | undefined;
  let sessionId: string | null = null;
  let pending: SupportedExtensionUiRequest | null = null;
  let displays: ExtensionDisplay[] = [];
  const statuses: Record<string, string> = {};
  const responses: Record<string, unknown>[] = [];
  const decorate = (snapshot: ActiveSnapshot) => {
    if (snapshot.active && snapshot.active.sessionId === sessionId) {
      snapshot.pendingExtensionUiRequests = pending ? [pending] : [];
      snapshot.extensionStatuses = { ...statuses };
      snapshot.extensionDisplays = displays;
    }
    return snapshot;
  };
  await page.routeWebSocket(/\/events(?:\?|$)/, (client) => {
    socket = client;
    readySocket = undefined;
    const upstream = client.connectToServer();
    upstream.onMessage((data) => {
      if (socket !== client) return;
      const event = JSON.parse(String(data));
      if (event.type === "snapshot") {
        const owner = event.detailSessionId ?? event.data?.active?.sessionId;
        if (sessionId && owner === sessionId) readySocket = client;
        if (event.data) decorate(event.data);
      }
      client.send(JSON.stringify(event));
    });
  });
  for (const pattern of [
    "**/api/bootstrap",
    "**/api/snapshot**",
    "**/api/sessions/open",
  ]) {
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      if (data.snapshot) decorate(data.snapshot);
      else if (data.active) decorate(data);
      if (data.preferences) data.preferences = { ...data.preferences, theme };
      await route.fulfill({ response, json: data });
    });
  }
  const emit = (event: Record<string, unknown>) => {
    expect(
      socket,
      "Fixture events require the current synchronized connection",
    ).toBe(readySocket);
    socket!.send(JSON.stringify({ ...event, sessionId }));
  };
  await page.route("**/api/extension-ui", async (route) => {
    const response = route.request().postDataJSON();
    expect(response.sessionId).toBe(sessionId);
    responses.push(response);
    if (pending?.id === response.id) pending = null;
    emit({ type: "extension_ui_remove", id: response.id, reason: "answered" });
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByLabel("Access token").fill("inspire-browser-test-token");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("main")).toBeVisible();
  const created = await page.request.post("/api/sessions/new", {
    data: { cwd: browserWorkspace, name: "Native UI example" },
  });
  expect(created.ok()).toBe(true);
  const createdSnapshot: ActiveSnapshot = await created.json();
  expect(createdSnapshot.active?.sessionId).toBeTruthy();
  sessionId = createdSnapshot.active!.sessionId;
  const reload = async () => {
    const previousSocket = socket;
    await page.reload();
    await expect(
      page.getByRole("button", { name: /^Session actions:/ }),
    ).toHaveText("Native UI example");
    // A matching snapshot must arrive on the replacement connection, then the
    // app must acknowledge synchronization by removing its connection banner.
    await expect
      .poll(() => socket !== previousSocket && socket === readySocket)
      .toBe(true);
    await expect(
      page.getByRole("main").locator(".banner--warning"),
    ).toHaveCount(0);
  };
  await reload();
  return {
    responses,
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

const choice = {
  method: "select" as const,
  title: "Choose a review",
  options: ["Documentation", "Code", "Tests"],
};
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
  await page.keyboard.press("ArrowDown");
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("ArrowUp");
  await expect(code).toHaveAttribute("aria-selected", "false");
  await page.keyboard.press("ArrowDown");
  await page.screenshot({
    path: "output/playwright/extension-selection-desktop.png",
    animations: "disabled",
  });
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
  await editor.press("ControlOrMeta+End");
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
  await expect(page.locator(".extension-status")).toBeHidden();
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
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    summaryLines.join("\n"),
  );
  const message = page.getByRole("article", { name: "Review prepared" });
  await expect(message).toContainText("Check touch.");
  await expect(message.locator(".custom-message__body strong")).toHaveText(
    "Code review:",
  );
  await expect(message.locator(".custom-message__type")).toHaveCount(0);
  await page.getByRole("main").screenshot({
    path: "output/playwright/extension-content-desktop.png",
    animations: "disabled",
  });
  clearDisplays(fixture);
  await expect(
    page.locator(
      ".topbar__extension-status, .extension-status, .extension-dock",
    ),
  ).toHaveCount(0);
  await expect(message).toBeVisible();
  expect(errors).toEqual([]);
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
    await page.screenshot({
      path: "output/playwright/extension-content-narrow.png",
      animations: "disabled",
    });
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
    await page.screenshot({
      path: "output/playwright/extension-status-expanded-narrow.png",
      animations: "disabled",
    });
    await summary.tap();
    await expect(full).toBeHidden();
    const below = page.getByRole("region", {
      name: "Extension content below composer",
      exact: true,
    });
    await below
      .getByRole("button", { name: "Copy extension widget", exact: true })
      .tap();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      noteLines.join("\n"),
    );
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
