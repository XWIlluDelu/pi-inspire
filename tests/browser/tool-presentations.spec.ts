import type { AddressInfo } from "node:net";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import { createInspireServer } from "../../server/app";
import { AttachmentStore } from "../../server/attachments";
import { GitInspectionService } from "../../server/git-inspection";
import { MockCatalog, MockRuntime } from "../../server/mock";
import { PreferencesStore } from "../../server/preferences";
import { ResourceStore } from "../../server/resources";
import { ToolPresentationConfigStore } from "../../server/tool-presentation-config";
import type { ToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import type { ToolCallContent } from "../../src/events";
import { toolResultResourcesFixture } from "../fixtures/tool-result-resources.mjs";
import { browserWorkspace } from "./fixtures/workspace.mjs";

test.use({ serviceWorkers: "block" });

const configuration: ToolPresentationConfiguration = {
  version: 1,
  rules: {
    "review.files": {
      summary: [{ value: { path: "args.pattern" } }],
      blocks: [
        {
          type: "list",
          label: "Files",
          source: { path: "result.text" },
          format: "annotated-lines",
        },
      ],
    },
    "review.json": {
      summary: [{ value: { literal: "Metadata" } }],
      blocks: [
        {
          type: "code",
          source: { path: "args.data", format: "json" },
          language: "json",
          lineNumbers: false,
        },
      ],
    },
    "review.markdown": {
      summary: [{ value: { literal: "Documentation" } }],
      blocks: [{ type: "markdown", source: { path: "result.text" } }],
    },
  },
  mappings: {
    review_files: "review.files",
    review_json: "review.json",
    review_markdown: "review.markdown",
  },
};

// Drive the actual application's event transport and transcript, while the
// isolated mock Host continues to supply pairing, catalog and snapshots.
async function openReview(
  page: Page,
  preferences: Record<string, unknown> = {},
) {
  let socket: WebSocketRoute | undefined;
  let sessionId: string | null = null;
  await page.routeWebSocket(/\/events(?:\?|$)/, (client) => {
    socket = client;
    const server = client.connectToServer();
    server.onMessage((data) => {
      const event = JSON.parse(String(data));
      if (socket === client && event.type === "snapshot")
        sessionId =
          event.detailSessionId ?? event.data?.active?.sessionId ?? null;
      client.send(data);
    });
  });
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = await response.json();
    body.preferences = {
      ...body.preferences,
      theme: "light",
      toolVisibility: "expanded",
      activityFoldVisibility: "expanded",
      ...preferences,
    };
    body.toolPresentations = configuration;
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await page.getByLabel("Access token").fill("inspire-browser-test-token");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("main")).toBeVisible();
  // Own an empty session rather than depending on the Host selection left by
  // another browser file or earlier presentation case.
  const created = await page.request.post("/api/sessions/new", {
    data: { cwd: browserWorkspace, name: "Tool presentation review" },
  });
  expect(created.ok()).toBe(true);
  sessionId = null;
  socket = undefined;
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^Session actions:/ }),
  ).toHaveText("Tool presentation review");
  await expect.poll(() => sessionId).not.toBeNull();
  return (...events: Record<string, unknown>[]) => {
    for (const event of events)
      socket!.send(JSON.stringify({ ...event, sessionId }));
  };
}

for (const mobile of [false, true]) {
  test.describe(mobile ? "mobile child calls" : "desktop child calls", () => {
    test.use(
      mobile
        ? {
            viewport: { width: 390, height: 844 },
            isMobile: true,
            hasTouch: true,
          }
        : { viewport: { width: 1365, height: 950 } },
    );
    test("separates CodeMode calls from readable output and preserves whole-block copy", async ({
      page,
    }) => {
      const send = await openReview(page, { palette: "teal" });
      const call = tool("codemode", {
        code: "text(await tools.edit({path: 'src/components/transcript-cards.tsx', edits: []})); text({i: 1, result: await tools.bash({command: 'npm run typecheck'})}); await tools.ctx_reduce({drop: '1'});",
      });
      const stdout = [
        "npm notice run inspire-pi-gui@0.4.0 typecheck",
        "npm notice run tsc -b",
        ...Array.from(
          { length: 70 },
          (_, index) => `Checked fixture module ${index + 1}`,
        ),
      ].join("\n");
      const rawOutput = JSON.stringify({
        i: 1,
        result: {
          output: stdout,
          truncated: false,
          exit_code: 0,
          wall_time_seconds: 3.7,
        },
      });
      const result = {
        role: "toolResult",
        toolCallId: call.id,
        toolName: "codemode",
        isError: false,
        __inspireMessageId: "small-codemode-result",
        content: [
          {
            type: "text",
            text: "Script completed\nWall time 4.2 seconds\nOutput:\n",
          },
          {
            type: "text",
            text: "Successfully replaced 2 blocks in src/components/transcript-cards.tsx.",
          },
          { type: "text", text: rawOutput },
        ],
        details: {
          calls: [
            {
              id: "small/1",
              name: "edit",
              args: JSON.stringify({
                path: "src/components/transcript-cards.tsx",
                edits: [
                  {
                    oldText: "source\n".repeat(100),
                    newText: "updated source",
                  },
                ],
              }).slice(0, 200),
              status: "ok",
            },
            {
              id: "small/2",
              name: "bash",
              args: '{"command":"npm run typecheck"}',
              status: "ok",
              durationMs: 3700,
            },
            {
              id: "small/3",
              name: "ctx_reduce",
              args: '{"drop":"1"}',
              status: "ok",
            },
          ],
        },
      };
      send(
        { type: "agent_start" },
        { type: "message_start", message: assistant([call]) },
        {
          type: "tool_execution_start",
          toolCallId: call.id,
          toolName: "codemode",
          args: call.arguments,
        },
        {
          type: "tool_execution_end",
          toolCallId: call.id,
          toolName: "codemode",
          isError: false,
          result,
        },
        { type: "message_end", message: result },
      );
      const card = toolCard(page, "codemode");
      await expect(
        card.getByRole("group", { name: "Child calls" }).locator(".child-call"),
      ).toHaveCount(3);
      await expect(card.getByRole("button", { name: /^Calls / })).toHaveCount(
        0,
      );
      await expect(
        card.getByText(
          "Successfully replaced 2 blocks in src/components/transcript-cards.tsx.",
        ),
      ).toBeVisible();
      await expect(card.getByText("Script", { exact: true })).toBeVisible();
      await expect(card.getByText("Calls", { exact: true })).toBeVisible();
      await expect(card.getByText("Output", { exact: true })).toBeVisible();
      await expect(card.locator(".child-call__summary").first()).toHaveText(
        /src\/components\/transcript-cards\.tsx/,
      );
      await expect(
        card.locator(".child-call__summary").first(),
      ).not.toContainText("oldText");
      const output = card.getByRole("group", { name: "Result output" });
      const text = await output.locator("pre").last().textContent();
      expect(text).toMatch(/typecheck\n\s+npm notice run tsc -b/);
      expect(text).toContain('"truncated": false');
      expect(text).toContain('"result": {');
      await expect(
        card.getByRole("button", { name: "Copy codemode tool block" }),
      ).toHaveCount(1);
      await expect(
        card.getByRole("group", { name: "Result display" }),
      ).toHaveCount(0);
      await expect(
        card.getByText("Result details", { exact: true }),
      ).toHaveCount(0);
      expect(
        await card.evaluate((element) => {
          const calls = element
            .querySelector(".tool-call-list")!
            .getBoundingClientRect();
          const result = element
            .querySelector(".codemode-result")!
            .getBoundingClientRect();
          return result.top >= calls.bottom;
        }),
      ).toBe(true);
      expect(
        await output.evaluate(
          (element) => element.scrollHeight > element.clientHeight,
        ),
      ).toBe(true);
      await output.focus();
      await page.keyboard.press("ArrowDown");
      await expect
        .poll(() => output.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      await output.evaluate((element) => {
        element.scrollTop = 0;
      });
      await output.evaluate((element) => (element as HTMLElement).blur());
      await card
        .getByRole("button", { name: "Copy codemode tool block" })
        .click();
      await expect(card).not.toHaveClass(/card--failed/);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const accessibility = await new AxeBuilder({ page })
        .include(".card--tool")
        .analyze();
      expect(accessibility.violations).toEqual([]);
      await card.screenshot({
        path: `output/playwright/child-calls/${mobile ? "mobile" : "desktop"}-small.png`,
        animations: "disabled",
      });
      await card
        .getByRole("button", { name: "Collapse CodeMode tool" })
        .click();
      await expect(card.getByText("3 calls", { exact: true })).toBeVisible();
      await card.screenshot({
        path: `output/playwright/child-calls/${mobile ? "mobile" : "desktop"}-small-collapsed.png`,
        animations: "disabled",
      });
    });

    test("keeps a reading position through live settlement and reopens Calls before Result", async ({
      page,
    }) => {
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const send = await openReview(page, {
        toolVisibility: "dynamic",
        activityFoldVisibility: "dynamic",
      });
      const script =
        "const data = await tools.read({path: 'report.txt'}); text(data);";
      const calls = Array.from({ length: 80 }, (_, index) => ({
        id: "script/?",
        name: index === 0 ? "models.classify" : "read",
        args:
          index === 0
            ? "fixture/classifier"
            : JSON.stringify({ path: `src/report-${index}.txt`, limit: 30 }),
        status: "running",
      }));
      const assistantMessage = {
        role: "assistant",
        __inspireMessageId: "child-call-review",
        content: [
          {
            type: "toolCall",
            id: "script",
            name: "codemode",
            arguments: { code: script },
          },
          {
            type: "toolCall",
            id: "parent",
            name: "orchestrator",
            arguments: {},
          },
        ],
      };
      send(
        { type: "agent_start" },
        { type: "message_start", message: assistantMessage },
        {
          type: "tool_execution_start",
          toolCallId: "script",
          toolName: "codemode",
          args: { code: script },
        },
        {
          type: "tool_execution_update",
          toolCallId: "script",
          toolName: "codemode",
          partialResult: { content: [], details: { calls } },
        },
        {
          type: "tool_execution_start",
          toolCallId: "parent",
          toolName: "orchestrator",
          args: {},
        },
        {
          type: "tool_execution_start",
          parentToolCallId: "parent",
          toolCallId: "parent/1",
          toolName: "read",
          args: { path: "independent.txt" },
        },
      );
      const scriptCard = toolCard(page, "codemode");
      const parentCard = toolCard(page, "orchestrator");
      const list = scriptCard.getByRole("group", { name: "Child calls" });
      await expect(list.locator(".child-call")).toHaveCount(80);
      expect(
        await list.evaluate((element) => element.clientHeight),
      ).toBeLessThanOrEqual(320);
      const row = list.locator(".child-call > summary").nth(6);
      await row.scrollIntoViewIfNeeded();
      if (mobile) await row.tap();
      else {
        await row.focus();
        await row.press("Enter");
      }
      await expect(row.locator("..")).toHaveAttribute("open", "");
      await expect(
        row.locator("..").getByRole("group", { name: "Arguments preview" }),
      ).toContainText("report-7.txt");
      const position = await list.evaluate((element) => element.scrollTop);
      await page.screenshot({
        path: `output/playwright/child-calls/${mobile ? "mobile" : "desktop"}-running.png`,
        animations: "disabled",
      });
      const finalCalls = calls.map((call, index) => ({
        ...call,
        id: `script/${index + 1}`,
        status: index === 7 ? "error" : "ok",
        durationMs: index === 7 ? 1600 : 10,
        ...(index === 7 ? { error: "Report is unavailable" } : {}),
      }));
      const scriptResult = {
        role: "toolResult",
        toolCallId: "script",
        toolName: "codemode",
        isError: false,
        __inspireMessageId: "script-result",
        content: [
          { type: "text", text: "Actual script result: 79 reports collected" },
        ],
        details: { calls: finalCalls },
      };
      const parentResult = {
        role: "toolResult",
        toolCallId: "parent",
        toolName: "orchestrator",
        isError: false,
        __inspireMessageId: "parent-result",
        content: [{ type: "text", text: "Independent parent completed" }],
        nestedCalls: {
          complete: true,
          calls: [
            {
              id: "parent/1",
              name: "read",
              arguments: { path: "independent.txt" },
              status: "error",
              error: "Child failed",
            },
          ],
        },
      };
      send(
        {
          type: "tool_execution_end",
          parentToolCallId: "parent",
          toolCallId: "parent/1",
          toolName: "read",
          isError: true,
          result: { content: [{ type: "text", text: "Child failed" }] },
        },
        {
          type: "tool_execution_end",
          toolCallId: "script",
          toolName: "codemode",
          isError: false,
          result: scriptResult,
        },
        { type: "message_end", message: scriptResult },
        {
          type: "tool_execution_end",
          toolCallId: "parent",
          toolName: "orchestrator",
          isError: false,
          result: parentResult,
        },
        { type: "message_end", message: parentResult },
      );
      await expect(
        row.locator("..").getByRole("group", { name: "Call error" }),
      ).toContainText("Report is unavailable");
      await expect(row.locator("..")).toHaveAttribute("open", "");
      if (!mobile) await expect(row).toBeFocused();
      expect(await list.evaluate((element) => element.scrollTop)).toBe(
        position,
      );
      // The parent owns its own Adaptive completion deadline. Inspect it
      // deliberately even if it closed while the script result was rendered.
      const parentDisclosure = parentCard.getByRole("button", {
        name: /^(Expand|Collapse) orchestrator tool$/,
      });
      if ((await parentDisclosure.getAttribute("aria-expanded")) === "false")
        await parentDisclosure.click();
      await expect(
        parentCard.getByText("Independent parent completed"),
      ).toBeVisible();
      await expect(
        parentCard
          .getByRole("group", { name: "Child calls" })
          .locator(".child-call"),
      ).toHaveCount(1);
      await expect(page.locator(".card--failed")).toHaveCount(0);
      send({
        type: "message_start",
        message: {
          role: "assistant",
          __inspireMessageId: "child-call-next",
          content: [{ type: "text", text: "Continuing the fixture" }],
        },
      });
      // Cross Adaptive card and band close delays after the next native boundary.
      await page.waitForTimeout(3_200);
      await expect(
        scriptCard.getByRole("button", { name: "Collapse CodeMode tool" }),
      ).toBeVisible();
      await expect(row.locator("..")).toHaveAttribute("open", "");
      if (!mobile) await expect(row).toBeFocused();
      expect(await list.evaluate((element) => element.scrollTop)).toBe(
        position,
      );
      await page.screenshot({
        path: `output/playwright/child-calls/${mobile ? "mobile" : "desktop"}-settled-reading.png`,
        animations: "disabled",
      });
      await page.route("**/api/bootstrap**", async (route) => {
        const response = await route.fetch();
        const body = await response.json();
        body.preferences = {
          ...body.preferences,
          theme: "light",
          toolVisibility: "expanded",
          activityFoldVisibility: "expanded",
        };
        body.snapshot.active.transcriptPage.messages = [
          assistantMessage,
          scriptResult,
          parentResult,
        ];
        await route.fulfill({ response, json: body });
      });
      await page.reload();
      await expect(
        page.getByText("Actual script result: 79 reports collected"),
      ).toBeVisible();
      await expect(
        scriptCard
          .getByRole("group", { name: "Child calls" })
          .locator(".child-call"),
      ).toHaveCount(80);
      await expect(
        scriptCard.getByRole("button", { name: /^Calls / }),
      ).toHaveCount(0);
      await expect(page.getByText("Script", { exact: true })).toBeVisible();
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `output/playwright/child-calls/${mobile ? "mobile" : "desktop"}-reopened.png`,
        animations: "disabled",
      });
      const order = await toolCard(page, "codemode").evaluate((card) => {
        const result = card
          .querySelector(".tool-call-result")!
          .getBoundingClientRect();
        const calls = card
          .querySelector(".tool-call-list")!
          .getBoundingClientRect();
        return result.top - calls.bottom;
      });
      expect(order).toBeGreaterThanOrEqual(0);
      const accessibility = await new AxeBuilder({ page })
        .include(".card--tool")
        .analyze();
      expect(accessibility.violations).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}

test("large Markdown stays readable through a stream burst without losing the composer draft", async ({
  page,
}) => {
  const errors: string[] = [];
  const workers: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("worker", (worker) => workers.push(worker.url()));
  const send = await openReview(page);
  let text =
    "## Responsive rich reply\n\n[Forward][later] and $x^2$.\n\n**Decoded &amp; entity**\n\n" +
    "A paragraph with **emphasis** and ordinary text.\n\n".repeat(2_700);
  const message = () => ({
    role: "assistant",
    __inspireMessageId: "review-large-rich-text",
    timestamp: 1_900_000_000_000,
    content: [{ type: "text", text }],
  });
  send({ type: "agent_start" }, { type: "message_start", message: message() });
  const body = page.locator(".turn--assistant .rich-text--assistant").last();
  await expect(body).toContainText("Responsive rich reply");
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  await input.focus();
  await Promise.all([
    input.pressSequentially("Keep this draft", { delay: 20 }),
    (async () => {
      for (let index = 0; index < 20; index++) {
        text += `\n\nStreaming token ${index}.`;
        send({ type: "message_update", message: message() });
        await page.waitForTimeout(20);
      }
      text += "\n\n[later]: ./docs/reference.md\n\n**Latest rich text**";
      send({ type: "message_update", message: message() });
    })(),
  ]);
  await expect(input).toHaveValue("Keep this draft");
  await expect(body).not.toHaveAttribute("aria-busy", "true");
  await expect(
    body.locator('[data-file-path="./docs/reference.md"]'),
  ).toHaveText("Forward");
  await expect(body.locator("strong").last()).toHaveText("Latest rich text");
  await expect(body.getByText("Decoded & entity", { exact: true })).toHaveCount(
    1,
  );
  expect(workers.some((url) => url.includes("rich-text-worker"))).toBe(true);
  expect(errors).toEqual([]);
});

function tool(name: string, args: Record<string, unknown>): ToolCallContent {
  return { type: "toolCall", id: `review-${name}`, name, arguments: args };
}

function assistant(calls: ToolCallContent[]) {
  return {
    role: "assistant",
    __inspireMessageId: "review-assistant",
    timestamp: 1_900_000_000_000,
    content: calls,
  };
}

function toolCard(page: Page, name: string) {
  return page
    .locator(".card--tool")
    .filter({
      has: page.locator(".card__tool-name", {
        hasText: new RegExp(`^${name === "codemode" ? "CodeMode" : name}$`),
      }),
    })
    .last();
}

test("execution output streams in place without settling the adaptive card", async ({
  page,
}) => {
  const send = await openReview(page, { toolVisibility: "dynamic" });
  const call = tool("bash", { command: "npm run build" });
  const message = assistant([call]);
  send(
    { type: "agent_start" },
    { type: "message_start", message },
    { type: "message_end", message },
    {
      type: "tool_execution_start",
      toolCallId: call.id,
      toolName: call.name,
      args: call.arguments,
    },
    {
      type: "tool_execution_update",
      toolCallId: call.id,
      toolName: call.name,
      partialResult: {
        content: [{ type: "text", text: "Preparing browser assets…" }],
      },
    },
  );
  const card = toolCard(page, "bash");
  await expect(card).toContainText("Preparing browser assets…");
  await expect(card.getByLabel("running", { exact: true })).toBeVisible();
  send({
    type: "tool_execution_update",
    toolCallId: call.id,
    toolName: call.name,
    partialResult: {
      content: [{ type: "text", text: "Bundling 140 of 260 modules…" }],
    },
  });
  await expect(card).toContainText("Bundling 140 of 260 modules…");
  await expect(card).not.toContainText("Preparing browser assets…");
  // Outlast the adaptive minimum residency: a progress receipt must not
  // finish the tool or start its completion-driven collapse timer.
  await page.waitForTimeout(1_700);
  await expect(
    card.getByRole("button", { name: "Collapse bash tool", exact: true }),
  ).toBeVisible();
  await expect(card.getByLabel("finished", { exact: true })).toHaveCount(0);
  const log = Array.from(
    { length: 150 },
    (_, i) => `Building module ${i}`,
  ).join("\n");
  const progress = (text: string) => ({
    type: "tool_execution_update",
    toolCallId: call.id,
    toolName: call.name,
    partialResult: { content: [{ type: "text", text }] },
  });
  send(progress(log));
  const output = card.locator(".tool-terminal--live");
  await expect
    .poll(() =>
      output.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(2);
  expect(
    await output.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await output.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  send(progress(`${log}\nPreserve the reader's scroll position`));
  await expect(output).toContainText("Preserve the reader's scroll position");
  expect(await output.evaluate((element) => element.scrollTop)).toBe(0);
  await output.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll"));
  });
  send(progress(`${log}\nFollow the latest output again`));
  await expect(output).toContainText("Follow the latest output again");
  await expect
    .poll(() =>
      output.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(2);
  const result = {
    content: [{ type: "text", text: "Build completed in 2.4s." }],
    isError: false,
  };
  send(
    {
      type: "tool_execution_end",
      toolCallId: call.id,
      toolName: call.name,
      result,
      isError: false,
    },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: call.id,
        toolName: call.name,
        ...result,
      },
    },
  );
  await expect(card.getByLabel("finished", { exact: true })).toBeVisible();
  await expect(card).not.toContainText("Bundling 140 of 260 modules…");
  await expect(
    card.getByRole("button", { name: "Expand bash tool", exact: true }),
  ).toBeVisible();
  await card
    .getByRole("button", { name: "Expand bash tool", exact: true })
    .click();
  await expect(card).toContainText("Build completed in 2.4s.");
});

test("argument generation follows growing code without stealing the user's scroll position", async ({
  page,
}) => {
  const send = await openReview(page);
  const path = "src/generated-session.ts";
  const content = Array.from(
    { length: 120 },
    (_, i) => `export const line_${i} = ${i};`,
  ).join("\n");
  const complete = tool("write", { path, content });
  const partial = (text: string): ToolCallContent => ({
    ...complete,
    arguments: { path, content: text },
    __inspireToolCall: {
      phase: "streaming",
      characters: text.length,
      truncated: false,
    },
  });
  send(
    { type: "agent_start" },
    { type: "message_start", message: assistant([partial(content)]) },
  );
  const card = toolCard(page, "write");
  const code = card.locator(".tool-code");
  await expect(card).toContainText("Generating arguments…");
  await expect(
    card.getByRole("button", { name: path, exact: true }),
  ).toHaveCount(0);
  await expect
    .poll(() =>
      code.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(2);
  const original = await code.elementHandle();
  const next = `${content}\nexport const latest = true;`;
  send({ type: "message_update", message: assistant([partial(next)]) });
  await expect(code).toContainText("export const latest = true;");
  expect(
    await code.evaluate((element, previous) => element === previous, original),
  ).toBe(true);
  await expect
    .poll(() =>
      code.evaluate(
        (element) =>
          element.scrollHeight - element.scrollTop - element.clientHeight,
      ),
    )
    .toBeLessThan(2);
  await code.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll"));
  });
  const finalText = `${next}\nexport const settled = true;`;
  send({ type: "message_update", message: assistant([partial(finalText)]) });
  await expect(code).toContainText("export const settled = true;");
  expect(await code.evaluate((element) => element.scrollTop)).toBe(0);
  send({
    type: "message_end",
    message: assistant([
      { ...complete, arguments: { path, content: finalText } },
    ]),
  });
  await expect(card).toContainText("Waiting to execute…");
  await expect(
    card.getByRole("button", { name: path, exact: true }),
  ).toBeVisible();
  expect(
    await code.evaluate((element, previous) => element === previous, original),
  ).toBe(true);
  expect(await code.evaluate((element) => element.scrollTop)).toBe(0);
});

for (const palette of ["amber", "teal"]) {
  for (const theme of ["light", "dark"]) {
    test(`narrow tool content retains its geometry and contrast in ${palette}/${theme}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      const send = await openReview(page, { palette, theme });
      const path =
        "src/components/session-workbench/projection/lifecycle/SessionProjectionController.tsx";
      const query = "long_identifier_".repeat(18);
      const calls = [
        tool("read", { path, offset: 100_000 }),
        tool("grep", { pattern: query, path: "src/" }),
        tool("review_files", { pattern: "session" }),
        tool("review_json", { data: { action: "inspect", path } }),
        tool("review_plot", { title: "Spectrum" }),
        tool("edit", {
          path: "src/a.ts",
          edits: [{ oldText: "old()", newText: "new()" }],
        }),
        tool("bash", { command: "false" }),
        tool("review_error", { operation: "inspect" }),
        tool("review_markdown", {}),
      ];
      const results = [
        "const url = '" +
          "long-identifier-".repeat(80) +
          "';\n" +
          "const short = 1;\n".repeat(120),
        "src/session.ts-8- const before = true;\nsrc/session.ts:9: const sessionId = active;\nsrc/session.ts-10- return sessionId;",
        "src/session.ts  [modified with an unusually long annotation that must never hide the file name]",
        "Saved metadata",
        null,
        "--- src/a.ts\n+++ src/a.ts\n@@ -1,2 +1,2 @@\n-old()\n+new()\n return ready;",
        "Command exited with code 1",
        "The source is unavailable.",
        "[Runtime guide](https://example.org/pi/runtime)\n\n```ts\nconst ready = true;\n```\n\n" +
          "More tool documentation.\n\n".repeat(80),
      ];
      send(
        { type: "agent_start" },
        { type: "message_start", message: assistant(calls) },
      );
      for (const [index, call] of calls.entries()) {
        send({
          type: "message_end",
          message: {
            role: "toolResult",
            toolCallId: call.id,
            toolName: call.name,
            isError: call.name === "bash" || call.name === "review_error",
            ...(call.name === "edit"
              ? { details: { patch: results[index] } }
              : {}),
            content:
              results[index] === null
                ? [
                    {
                      type: "image",
                      mimeType: "image/png",
                      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNgqK0AAAF2APY+jiZ4AAAAAElFTkSuQmCC",
                    },
                  ]
                : [{ type: "text", text: results[index] }],
          },
        });
      }
      send({
        type: "message_end",
        message: {
          role: "toolResult",
          toolCallId: "unpaired",
          toolName: "external_extension",
          content: [{ type: "text", text: "Unpaired output remains readable" }],
          details: { count: 3 },
        },
      });
      const unpaired = toolCard(page, "external_extension result");
      await expect(unpaired).toContainText("Unpaired output remains readable");
      await expect(unpaired).not.toContainText("Arguments");
      const read = toolCard(page, "read");
      const source = read.locator(".tool-code");
      await expect(source).toBeVisible();
      const pathLabel = read.getByRole("button", { name: path, exact: true });
      const leaf = pathLabel.locator(".resource-path__leaf");
      await expect(leaf).toHaveText("SessionProjectionController.tsx");
      const leafBox = await leaf.boundingBox();
      const pathBox = await pathLabel.boundingBox();
      expect(leafBox!.width).toBeGreaterThan(80);
      expect(leafBox!.x + leafBox!.width).toBeLessThanOrEqual(
        pathBox!.x + pathBox!.width + 1,
      );
      const suffix = await leaf.evaluate((element) => {
        const text = element.querySelector("bdi")!.firstChild!;
        const range = document.createRange();
        range.setStart(text, text.textContent!.length - 4);
        range.setEnd(text, text.textContent!.length);
        const box = range.getBoundingClientRect();
        return { left: box.left, right: box.right };
      });
      expect(suffix.left).toBeGreaterThanOrEqual(pathBox!.x);
      expect(suffix.right).toBeLessThanOrEqual(pathBox!.x + pathBox!.width + 1);
      const size = await source.evaluate((element) => ({
        height: element.clientHeight,
        scroll: element.scrollHeight,
      }));
      expect(size.height).toBeLessThan(550);
      expect(size.scroll).toBeGreaterThan(size.height);
      await source.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
      });
      const plane = await source.boundingBox();
      for (const number of [
        source.locator(".tool-code__number").nth(0),
        source.locator(".tool-code__number").nth(1),
      ]) {
        const box = await number.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(plane!.x);
        expect(box!.x).toBeLessThan(plane!.x + 3);
        expect(
          await number.evaluate(
            (element) => element.scrollWidth <= element.clientWidth,
          ),
        ).toBe(true);
      }
      await source.focus();
      await source.press("PageDown");
      await expect
        .poll(() => source.evaluate((element) => element.scrollTop))
        .toBeGreaterThan(0);
      const grep = toolCard(page, "grep");
      const property = grep
        .locator(".tool-properties__item")
        .filter({ hasText: query });
      expect(
        await property.evaluate(
          (element) => element.scrollWidth <= element.clientWidth + 1,
        ),
      ).toBe(true);
      const files = toolCard(page, "review_files");
      const file = files.getByRole("button", {
        name: "src/session.ts",
        exact: true,
      });
      expect((await file.boundingBox())!.width).toBeGreaterThan(80);
      await expect(
        toolCard(page, "review_json").locator(".tool-code__number"),
      ).toHaveCount(0);
      const image = toolCard(page, "review_plot").locator("img");
      await image.scrollIntoViewIfNeeded();
      await expect(image).toBeVisible();
      await expect
        .poll(() =>
          image.evaluate(
            (element: HTMLImageElement) =>
              element.complete && element.naturalWidth > 0,
          ),
        )
        .toBe(true);
      const markdown = toolCard(page, "review_markdown").locator(
        ".tool-markdown",
      );
      const markdownSize = await markdown.evaluate((element) => ({
        height: element.clientHeight,
        scroll: element.scrollHeight,
      }));
      expect(markdownSize.height).toBeLessThan(550);
      expect(markdownSize.scroll).toBeGreaterThan(markdownSize.height);
      await markdown.focus();
      await expect(markdown).toBeFocused();
      await expect(
        markdown.getByRole("link", { name: "Runtime guide" }),
      ).toBeVisible();
      const accessibility = await new AxeBuilder({ page })
        .include(".card--tool")
        .analyze();
      expect(accessibility.violations).toEqual([]);
    });
  }
}

// Native read/bash produce the recorded artifacts offline. The mock Runtime
// supplies shell/catalog state only; transcript paging and resource authority
// use SessionProjection and the real Host HTTP resource endpoints.
test("saved tool images and full logs reopen through the authorized viewers on desktop and narrow screens", async ({
  page,
}, testInfo) => {
  const fixture = await toolResultResourcesFixture();
  const runtime = new MockRuntime();
  const snapshot = await runtime.openSession(fixture.record.id);
  Object.assign(snapshot.active!, {
    cwd: fixture.record.cwd,
    sessionName: fixture.record.name,
    transcriptPage: fixture.page,
  });
  runtime.resourceContext = async (sessionId) => {
    expect(sessionId).toBe(fixture.record.id);
    return {
      sessionId,
      cwd: fixture.record.cwd!,
      viewId: fixture.page.viewId,
      revision: fixture.page.revision,
      messages: fixture.messages,
    };
  };
  const preferences = new PreferencesStore(
    join(fixture.root, "preferences.json"),
  );
  await preferences.patch({
    theme: "light",
    toolVisibility: "expanded",
    activityFoldVisibility: "expanded",
  });
  const host = createInspireServer({
    token: "tool-resources-test-token",
    runtime,
    catalog: new MockCatalog(),
    attachments: new AttachmentStore(join(fixture.root, "uploads")),
    preferences,
    toolPresentations: new ToolPresentationConfigStore(
      join(fixture.root, "presentations.json"),
    ),
    resources: new ResourceStore(),
    git: new GitInspectionService(),
    mock: true,
    version: "tool-resources-test",
    piVersion: fixture.piVersion,
  });
  await new Promise<void>((resolve) =>
    host.server.listen(0, "127.0.0.1", resolve),
  );
  const url = `http://127.0.0.1:${(host.server.address() as AddressInfo).port}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(url);
    await page.getByLabel("Access token").fill("tool-resources-test-token");
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(page.getByRole("main")).toBeVisible();
    for (const presentation of ["native", "generic"] as const) {
      if (presentation === "generic") {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.route("**/api/bootstrap", async (route) => {
          const response = await route.fetch();
          const body = await response.json();
          body.toolPresentations = {
            version: 1,
            rules: {},
            mappings: { read: "test.raw" },
          };
          await route.fulfill({ response, json: body });
        });
      }
      await page.reload();
      const read = toolCard(page, "read");
      const thumbnail = read.locator(".tool-image-block__image");
      await expect(thumbnail).toBeEnabled();
      await page.locator(".transcript").hover();
      await page.mouse.wheel(0, -5000);
      await thumbnail.scrollIntoViewIfNeeded();
      await expect(thumbnail).toBeInViewport({ ratio: 1 });
      await expect
        .poll(() =>
          thumbnail
            .locator("img")
            .evaluate(
              (image: HTMLImageElement) =>
                image.complete && image.naturalWidth > 0,
            ),
        )
        .toBe(true);
      if (presentation === "native")
        await expect(
          read.locator('[data-tool-rule="inspire.pi.read"]'),
        ).toBeVisible();
      else await expect(read).toContainText("Arguments");
      const cardScreenshot = testInfo.outputPath(
        `${presentation}-saved-image.png`,
      );
      await read.screenshot({ path: cardScreenshot });
      await testInfo.attach(`${presentation} saved image`, {
        path: cardScreenshot,
        contentType: "image/png",
      });
      await thumbnail.focus();
      await thumbnail.press("Enter");
      const preview = page.getByRole("dialog", { name: "Image preview" });
      await expect(preview).toBeVisible();
      await expect(preview.locator("img")).toHaveAttribute(
        "src",
        (await thumbnail.locator("img").getAttribute("src")) ?? "",
      );
      const imageScreenshot = testInfo.outputPath(
        `${presentation}-image-preview.png`,
      );
      await page.screenshot({ path: imageScreenshot });
      await testInfo.attach(`${presentation} image preview`, {
        path: imageScreenshot,
        contentType: "image/png",
      });
      await preview.getByRole("button", { name: "Zoom image" }).click();
      await expect(
        preview.getByRole("button", { name: "Fit image to window" }),
      ).toHaveAttribute("aria-pressed", "true");
      await page.keyboard.press("Escape");
      await expect(preview).toHaveCount(0);
      await expect(thumbnail).toBeFocused();

      const bash = toolCard(page, "bash");
      const action = bash.getByRole("button", { name: "View full output" });
      await action.scrollIntoViewIfNeeded();
      await expect(action).toHaveAttribute(
        "data-file-path",
        fixture.fullOutputPath,
      );
      const actionBox = await action.boundingBox();
      expect(actionBox!.height).toBeGreaterThanOrEqual(44);
      expect(actionBox!.x + actionBox!.width).toBeLessThanOrEqual(
        (await page.viewportSize())!.width,
      );
      const resolved = page.waitForResponse(
        (response) =>
          response.url().includes("/api/resources/resolve") &&
          response.request().postDataJSON()?.reference ===
            fixture.fullOutputPath,
      );
      await action.focus();
      await action.press("Enter");
      const descriptor = await (await resolved).json();
      expect(descriptor.reference).toBe(fixture.fullOutputPath);
      expect(descriptor.sessionId).toBe(fixture.record.id);
      expect(descriptor.viewId).toBe(fixture.page.viewId);
      await expect(
        page.getByRole("region", { name: "File source", exact: true }),
      ).toContainText("native line 1");
      await expect(
        page.getByRole("region", { name: "File source", exact: true }),
      ).toContainText("native line 2500");
      const content = await page.request.get(
        `${url}/api/resources/${descriptor.id}/content?sessionId=${fixture.record.id}`,
      );
      expect(content.ok()).toBe(true);
      expect(await content.text()).toBe(fixture.fullOutput);
      const logScreenshot = testInfo.outputPath(
        `${presentation}-full-output.png`,
      );
      await page.screenshot({ path: logScreenshot });
      await testInfo.attach(`${presentation} full output`, {
        path: logScreenshot,
        contentType: "image/png",
      });
    }
    expect(errors).toEqual([]);
  } finally {
    await page.goto("about:blank");
    await host.close();
    await fixture.dispose();
  }
});
