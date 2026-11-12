import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { piInstallation } from "../../server/pi-installation";
import type { ChildCallList } from "../../shared/tool-activity";
import type { ToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import type { ToolCallContent } from "../../src/events";
import { jsonl, messageEntry } from "../server/fixtures/session-jsonl";
import { browserFixtureHome, browserWorkspace } from "./fixtures/workspace.mjs";
import { observeClipboardWrites } from "./support/clipboard";
import { renderedColors, resolvedColor } from "./support/colors";
import { openEventSession } from "./support/host-events";
import { pairedPage, reloadSession } from "./support/navigation";

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
    "review.markdown": {
      summary: [{ value: { literal: "Documentation" } }],
      blocks: [{ type: "markdown", source: { path: "result.text" } }],
    },
  },
  mappings: {
    review_files: "review.files",
    review_markdown: "review.markdown",
  },
};

// Drive the actual application's event transport and transcript, while the
// isolated test Host continues to supply pairing, catalog and snapshots.
async function openReview(
  page: Page,
  preferences: Record<string, unknown> = {},
) {
  return openEventSession(page, "Tool presentation review", configuration, {
    theme: "light",
    toolVisibility: "expanded",
    activityFoldVisibility: "expanded",
    ...preferences,
  });
}

test("wheels through a fitting CodeMode result into the transcript", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const send = await openReview(page);
  const call = tool("codemode", { code: 'text("Review summary");' });
  send(
    {
      type: "message_end",
      message: {
        ...assistant([]),
        __inspireMessageId: "before-short-result",
        content: [{ type: "text", text: "Review notes.\n\n".repeat(40) }],
      },
    },
    { type: "message_end", message: assistant([call]) },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: call.id,
        toolName: "codemode",
        isError: false,
        content: [{ type: "text", text: "Review summary" }],
      },
    },
  );
  const conversation = page.getByRole("log");
  const output = toolCard(page, "codemode").getByRole("group", {
    name: "Result output",
  });
  await expect(output).toContainText("Review summary");
  await expect(conversation.locator(".rich-text--assistant p")).toHaveCount(40);
  await page.evaluate(() => document.fonts.ready);
  await expect(output).toBeInViewport({ ratio: 1 });
  expect(await output.evaluate((el) => el.scrollHeight - el.clientHeight)).toBe(
    0,
  );

  await output.hover();
  const scrollTop = () => conversation.evaluate((el) => el.scrollTop);
  const beforeWheel = await scrollTop();
  expect(beforeWheel).toBeGreaterThan(120);
  await page.mouse.wheel(0, -120);
  await expect.poll(scrollTop).toBeLessThan(beforeWheel);
});

test.describe("narrow CodeMode details", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  test("keeps CodeMode inspectable from partial Script to scrollable and copyable output", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const send = await openReview(page);
    const call = tool("codemode", {
      code: 'text(await tools.bash({command: "npm run typecheck"}));',
    });
    const partial: ToolCallContent = {
      ...call,
      __inspireToolCall: {
        phase: "streaming",
        characters: 55,
        truncated: false,
      },
    };
    send(
      { type: "agent_start" },
      { type: "message_start", message: assistant([partial]) },
    );
    const card = toolCard(page, "codemode");
    await expect(card.getByText("Generating arguments…")).toBeVisible();
    const script = card
      .locator("summary")
      .filter({ hasText: "Script (partial)" });
    await script.press("Enter");
    await expect(card.locator(".tool-code")).toContainText("npm run typecheck");
    await script.press("Enter");
    await expect(card.locator(".tool-code")).toHaveCount(0);
    const stdout = Array.from(
      { length: 70 },
      (_, index) => `Checked fixture module ${index + 1}`,
    ).join("\n");
    const result = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: "codemode",
      isError: false,
      __inspireMessageId: "full-codemode-result",
      details: { fullOutputPath: "/tmp/review-output.txt" },
      content: [
        {
          type: "text",
          text: "Script completed\nWall time 4.2 seconds\nOutput:\n",
        },
        { type: "text", text: JSON.stringify({ output: stdout }) },
      ],
    };
    send(
      { type: "message_end", message: assistant([call]) },
      { type: "message_end", message: result },
    );
    const output = card.getByRole("group", { name: "Result output" });
    await expect(output).toBeVisible();
    const action = card.getByRole("button", { name: "View full output" });
    await expect(action).toBeVisible();
    const box = (await action.boundingBox())!;
    expect(Math.round(box.height)).toBe(32);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
    await card.getByText("Script", { exact: true }).click();
    await expect(card.locator(".tool-code")).toContainText("npm run typecheck");
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
    await observeClipboardWrites(page);
    await card
      .getByRole("button", { name: "Copy codemode tool block" })
      .click();
    await expect(
      card.getByRole("button", {
        name: "codemode tool block copied",
        exact: true,
      }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(() => window.gestureClipboardWrites.at(-1)?.text),
      )
      .toContain("Checked fixture module 70");
  });
});

test.describe("narrow child-call reading", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });

  test("keeps an inspected CodeMode call in place through Adaptive settlement", async ({
    page,
  }) => {
    const send = await openReview(page, {
      toolVisibility: "dynamic",
      activityFoldVisibility: "dynamic",
    });
    const call = tool("codemode", {
      code: "text(await tools.read({path: 'report.txt'}));",
    });
    const message = assistant([call]);
    const calls: ChildCallList["calls"] = Array.from(
      { length: 80 },
      (_, index) => ({
        key: `codemode:${index}`,
        name: "read",
        argumentsPreview: JSON.stringify({ path: `report-${index}.txt` }),
        status: "running",
      }),
    );
    const receipt = { toolCallId: call.id, toolName: call.name };
    send(
      { type: "agent_start" },
      { type: "message_start", message },
      { type: "tool_execution_start", ...receipt, args: call.arguments },
      {
        type: "tool_execution_update",
        ...receipt,
        childCalls: { source: "codemode", complete: false, calls },
      },
    );

    const card = toolCard(page, "codemode");
    const list = card.getByRole("group", { name: "Child calls" });
    const log = page.getByRole("log");
    const callRow = list
      .locator(".child-call")
      .filter({ hasText: "report-40.txt" });
    await expect(callRow).toBeAttached();
    const script = card.locator("summary").filter({ hasText: /^Script$/ });
    await script.press("Enter");
    const code = card.getByRole("group", { name: "Code" });
    await expect(code).toContainText("tools.read");
    const heights = await list.evaluate((el) => ({
      calls: el.clientHeight,
      content: el.scrollHeight,
      transcript: el.closest(".transcript")!.clientHeight,
    }));
    expect(heights.calls).toBeGreaterThan(heights.transcript);
    expect(heights.content - heights.calls).toBeLessThanOrEqual(1);
    const scrollTop = () => log.evaluate((el) => el.scrollTop);
    await expect.poll(scrollTop).toBeGreaterThan(500);
    const latest = await scrollTop();
    await log.hover();
    await page.mouse.wheel(0, -500);
    await expect.poll(scrollTop).toBeLessThan(latest);
    await callRow.locator("summary").tap();
    await expect(
      callRow.getByRole("group", { name: "Arguments preview" }),
    ).toContainText("report-40.txt");
    await script.evaluate((element) => element.focus({ preventScroll: true }));
    const readingPosition = () =>
      callRow.evaluate((el) => {
        const log = el.closest(".transcript")!;
        return {
          scroll: log.scrollTop,
          offset:
            el.getBoundingClientRect().top - log.getBoundingClientRect().top,
        };
      });
    const position = await readingPosition();
    expect(position.scroll).toBeGreaterThan(0);
    const childCalls: ChildCallList = {
      source: "codemode",
      complete: true,
      calls: calls.map((entry, index) =>
        index === 40
          ? { ...entry, status: "error", error: "Report is unavailable" }
          : { ...entry, status: "ok" },
      ),
    };
    const result = {
      role: "toolResult",
      ...receipt,
      isError: false,
      content: [{ type: "text", text: "Collected 79 reports" }],
      __inspireCalls: childCalls,
    };
    send(
      {
        type: "tool_execution_end",
        ...receipt,
        result,
        isError: false,
        childCalls,
      },
      { type: "message_end", message: result },
      {
        type: "message_start",
        message: {
          role: "assistant",
          __inspireMessageId: "next-response",
          content: [{ type: "text", text: "Continuing the review" }],
        },
      },
    );
    await expect(
      callRow.getByRole("group", { name: "Call error" }),
    ).toContainText("Report is unavailable");
    // The next response lets Adaptive collapse unheld activity.
    await page.waitForTimeout(3_200);
    await expect(callRow.locator("summary")).toBeInViewport();
    await expect.poll(readingPosition).toEqual(position);
    await expect(script).toBeFocused();
    await expect(code).toContainText("tools.read");
    const output = card.getByRole("group", { name: "Result output" });
    await expect(output).toContainText("Collected 79 reports");
    const [callsBox, outputBox] = await Promise.all([
      list.boundingBox(),
      output.boundingBox(),
    ]);
    expect(outputBox!.y).toBeGreaterThanOrEqual(callsBox!.y + callsBox!.height);
    const fold = page.locator(".activity-fold").filter({ has: card });
    await fold
      .getByRole("button", {
        name: "Collapse assistant activity from the upper boundary",
      })
      .click();
    await expect(card).toHaveCount(0);
    await page
      .getByRole("button", { name: "Expand assistant activity" })
      .click();
    await expect(code).toContainText("tools.read");
    await expect(callRow.getByRole("group", { name: "Call error" })).toHaveText(
      "Report is unavailable",
    );
  });
});

test("compact tool details put results before keyboard-accessible parameters", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  const send = await openReview(page, { toolVisibility: "collapsed" });
  const fallback = tool("preview_check", {
    task: "Inspect the workspace",
    instructions: "Long input that should not displace the outcome.\n".repeat(
      20,
    ),
  });
  const code = tool("codemode", { code: 'text("Workspace ready");' });
  send(
    { type: "message_end", message: assistant([fallback, code]) },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: fallback.id,
        toolName: fallback.name,
        content: [
          {
            type: "text",
            text: "Preview unavailable: choose an existing directory.",
          },
        ],
        isError: true,
      },
    },
    {
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: code.id,
        toolName: code.name,
        content: [{ type: "text", text: "Workspace ready" }],
        isError: false,
      },
    },
  );
  const strip = page.locator(".activity-strip");
  const controls = strip.locator(".activity-strip__item");
  await expect(controls).toHaveCount(2);
  await controls.first().click();
  const control = controls.first();
  const identity = await resolvedColor(control, "activity-tool");
  await expect(control.locator("svg").first()).toHaveCSS("color", identity);
  await expect(control).toHaveAccessibleName(/: failed\b/);
  const card = strip.locator(".activity-strip__detail");
  await expect(
    card.getByText("Preview unavailable: choose an existing directory.", {
      exact: true,
    }),
  ).toBeVisible();
  const args = card
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: "Arguments" }) });
  await expect(args).not.toHaveAttribute("open", "");
  const output = (await card
    .getByRole("group", { name: "Result text" })
    .boundingBox())!;
  const argumentBox = (await args.boundingBox())!;
  expect(argumentBox.y).toBeGreaterThanOrEqual(output.y + output.height);
  await args.locator("summary").focus();
  await page.keyboard.press("Enter");
  await expect(
    card.getByText(/Long input that should not displace the outcome/),
  ).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(args).not.toHaveAttribute("open", "");
  await controls.nth(1).click();
  await expect(
    card.getByText("Workspace ready", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 844 });
  const bounds = (await card.boundingBox())!;
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(320);
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
      outputPreview: { text: "Preparing browser assets…", truncated: false },
    },
  );
  const card = toolCard(page, "bash");
  await expect(card).toContainText("Preparing browser assets…");
  await expect(card.getByLabel("running", { exact: true })).toBeVisible();
  send({
    type: "tool_execution_update",
    toolCallId: call.id,
    toolName: call.name,
    outputPreview: { text: "Bundling 140 of 260 modules…", truncated: false },
  });
  await expect(card).toContainText("Bundling 140 of 260 modules…");
  await expect(card).not.toContainText("Preparing browser assets…");
  // Outlast the adaptive minimum residency: a progress receipt must not
  // finish the tool or start its completion-driven collapse timer.
  await page.waitForTimeout(1_700);
  await expect(
    card.getByRole("button", { name: "Collapse bash tool", exact: true }),
  ).toBeVisible();
  await expect(card.getByLabel("running", { exact: true })).toBeVisible();
  const log = Array.from(
    { length: 150 },
    (_, i) => `Building module ${i}`,
  ).join("\n");
  const progress = (text: string) => ({
    type: "tool_execution_update",
    toolCallId: call.id,
    toolName: call.name,
    outputPreview: { text, truncated: false },
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

test("streamed write arguments follow the tail and unlock the path at completion", async ({
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
    { type: "message_start", message: assistant([partial("")]) },
  );
  const card = toolCard(page, "write");
  const code = card.locator(".tool-code");
  await expect(card).toContainText("Generating arguments…");
  send({ type: "message_update", message: assistant([partial(content)]) });
  await expect(code).toContainText("export const line_119");
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
  send({ type: "message_end", message: assistant([complete]) });
  await expect(card).toContainText("Waiting to execute…");
  await expect(
    card.getByRole("button", { name: path, exact: true }),
  ).toBeVisible();
});

test("narrow tool content retains its geometry and contrast", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const send = await openReview(page, { palette: "chimonanthus" });
  const path =
    "src/components/session-workbench/projection/lifecycle/SessionProjectionController.tsx";
  const calls = [
    tool("read", { path, offset: 100_000 }),
    tool("review_markdown", {}),
  ];
  const results = [
    "const url = '" +
      "long-identifier-".repeat(80) +
      "';\n" +
      "const short = 1;\n".repeat(120),
    "[Runtime guide](https://example.org/pi/runtime)\n\n" +
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
        isError: false,
        content: [{ type: "text", text: results[index] }],
      },
    });
  }
  const read = toolCard(page, "read");
  const source = read.locator(".tool-code");
  await expect(source).toBeVisible();
  const pathLabel = read.getByRole("button", { name: path, exact: true });
  const leaf = pathLabel.locator(".resource-path__leaf");
  await expect(leaf).toHaveText("SessionProjectionController.tsx");
  const pathBox = (await pathLabel.boundingBox())!;
  const suffix = await leaf.evaluate((element) => {
    const text = element.querySelector("bdi")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length - 4);
    range.setEnd(text, text.textContent!.length);
    const box = range.getBoundingClientRect();
    return { left: box.left, right: box.right };
  });
  expect(suffix.left).toBeGreaterThanOrEqual(pathBox.x);
  expect(suffix.right).toBeLessThanOrEqual(pathBox.x + pathBox.width + 1);
  const size = await source.evaluate((element) => ({
    height: element.clientHeight,
    scroll: element.scrollHeight,
  }));
  expect(size.height).toBeLessThan(550);
  expect(size.scroll).toBeGreaterThan(size.height);
  await source.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  const plane = (await source.boundingBox())!;
  const number = source.locator(".tool-code__number").first();
  await expect(number).toHaveText("100000");
  expect(Math.abs((await number.boundingBox())!.x - plane.x)).toBeLessThan(3);
  await source.focus();
  await source.press("PageDown");
  await expect
    .poll(() => source.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const markdown = toolCard(page, "review_markdown").locator(".tool-markdown");
  const markdownSize = await markdown.evaluate((element) => ({
    height: element.clientHeight,
    scroll: element.scrollHeight,
  }));
  expect(markdownSize.height).toBeLessThan(550);
  expect(markdownSize.scroll).toBeGreaterThan(markdownSize.height);
  await markdown.focus();
  await expect(markdown).toBeFocused();
  const link = markdown.getByRole("link", { name: "Runtime guide" });
  await expect(link).toBeVisible();
  expect((await renderedColors(link)).contrast).toBeGreaterThanOrEqual(4.5);
  const accessibility = await new AxeBuilder({ page })
    .include(".card--tool")
    .analyze();
  expect(accessibility.violations).toEqual([]);
});

// Native read/bash persist the artifacts offline; the real Runtime and Host
// expose their saved session through normal projection and resource endpoints.
test("saved tool images survive presentation changes and full logs open in the narrow authorized viewer", async ({
  page,
}) => {
  const sessionId = "tool-result-resources";
  const path = join(browserFixtureHome, "sessions", `${sessionId}.jsonl`);
  const readArguments = {
    path: "tests/browser/fixtures/file-previews/training curve.png",
  };
  const bashArguments = {
    command:
      "for ((i=1;i<=2500;i++)); do printf 'native line %s\\n' \"$i\"; done",
  };
  const readCall = tool("read", readArguments);
  const bashCall = tool("bash", bashArguments);
  const sdk = piInstallation.sdk;
  const readResult = await sdk
    .createReadTool(browserWorkspace)
    .execute(readCall.id, readArguments);
  const bashResult = await sdk
    .createBashTool(browserWorkspace, {
      spawnHook: (context) => ({
        ...context,
        env: {
          PATH: process.env.PATH,
          HOME: browserFixtureHome,
          LANG: "C.UTF-8",
        },
      }),
    })
    .execute(bashCall.id, bashArguments);
  const fullOutputPath = bashResult.details.fullOutputPath;
  expect(fullOutputPath).toBeDefined();
  try {
    const messages = [
      { role: "user", content: "Inspect the saved image and shell output." },
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [readCall, bashCall],
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: readCall.id,
        ...readResult,
      },
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: bashCall.id,
        ...bashResult,
      },
    ];
    await writeFile(
      path,
      jsonl(
        {
          type: "session",
          version: 3,
          id: sessionId,
          cwd: browserWorkspace,
          timestamp: new Date().toISOString(),
        },
        ...messages.map((message, index) =>
          messageEntry(`entry-${index}`, index ? `entry-${index - 1}` : null, {
            ...message,
            timestamp: index + 1,
          }),
        ),
      ),
    );
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    let fallback = false;
    await page.route("**/api/bootstrap**", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      Object.assign(body.preferences, {
        theme: "light",
        toolVisibility: fallback ? "collapsed" : "expanded",
        activityFoldVisibility: "expanded",
      });
      if (fallback)
        body.toolPresentations = {
          version: 1,
          rules: {},
          mappings: { read: "test.raw" },
        };
      await route.fulfill({ response, json: body });
    });
    await pairedPage(page);
    await reloadSession(page, sessionId);
    await expect(
      toolCard(page, "read").locator(
        '[data-tool-rule="inspire.pi.read"] .tool-image-block__image',
      ),
    ).toBeEnabled();

    fallback = true;
    await page.setViewportSize({ width: 390, height: 844 });
    await reloadSession(page, sessionId);
    await page.getByRole("button", { name: /^read: finished/ }).click();
    const detail = page.locator(".activity-strip__detail");
    await expect(detail).toContainText("Arguments");
    const thumbnail = detail.getByRole("button", {
      name: "Preview Tool result image 1",
    });
    await thumbnail.press("Enter");
    const preview = page.getByRole("dialog", { name: "Image preview" });
    await expect(preview).toBeVisible();
    await expect
      .poll(() =>
        preview
          .locator("img")
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(thumbnail).toBeFocused();

    await page
      .context()
      .grantPermissions(["clipboard-read", "clipboard-write"]);
    await observeClipboardWrites(page);
    await detail
      .getByRole("button", { name: "Copy read tool block" })
      .press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.gestureClipboardWrites.at(-1)))
      .toEqual({
        text: expect.stringContaining(readArguments.path),
        imageWidth: 720,
      });
    await page.getByRole("button", { name: /^bash: finished/ }).click();
    await detail
      .getByRole("button", { name: "View full output" })
      .press("Enter");
    const output = page.getByRole("region", {
      name: "File source",
      exact: true,
    });
    await expect(output).toContainText("native line 1");
    await expect(output).toContainText("native line 2500");
  } finally {
    await page.goto("about:blank");
    await rm(path, { force: true });
    if (fullOutputPath) await rm(fullOutputPath, { force: true });
  }
});
