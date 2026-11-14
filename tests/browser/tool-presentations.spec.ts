import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import { piInstallation } from "../../server/pi-installation";
import type { ActivityTool, ChildCallList } from "../../shared/tool-activity";
import type { ToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import type { ToolCallContent } from "../../src/events";
import { jsonl, messageEntry } from "../server/fixtures/session-jsonl";
import { browserFixtureHome, browserWorkspace } from "./fixtures/workspace.mjs";
import { observeClipboardWrites } from "./support/clipboard";
import { renderedColors } from "./support/colors";
import { openEventSession, routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import {
  openFixtureSession,
  pairedPage,
  reloadSession,
} from "./support/navigation";

test.use({ serviceWorkers: "block" });

const configuration: ToolPresentationConfiguration = {
  version: 1,
  rules: {
    "review.markdown": {
      summary: [{ value: { literal: "Documentation" } }],
      blocks: [{ type: "markdown", source: { path: "result.text" } }],
    },
  },
  mappings: {
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
    completed(call, "Review summary"),
  );
  const log = page.getByRole("log");
  const output = toolCard(page, "codemode").getByRole("group", {
    name: "Result output",
  });
  await expect(output).toHaveText("Review summary");
  await output.hover();
  const scrollTop = () => log.evaluate((el) => el.scrollTop);
  const beforeWheel = await scrollTop();
  await page.mouse.wheel(0, -120);
  await expect.poll(scrollTop).toBeLessThan(beforeWheel);
});

test.describe("narrow CodeMode details", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  test("keeps CodeMode script, child failures and output inspectable across settlement", async ({
    page,
    context,
  }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const send = await openReview(page, {
      toolVisibility: "dynamic",
      activityFoldVisibility: "dynamic",
    });
    const call = tool("codemode", {
      code: 'text(await tools.read({path: "report.txt"}));',
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
    const script = card.locator("summary").filter({ hasText: /^Script/ });
    await script.press("Enter");
    const code = card.getByRole("group", { name: "Code" });
    await expect(code).toContainText("tools.read");
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
      { type: "message_end", message: assistant([call]) },
      toolActivity(call, {
        calls: { source: "codemode", complete: false, calls },
      }),
    );
    const list = card.getByRole("group", { name: "Child calls" });
    await expect(list).toBeVisible();
    expect(
      await list.evaluate((el) => el.scrollHeight - el.clientHeight),
    ).toBeLessThanOrEqual(1);
    const row = list
      .locator(".child-call")
      .filter({ hasText: "report-40.txt" });
    const log = page.getByRole("log");
    await row.scrollIntoViewIfNeeded();
    expect(await log.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await row.locator("summary").tap();
    await expect(
      row.getByRole("group", { name: "Arguments preview" }),
    ).toContainText("report-40.txt");
    await script.evaluate((element) => element.focus({ preventScroll: true }));
    const position = () =>
      row.evaluate(
        (el) =>
          el.getBoundingClientRect().top -
          el.closest(".transcript")!.getBoundingClientRect().top,
      );
    const reading = await position();

    const childCalls: ChildCallList = {
      source: "codemode",
      complete: false,
      calls: calls.map((entry, index) =>
        index === 40
          ? { ...entry, status: "error", error: "Report is unavailable" }
          : { ...entry, status: "ok" },
      ),
    };
    childCalls.calls.push({
      key: "codemode:80",
      name: "read",
      status: "unfinished",
      argumentsOmitted: true,
    });
    const stdout = Array.from(
      { length: 70 },
      (_, index) => `Checked fixture module ${index + 1}`,
    ).join("\n");
    const result = {
      role: "toolResult",
      ...receipt,
      isError: false,
      __inspireMessageId: "full-codemode-result",
      details: {
        fullOutputPath: "/tmp/review-output.txt",
        calls: [
          { name: "read", status: "error", error: "Report is unavailable" },
        ],
      },
      __inspireCalls: childCalls,
      content: [
        {
          type: "text",
          text: "Script completed\nWall time 4.2 seconds\nOutput:\n",
        },
        { type: "text", text: JSON.stringify({ output: stdout }) },
      ],
    };
    send(
      toolActivity(call, { phase: "done", calls: childCalls }),
      { type: "message_end", message: result },
      {
        type: "message_start",
        message: {
          ...assistant([]),
          __inspireMessageId: "next-response",
          content: [{ type: "text", text: "Continuing the review" }],
        },
      },
    );
    const output = card.getByRole("group", { name: "Result output" });
    const error = row.getByRole("group", { name: "Call error" });
    await expect(error).toContainText("Report is unavailable");
    await expect(row.locator("summary")).toBeInViewport();
    await expect.poll(position).toBeCloseTo(reading, 0);
    await expect(script).toBeFocused();
    const childBounds = (await list.boundingBox())!;
    expect((await output.boundingBox())!.y).toBeGreaterThanOrEqual(
      childBounds.y + childBounds.height,
    );
    const fold = page.locator(".activity-fold").filter({ has: card });
    await fold
      .getByRole("button", { name: "Collapse assistant activity" })
      .click();
    await expect(card).toHaveCount(0);
    await page
      .getByRole("button", { name: "Expand assistant activity" })
      .click();
    await expect(error).toHaveText("Report is unavailable");
    await expect(code).toContainText("tools.read");
    const incomplete = list
      .locator(".child-call")
      .filter({ hasText: "Unfinished" });
    await incomplete.locator("summary").tap();
    await expect(incomplete).toContainText("Arguments not retained");
    await expect(incomplete.getByText("Available arguments")).toHaveCount(0);
    await expect(card.getByText("Call record incomplete")).toBeVisible();

    await expect(output).toBeVisible();
    const action = card.getByRole("button", { name: "View full output" });
    await expect(action).toBeVisible();
    const box = (await action.boundingBox())!;
    expect(Math.round(box.height)).toBe(32);
    expect(box.x + box.width).toBeLessThanOrEqual(390);
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
    const copiedText = () =>
      page.evaluate(() => window.gestureClipboardWrites.at(-1)?.text);
    await expect.poll(copiedText).toContain("Checked fixture module 70");
    expect(await copiedText()).toContain(
      JSON.stringify(call.arguments, null, 2),
    );
    expect(await copiedText()).toContain(
      JSON.stringify(result.details, null, 2),
    );
    expect(await copiedText()).toContain("Wall time 4.2 seconds");

    const imported = {
      ...result,
      toolCallId: "result-without-arguments",
      __inspireMessageId: "imported-codemode-result",
    };
    send({ type: "message_end", message: imported });
    const resultOnly = page
      .locator(".card--tool")
      .filter({ hasText: "CodeMode result" });
    await resultOnly
      .getByRole("button", { name: "Expand CodeMode result details" })
      .click();
    await expect(resultOnly.getByText("Script", { exact: true })).toHaveCount(
      0,
    );
    await expect(
      resultOnly.getByText("Result details", { exact: true }),
    ).toHaveCount(0);
    await expect(
      resultOnly.getByRole("button", { name: "View full output" }),
    ).toBeVisible();
    await resultOnly
      .getByRole("button", { name: "Copy codemode result" })
      .click();
    await expect
      .poll(copiedText)
      .toContain('"toolCallId": "result-without-arguments"');
    expect(JSON.parse((await copiedText())!)).toMatchObject({
      content: imported.content,
      details: imported.details,
    });
  });
});

function tool(name: string, args: Record<string, unknown>): ToolCallContent {
  return { type: "toolCall", id: `review-${name}`, name, arguments: args };
}

function toolActivity(
  call: ToolCallContent,
  update: Partial<Pick<ActivityTool, "phase" | "calls" | "outputPreview">>,
) {
  return {
    type:
      update.phase === "done" || update.phase === "error"
        ? "tool_execution_end"
        : "tool_execution_update",
    toolActivity: {
      [call.id]: {
        id: call.id,
        name: call.name,
        phase: "running" as const,
        ...update,
      },
    },
  };
}

function completed(call: ToolCallContent, text: string, isError = false) {
  return {
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      isError,
      content: [{ type: "text", text }],
    },
  };
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

test("live output and partial arguments follow the reader until native completion", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const send = await openReview(page, { toolVisibility: "dynamic" });
  const shell = tool("bash", { command: "npm run build" });
  const path = "src/stream.ts";
  const content = Array.from(
    { length: 150 },
    (_, i) => `export const line_${i} = ${i};`,
  ).join("\n");
  const write = tool("write", { path, content });
  const progress = (text: string, truncated = false) =>
    toolActivity(shell, { outputPreview: { text, truncated } });
  const bottomGap = (el: Element) =>
    el.scrollHeight - el.scrollTop - el.clientHeight;
  const log = "Building module\n".repeat(150);
  const message = assistant([shell]);
  send(
    { type: "agent_start" },
    { type: "message_start", message },
    { type: "message_end", message },
    progress(`\u001b[32m${log}\u001b[0m`, true),
  );
  const bash = toolCard(page, "bash");
  const output = bash.getByRole("group", { name: "Live output" });
  await expect(output).toContainText("Building module");
  await expect(bash.getByLabel("running", { exact: true })).toBeVisible();
  await expect.poll(() => output.evaluate(bottomGap)).toBeLessThan(2);
  await expect(output).not.toContainText("\u001b[32m");
  await observeClipboardWrites(page);
  await bash
    .getByRole("button", { name: "Copy bash live output preview" })
    .click();
  await expect
    .poll(() => page.evaluate(() => window.gestureClipboardWrites.at(-1)?.text))
    .toContain(`Output (live preview, truncated)\n\n${log}`);
  await output.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  send(progress(`${log}Keep this reading position`));
  await expect(output).toContainText("Keep this reading position");
  expect(await output.evaluate((el) => el.scrollTop)).toBe(0);
  await output.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.dispatchEvent(new Event("scroll"));
  });
  send(progress(`${log}Follow again`));
  await expect(output).toContainText("Follow again");
  await expect.poll(() => output.evaluate(bottomGap)).toBeLessThan(2);
  send(toolActivity(shell, { phase: "error" }));
  await expect(bash.getByLabel("failed", { exact: true })).toBeVisible();
  await expect(output).toHaveCount(0);
  await bash.getByRole("button", { name: "Expand bash tool" }).click();
  await expect(bash).toContainText("Finalizing result…");
  send(completed(shell, "Build failed", true));
  await expect(bash).toContainText("Build failed");

  const partial = (text: string): ToolCallContent => ({
    ...write,
    arguments: { path, content: text },
    __inspireToolCall: {
      phase: "streaming",
      characters: text.length,
      truncated: false,
    },
  });
  const writing = {
    ...assistant([partial("")]),
    __inspireMessageId: "review-streamed-write",
  };
  send({ type: "message_start", message: writing });
  const card = toolCard(page, "write");
  await expect(card).toContainText("Generating arguments…");
  send({
    type: "message_update",
    message: { ...writing, content: [partial(content)] },
  });
  const code = card.locator(".tool-code");
  await expect(code).toContainText("line_149");
  await expect.poll(() => code.evaluate(bottomGap)).toBeLessThan(2);
  const file = card.getByRole("button", { name: path, exact: true });
  await expect(file).toHaveCount(0);
  send({
    type: "message_end",
    message: { ...writing, content: [write], stopReason: "toolUse" },
    toolActivity: {
      [write.id]: { id: write.id, name: write.name, phase: "queued" },
    },
  });
  await expect(card).toContainText("Waiting to execute");
  await expect(file).toBeVisible();
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
  send(...calls.map((call, index) => completed(call, results[index]!)));
  const read = toolCard(page, "read");
  const source = read.locator(".tool-code");
  await expect(source).toBeVisible();
  const pathLabel = read.getByRole("button", { name: path, exact: true });
  const leaf = pathLabel.locator(".resource-path__leaf");
  await expect(leaf).toHaveText("SessionProjectionController.tsx");
  const suffixInside = await leaf.evaluate((element) => {
    const text = element.querySelector("bdi")!.firstChild!;
    const range = document.createRange();
    range.setStart(text, text.textContent!.length - 4);
    range.setEnd(text, text.textContent!.length);
    const bounds = range.getBoundingClientRect();
    const button = element.closest("button")!.getBoundingClientRect();
    return bounds.left >= button.left && bounds.right <= button.right + 1;
  });
  expect(suffixInside).toBe(true);
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
  const number = source.locator(".code-row__number").first();
  await expect(number).toHaveText("100000");
  expect(Math.abs((await number.boundingBox())!.x - plane.x)).toBeLessThan(3);
  await source.focus();
  await source.press("PageDown");
  await expect
    .poll(() => source.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
  const markdown = toolCard(page, "review_markdown").locator(".tool-markdown");
  await markdown.focus();
  await expect(markdown).toBeFocused();
  const link = markdown.getByRole("link", { name: "Runtime guide" });
  await expect(link).toBeVisible();
  expect((await renderedColors(link)).contrast).toBeGreaterThanOrEqual(4.5);
  await markdown.press("PageDown");
  await expect
    .poll(() => markdown.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
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
    await routeSnapshots(page, {
      socket: false,
      bootstrap(body) {
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
      },
    });
    await pairedPage(page);
    // A suite can seed the native file after another test populated the Host catalog.
    const refresh = await hostRequest(page).post("/api/sessions/refresh", {
      data: {},
    });
    expect(refresh.ok()).toBe(true);
    await page.reload();
    const selected = await openFixtureSession(
      page,
      /Inspect the saved image and shell output/,
    );
    await expect(
      toolCard(page, "read").locator(
        '[data-tool-rule="inspire.pi.read"] .tool-image-block__image',
      ),
    ).toBeEnabled();

    fallback = true;
    await page.setViewportSize({ width: 390, height: 844 });
    await reloadSession(page, selected);
    const detail = toolCard(page, "read");
    await detail.getByRole("button", { name: "Expand read tool" }).click();
    const argumentsSummary = detail
      .locator("summary")
      .filter({ hasText: "Arguments" });
    await expect(detail.getByRole("group", { name: "Arguments" })).toHaveCount(
      0,
    );
    await argumentsSummary.press("Enter");
    await expect(
      detail.getByRole("group", { name: "Arguments" }),
    ).toContainText(readArguments.path);
    await argumentsSummary.press("Enter");
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
    const shell = toolCard(page, "bash");
    await shell.getByRole("button", { name: "Expand bash tool" }).click();
    await shell
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
