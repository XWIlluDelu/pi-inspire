import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import type {
  ActiveSnapshot,
  ExtensionDisplay,
  ExtensionUiRequest,
  SupportedExtensionUiRequest,
} from "../../shared/contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { clipboardLines } from "./support/clipboard";
import { routeSnapshots } from "./support/host-events";
import { completeOperation } from "./support/host-operations";
import { hostRequest } from "./support/host-request";
import { moveCaretToEnd } from "./support/native-input";
import {
  openCommandPalette,
  openSettings,
  pairedPage,
  reloadSession,
} from "./support/navigation";

// Audit settled dialog colors, not intermediate entrance-animation opacity.
test.use({
  serviceWorkers: "block",
  contextOptions: { reducedMotion: "reduce" },
});

type DemoQuestion =
  | Omit<SupportedExtensionUiRequest, "sessionId">
  | {
      id: string;
      method: string;
      title: string;
      unsupported: true;
      payload: unknown;
    };

// Synthetic questions control response timing and layout independently of Pi.
async function openExample(page: Page, theme: "light" | "dark") {
  let sessionId: string | null = null;
  const pending = new Map<string, ExtensionUiRequest>();
  let displays: ExtensionDisplay[] = [];
  let statuses: Record<string, string> = {};
  const responses: Record<string, unknown>[] = [];
  const transport = await routeSnapshots(page, {
    snapshot: (snapshot) => {
      if (snapshot.active?.sessionId === sessionId) {
        snapshot.pendingExtensionUiRequests = [...pending.values()];
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
  const answer = (response: Record<string, unknown>) => {
    expect(response.sessionId).toBe(sessionId);
    responses.push(response);
    pending.delete(String(response.id));
    emit({ type: "extension_ui_remove", id: response.id, reason: "answered" });
  };
  await page.route("**/api/extension-ui", async (route) => {
    answer(route.request().postDataJSON());
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
  await transport.reload(exampleSessionId, () =>
    reloadSession(page, exampleSessionId),
  );
  await expect(
    page.getByRole("button", { name: /^Session actions:/ }),
  ).toHaveText("Native UI example");
  return {
    answer,
    responses,
    emit,
    question(fields: DemoQuestion) {
      const request = { ...fields, sessionId: sessionId! };
      pending.set(request.id, request);
      emit({ type: "extension_ui_request", ...request });
    },
    display(event: {
      id: string;
      method: string;
      extensionStatuses?: Record<string, string>;
      extensionDisplays?: ExtensionDisplay[];
    }) {
      statuses = event.extensionStatuses ?? statuses;
      displays = event.extensionDisplays ?? displays;
      emit({ type: "extension_ui_request", responseRequired: false, ...event });
    },
  };
}

test("phone Back and Escape respect native question ownership during Settings, work and recovery", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 700 });
  await page.goto("about:blank#outside-inspire");
  const demo = await openExample(page, "dark");
  const inspireUrl = page.url();
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep this draft through the questions");
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  let refuse = true;
  const cancellation = Promise.withResolvers<void>();
  const acknowledgement = Promise.withResolvers<void>();
  let attempts = 0;
  await page.route("**/api/extension-ui", async (route) => {
    attempts++;
    const response = route.request().postDataJSON();
    if (refuse) {
      await cancellation.promise;
      await route.fulfill({
        status: 409,
        json: { error: "The extension is still waiting. Try again." },
      });
    } else if (response.id === "first-back") {
      demo.answer(response);
      await acknowledgement.promise;
      await route.fulfill({ json: { ok: true } });
    } else await route.fallback();
  });
  demo.question({
    id: "first-back",
    method: "input",
    title: "First native question",
  });
  demo.question({
    id: "next-back",
    method: "confirm",
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
    await expect.poll(() => attempts).toBe(1);
    await page.goBack();
    await expect(first).toBeVisible();
    await expect(page).toHaveURL(inspireUrl);
  } finally {
    cancellation.resolve();
  }
  await expect(first.getByRole("alert")).toContainText("Try again");
  expect(demo.responses).toEqual([]);
  refuse = false;
  const next = page.getByRole("dialog", {
    name: "Next native question",
    exact: true,
  });
  try {
    await page.goBack();
    await expect(next).toHaveAttribute("aria-busy", "true");
    await expect(next).toBeFocused();
  } finally {
    acknowledgement.resolve();
  }
  await expect(
    next.getByRole("button", { name: "Yes", exact: true }),
  ).toBeFocused();
  await page.goBack();
  await expect(next).toHaveCount(0);
  expect(attempts).toBe(3);
  expect(
    demo.responses.map(({ id, cancelled }) => ({ id, cancelled })),
  ).toEqual([
    { id: "first-back", cancelled: true },
    { id: "next-back", cancelled: true },
  ]);
  await expect(settings).toBeVisible();
  await page.goBack();
  await expect(settings).toHaveCount(0);
  await expect(draft).toHaveValue("Keep this draft through the questions");

  let aborts = 0;
  await page.route("**/api/control/abort", (route) => {
    aborts++;
    return completeOperation(route, "abort", { steering: [], followUp: [] });
  });
  demo.emit({ type: "agent_start", sessionStatus: { runState: "running" } });
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
  expect(demo.responses.at(-1)).toMatchObject({
    id: "during-run",
    cancelled: true,
  });
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
  await page.keyboard.press("Escape");
  await expect.poll(() => aborts).toBe(1);
  expect(demo.responses).toHaveLength(3);
  demo.emit({
    type: "extension_ui_remove",
    id: "during-conflict",
    reason: "aborted",
  });
  await expect(blocked).toHaveCount(0);
  await page.goBack();
  await expect(page).toHaveURL("about:blank#outside-inspire");
});

const choiceTitle = "Choose a review";

const summaryLines = [
  "Code: Shared interaction",
  "Run /ui-demo clear to remove the demo displays.",
];

test("real Pi questions preserve workbench edits and restore the native deadline on reload", async ({
  page,
  context,
}, testInfo) => {
  const cwd = testInfo.outputPath("native-workspace");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ extensions: [resolve("docs/examples/native-ui.ts")] }),
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await pairedPage(page);
  const created = await hostRequest(page).post("/api/sessions/new", {
    data: { cwd, name: "Native UI example" },
  });
  expect(created.ok()).toBe(true);
  const { active } = (await created.json()) as ActiveSnapshot;
  await reloadSession(page, active!.sessionId);

  const run = async (args = "") => {
    const palette = await openCommandPalette(page);
    await palette.getByLabel("Filter commands").fill("/ui-demo");
    await palette.getByRole("option", { name: /^\/ui-demo/ }).click();
    await palette.getByLabel("Prepared command").fill(`/ui-demo ${args}`);
    await palette.getByRole("button", { name: "Run", exact: true }).click();
  };
  const draft = page.getByRole("textbox", { name: "Message", exact: true });
  await draft.fill("Keep this unsent draft");
  await run();
  const choices = page.getByRole("listbox", { name: choiceTitle });
  await expect(
    choices.getByRole("option", { name: "Documentation" }),
  ).toBeFocused();
  const code = choices.getByRole("option", { name: "Code", exact: true });
  await page.keyboard.press("ArrowDown");
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute("aria-selected", "true");
  expect(
    (await new AxeBuilder({ page }).include(".extension-dialog").analyze())
      .violations,
  ).toEqual([]);
  await page.keyboard.press("Enter");
  const confirm = page.getByRole("dialog", { name: "Prepare this review?" });
  await expect(confirm).toContainText("Code");
  await expect(confirm.getByRole("button", { name: "Yes" })).toBeFocused();
  await confirm.getByRole("button", { name: "Yes" }).click();
  const name = page.getByRole("textbox", { name: "Review name", exact: true });
  await name.fill("Shared interaction");
  await name.press("Enter");
  const editor = page.getByRole("textbox", {
    name: "Review notes",
    exact: true,
  });
  const initialNotes = "Check the main behavior.\nRecord the outcome.";
  await expect(editor).toHaveValue(initialNotes);
  await moveCaretToEnd(editor);
  await editor.press("Enter");
  await editor.pressSequentially("Keep this note.");
  const save = page.getByRole("button", { name: "Save", exact: true });
  await page.route(
    "**/api/extension-ui",
    (route) =>
      route.fulfill({
        status: 409,
        json: { error: "The extension could not save these notes. Try again." },
      }),
    { times: 1 },
  );
  await save.click();
  const error = page
    .getByRole("dialog", { name: "Review notes" })
    .getByRole("alert");
  await expect(error).toContainText("Try again");
  await editor.press("Tab");
  await expect(error).toBeFocused();
  await expect(editor).toHaveValue(`${initialNotes}\nKeep this note.`);
  await expect(page.locator(".notice--error, .notice--warning")).toHaveCount(0);
  await save.press("Enter");

  const message = page.getByRole("article", { name: "Review prepared" });
  await expect(message.locator(".custom-message__body strong")).toHaveText(
    "Code review:",
  );
  await expect(message).toContainText("Keep this note.");
  await expect(page.locator(".topbar__extension-status")).toHaveText(
    "Code review ready: Shared interaction",
  );
  const above = page.getByRole("region", {
    name: "Extension content above composer",
  });
  const below = page.getByRole("region", {
    name: "Extension content below composer",
  });
  await expect(below).toContainText("Keep this note.");
  await above.getByRole("button", { name: "Copy extension widget" }).click();
  await expect.poll(() => clipboardLines(page)).toEqual(summaryLines);
  await expect(draft).toHaveValue("Keep this unsent draft");

  await page.setViewportSize({ width: 390, height: 844 });
  let restartRequests = 0;
  await page.route("**/api/host/restart", (route) => {
    if (route.request().method() !== "GET") restartRequests++;
    return route.fulfill({
      json: {
        hostId: "settings-host",
        available: true,
        allPiAvailable: true,
        operation: null,
      },
    });
  });
  await openSettings(page);
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  const models = settings.getByRole("button", { name: "Models", exact: true });
  await models.click();
  await settings
    .getByRole("button", { name: "Add provider", exact: true })
    .click();
  const id = settings.getByLabel("Provider ID", { exact: true });
  const url = settings.getByLabel("Base URL", { exact: true });
  await id.fill("pending-provider");
  await url.fill("https://example.invalid/v1");
  await settings.getByRole("button", { name: "System", exact: true }).click();
  await settings
    .getByRole("button", { name: "Restart all", exact: true })
    .click();
  const restart = page.getByRole("alertdialog", { name: "Restart all?" });
  await expect(restart).toBeVisible();

  // Dispatch from another client while Settings owns browser focus.
  const host = hostRequest(page);
  const { authorityId } = await (await host.get("/api/bootstrap")).json();
  const interruption = await host.post("/api/prompt", {
    data: {
      sessionId: active!.sessionId,
      operationId: crypto.randomUUID(),
      authorityId,
      message: "/ui-demo",
    },
  });
  expect(interruption.status()).toBe(202);
  await expect(choices).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(
    page.getByRole("dialog", { name: choiceTitle }).locator(":focus"),
  ).toBeVisible();
  await expect(restart).toBeHidden();
  await choices
    .getByRole("option", { name: "Documentation", exact: true })
    .click();
  await expect(confirm).toBeVisible();
  await page.goBack();
  await expect(confirm).toBeHidden();
  await restart.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(restartRequests).toBe(0);
  await models.click();
  await expect(id).toHaveValue("pending-provider");
  await expect(url).toHaveValue("https://example.invalid/v1");
  await page.keyboard.press("Escape");
  await expect(settings).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Toggle navigation", exact: true }),
  ).toBeFocused();
  await expect(draft).toHaveValue("Keep this unsent draft");

  await run("timeout 15000");
  const timed = page.getByRole("dialog", { name: "Timed note" });
  const seconds = async () =>
    Number.parseInt(
      (await timed.locator(".dialog__remaining").textContent()) ?? "",
      10,
    );
  await expect.poll(seconds).toBeLessThan(15);
  const beforeReload = await seconds();
  await page.reload();
  await expect(timed).toBeVisible();
  expect(await seconds()).toBeLessThanOrEqual(beforeReload);
  await page.keyboard.press("Escape");
  await expect(timed).toBeHidden();
  await expect(above).toContainText(summaryLines.join("\n"));
  const retry = page.getByRole("button", {
    name: "Retry delivery",
    exact: true,
  });
  if (await retry.isVisible()) {
    await retry.click();
    await expect(retry).toHaveCount(0);
  }
  await expect(draft).toHaveValue("Keep this unsent draft");

  await run("clear");
  await expect(
    page.locator(".topbar__extension-status, .extension-dock"),
  ).toHaveCount(0);
  await expect(message).toBeVisible();
});

test.describe("short touch workbench", () => {
  test.use({ hasTouch: true });
  test("keeps the transcript, draft and both widgets usable in a short window", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const fixture = await openExample(page, "light");
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    const draft = "First line of the draft\nSecond line of the draft";
    await input.fill(draft);
    const lines = Array.from(
      { length: 8 },
      (_, index) => `Review detail ${index + 1}`,
    );
    const placements = [
      ["above", "aboveEditor"],
      ["below", "belowEditor"],
    ] as const;
    fixture.display({
      id: "widgets",
      method: "setWidget",
      extensionDisplays: placements.map(([placement, widgetPlacement]) => ({
        id: placement,
        kind: "widget",
        label: placement,
        source: "Pi extension",
        placement: widgetPlacement,
        lines: lines.map((line) => `\u001b[32m${line}\u001b[0m`),
      })),
    });
    await page.setViewportSize({ width: 568, height: 320 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const bounds = (selector: string) =>
            document.querySelector(selector)!.getBoundingClientRect();
          const stage = bounds(".reading-stage");
          const transcript = bounds(".transcript");
          const above = bounds(".extension-dock--above");
          const composer = bounds(".composer");
          const below = bounds(".extension-dock--below");
          return (
            transcript.height > 0 &&
            transcript.bottom <= above.top &&
            above.bottom <= composer.top &&
            composer.bottom <= below.top &&
            below.bottom <= stage.bottom
          );
        }),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "Send message", exact: true })
      .tap({ trial: true });
    for (const [placement] of placements) {
      const widget = page.getByRole("region", {
        name: `Extension content ${placement} composer`,
      });
      await widget
        .getByRole("button", {
          name: "Copy extension widget",
          exact: true,
        })
        .tap();
      await expect.poll(() => clipboardLines(page)).toEqual(lines);
      await widget.focus();
      await widget.press("End");
      await expect
        .poll(() => widget.evaluate((el) => el.scrollTop))
        .toBeGreaterThan(0);
    }
    await input.evaluate((element: HTMLTextAreaElement) => {
      element.setSelectionRange(0, 0);
      element.scrollTop = 0;
    });
    await input.hover();
    await page.mouse.wheel(0, 100);
    await expect
      .poll(() => input.evaluate((el) => el.scrollTop))
      .toBeGreaterThan(0);
    await expect(input).toHaveValue(draft);
  });
});

test.describe("narrow touch reading", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test("chooses directly and reads complete topbar status on touch", async ({
    page,
  }) => {
    const fixture = await openExample(page, "dark");
    const selected =
      "Review this document: " + "documentation-reference-".repeat(6);
    fixture.question({
      id: "select-touch",
      method: "select",
      title: choiceTitle,
      options: [selected, "Code"],
    });
    const question = page.getByRole("dialog", { name: choiceTitle });
    await expect
      .poll(() => question.evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBe(0);
    await question.getByRole("option", { name: selected, exact: true }).tap();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    expect(fixture.responses.at(-1)).toMatchObject({
      id: "select-touch",
      value: selected,
    });
    const unsupportedTitle =
      "Choose files under /workspace/calibration/reference_measurement_comparison_for_multichannel_calibration_and_residual_validation_results.json";
    fixture.question({
      id: "choose-files",
      method: "chooseFiles",
      title: unsupportedTitle,
      unsupported: true,
      payload: { paths: ["report.md"] },
    });
    const unsupported = page.getByRole("dialog", {
      name: unsupportedTitle,
      exact: true,
    });
    await expect
      .poll(() =>
        unsupported
          .locator(".extension-dialog")
          .evaluate((el) => el.scrollWidth - el.clientWidth),
      )
      .toBe(0);
    await expect(unsupported).toContainText(
      "Inspire can't handle this extension request",
    );
    await unsupported.getByText("Request details", { exact: true }).click();
    await expect(unsupported.getByText(/report\.md/)).toBeVisible();
    await unsupported.getByRole("button", { name: "Cancel request" }).click();
    await expect(unsupported).toHaveCount(0);
    expect(fixture.responses.at(-1)).toMatchObject({
      id: "choose-files",
      cancelled: true,
    });

    const status =
      "Code review ready: Shared interaction. " +
      "Check the shared keyboard and touch behavior. ".repeat(18) +
      "\nComplete status end.";
    fixture.display({
      id: "status",
      method: "setStatus",
      extensionStatuses: { "example.ui": status },
    });
    const summary = page.getByRole("button", {
      name: "Extension status",
      exact: true,
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
          .include(".choice-panel__body--reader")
          .analyze()
      ).violations,
    ).toEqual([]);

    await summary.tap();
    await expect(full).toBeHidden();
    fixture.display({
      id: "build-panel",
      method: "showPanel",
      extensionDisplays: [
        {
          id: "showPanel:build",
          kind: "raw",
          label: "build",
          source: "extensions/build.ts",
          placement: "aboveEditor",
          method: "showPanel",
          payload: { status: "passing" },
        },
      ],
    });
    const fallback = page.getByRole("region", {
      name: "Extension display content",
    });
    await fallback.getByText("extensions/build.ts · build").click();
    await expect(fallback.getByText(/passing/)).toBeVisible();
    await expect(
      page.getByRole("textbox", { name: "Message", exact: true }),
    ).toBeVisible();
  });
});
