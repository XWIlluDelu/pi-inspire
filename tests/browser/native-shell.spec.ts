import { expect, test } from "@playwright/test";
import type { ActiveSnapshot } from "../../shared/contracts";
import { routeSnapshots } from "./support/host-events";
import { openFixtureSession, pairedPage } from "./support/navigation";

// UI wire fixture only; real native execution is checked by the isolated Pi
// lifecycle integration tests, never the test Host or independent terminal.
test("native shell cards stream, stop, recall and fit the narrow composer without an automatic model turn", async ({
  page,
}) => {
  const sessionId = "fixture-history";
  const submitted: Array<Record<string, unknown>> = [];
  let stopped = 0;
  let modelBusy = false;
  const projectShell = (snapshot: ActiveSnapshot) => {
    if (snapshot.active?.sessionId !== sessionId) return;
    snapshot.runState = modelBusy ? "running" : "idle";
    snapshot.active.isStreaming = modelBusy;
    if (submitted.length && snapshot.active?.sessionId === sessionId) {
      snapshot.bashRunning = stopped === 0;
      snapshot.active.transcriptPage.messages.push({
        ...shell,
        output: "STREAMED_BROWSER_OUTPUT\n",
        __inspireBashRunning: stopped === 0,
        ...(stopped ? { cancelled: true, __inspireSettled: true } : {}),
      });
    }
  };
  const shell = {
    role: "bashExecution",
    timestamp: 123456,
    command: "printf browser",
    output: "",
    excludeFromContext: true,
    __inspireLiveId: "browser-native-shell",
    __inspireBashRunning: true,
  };
  const transport = await routeSnapshots(page, { snapshot: projectShell });
  await page.route("**/api/prompt", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    submitted.push(body);
    if (String(body.message).startsWith("!"))
      transport.send({
        type: "message_start",
        sessionId,
        message: shell,
        shellExecution: true,
        bashRunning: true,
      });
    await route.fulfill({
      status: 202,
      headers: { "X-Inspire-Authority": transport.authority() },
      json: {
        accepted: true,
        historyEntry: { text: body.message, images: [], files: [] },
      },
    });
  });
  await page.route("**/api/control/abort", async (route) => {
    stopped += 1;
    transport.send({
      type: "message_end",
      sessionId,
      shellExecution: true,
      bashRunning: false,
      message: {
        ...shell,
        output: "STREAMED_BROWSER_OUTPUT\n",
        cancelled: true,
        __inspireBashRunning: false,
      },
    });
    transport.send({ type: "bash_finished", sessionId, bashRunning: false });
    await route.fulfill({
      headers: { "X-Inspire-Authority": transport.authority() },
      json: { steering: [], followUp: [] },
    });
  });

  await pairedPage(page);
  await openFixtureSession(page, /Review extension event lifecycle/, sessionId);
  await expect.poll(() => transport.ready(sessionId)).toBe(true);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const run = page.getByRole("button", {
    name: "Run shell command",
    exact: true,
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: "shell-draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("keep the unsent attachment"),
  });
  const remove = page.getByRole("button", {
    name: "Remove shell-draft.txt",
    exact: true,
  });
  await expect(page.locator(".attachment--ready")).toBeVisible();
  await input.fill("!!printf browser");
  await run.click();
  await expect(
    page.getByText(/Shell commands cannot include attachments/),
  ).toBeVisible();
  await expect(remove).toBeVisible();
  expect(submitted).toEqual([]);
  await remove.click();

  modelBusy = true;
  transport.send({ type: "agent_start", sessionId });
  const delivery = page.getByRole("group", { name: "Message delivery" });
  await delivery.getByRole("button", { name: "Queue", exact: true }).click();
  await run.click();
  await expect(input).toHaveValue("");
  const card = page.getByRole("region", { name: "Shell command" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Running", { exact: true })).toBeVisible();
  await expect(card.getByText("Excluded from context")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Abort running task", exact: true }),
  ).toBeVisible();
  expect(submitted).toHaveLength(1);
  expect(submitted[0]).toMatchObject({
    sessionId,
    message: "!!printf browser",
  });
  expect(submitted[0]!.behavior).toBeUndefined();
  transport.send({
    type: "message_update",
    sessionId,
    shellExecution: true,
    bashRunning: true,
    message: { ...shell, output: "STREAMED_BROWSER_OUTPUT\n" },
  });
  await expect(card.getByText("STREAMED_BROWSER_OUTPUT")).toBeVisible();
  await expect(delivery).toBeVisible();

  modelBusy = false;
  transport.send({ type: "agent_settled", sessionId });
  await expect(delivery).toBeHidden();
  await input.fill("!pwd");
  await expect(
    page.getByRole("button", { name: "Run shell command" }),
  ).toBeEnabled();
  await input.fill("Explicit model input during shell.");
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(input).toHaveValue("");
  expect(submitted).toHaveLength(2);
  expect(submitted[1]!.message).toBe("Explicit model input during shell.");
  expect(submitted[1]!.behavior).toBeUndefined();
  await input.press("Escape");
  await expect(card.getByText("Cancelled", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Abort running task", exact: true }),
  ).toHaveCount(0);
  expect(stopped).toBe(1);
  await input.press("ArrowUp");
  await expect(input).toHaveValue("Explicit model input during shell.");
  await input.press("ArrowUp");
  await expect(input).toHaveValue("!!printf browser");
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  await expect(input).toHaveValue("");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(card).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(
    card.getByRole("button", { name: /Copy shell result/ }),
  ).toBeVisible();
  await transport.reload(sessionId);
  await expect(card).toHaveCount(1);
  await expect(card.getByText("Cancelled", { exact: true })).toBeVisible();
});
