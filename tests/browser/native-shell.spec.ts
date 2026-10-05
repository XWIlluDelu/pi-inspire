import { expect, test, type WebSocketRoute } from "@playwright/test";
import type { ActiveSnapshot } from "../../shared/contracts";

// UI wire fixture only; real native execution is checked by the isolated Pi
// lifecycle integration tests, never the mock Host or independent terminal.
test("native shell cards stream, stop, recall and fit the narrow composer without an automatic model turn", async ({
  page,
}) => {
  let socket!: WebSocketRoute;
  let authority = "";
  let sessionId = "";
  const submitted: Array<Record<string, unknown>> = [];
  let stopped = 0;
  const projectShell = (snapshot: ActiveSnapshot) => {
    if (submitted.length && snapshot.active?.sessionId === sessionId) {
      snapshot.bashRunning = stopped === 0;
      snapshot.active.transcriptPage.messages.push({
        ...shell,
        output: "STREAMED_BROWSER_OUTPUT\n",
        __inspireBashRunning: stopped === 0,
        ...(stopped ? { cancelled: true, __inspireSettled: true } : {}),
      });
    }
    return snapshot;
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
  await page.routeWebSocket("**/events**", (ws) => {
    socket = ws;
    const upstream = ws.connectToServer();
    upstream.onMessage((message) => {
      const event = JSON.parse(String(message));
      if (event.type === "snapshot" && event.data)
        event.data = projectShell(event.data);
      ws.send(JSON.stringify(event));
    });
    ws.onMessage((message) => upstream.send(message));
  });
  await page.route("**/api/bootstrap**", async (route) => {
    const response = await route.fetch();
    authority = response.headers()["x-inspire-authority"] ?? "";
    await route.fulfill({ response });
  });
  await page.route("**/api/prompt", async (route) => {
    const body = route.request().postDataJSON() as Record<string, unknown>;
    submitted.push(body);
    sessionId = String(body.sessionId);
    if (String(body.message).startsWith("!"))
      socket.send(
        JSON.stringify({
          type: "message_start",
          sessionId,
          message: shell,
          shellExecution: true,
          bashRunning: true,
        }),
      );
    await route.fulfill({
      status: 202,
      headers: { "X-Inspire-Authority": authority },
      json: {
        accepted: true,
        historyEntry: { text: body.message, images: [], files: [] },
      },
    });
  });
  await page.route("**/api/snapshot**", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: projectShell(await response.json()),
    });
  });
  await page.route("**/api/control/abort", async (route) => {
    stopped += 1;
    socket.send(
      JSON.stringify({
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
      }),
    );
    socket.send(
      JSON.stringify({ type: "bash_finished", sessionId, bashRunning: false }),
    );
    await route.fulfill({
      headers: { "X-Inspire-Authority": authority },
      json: { steering: [], followUp: [] },
    });
  });

  await page.goto("/");
  await page.getByLabel("Access token").fill("inspire-browser-test-token");
  await page.getByRole("button", { name: "Pair" }).click();
  await page
    .locator(".nav__row-main")
    .filter({ hasText: /Review extension event lifecycle/ })
    .click();
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.fill("!!printf browser");
  await page
    .getByRole("button", { name: "Run shell command", exact: true })
    .click();
  await expect(input).toHaveValue("");
  const card = page.getByRole("region", { name: "Shell command" });
  await expect(card).toBeVisible();
  await expect(card.getByText("Running", { exact: true })).toBeVisible();
  await expect(card.getByText("Excluded from context")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Abort running task", exact: true }),
  ).toBeVisible();
  expect(submitted).toHaveLength(1);
  expect(submitted[0]!.message).toBe("!!printf browser");
  expect(submitted[0]!.behavior).toBeUndefined();
  socket.send(
    JSON.stringify({
      type: "message_update",
      sessionId,
      shellExecution: true,
      bashRunning: true,
      message: { ...shell, output: "STREAMED_BROWSER_OUTPUT\n" },
    }),
  );
  await expect(card.getByText("STREAMED_BROWSER_OUTPUT")).toBeVisible();
  await page.screenshot({ path: "output/playwright/native-shell-desktop.png" });
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
  await page.screenshot({ path: "output/playwright/native-shell-narrow.png" });
});
