import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { piInstallation } from "../../server/pi-installation";
import type { ActivityTool, ChildCallList } from "../../shared/tool-activity";
import type { ToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import type { ChatMessage, ToolCallContent } from "../../src/events";
import { jsonl, messageEntry } from "../server/fixtures/session-jsonl";
import { browserFixtureHome, browserWorkspace } from "./fixtures/workspace.mjs";
import { observeClipboardWrites } from "./support/clipboard";
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
      summary: [{ value: { path: "args.query" } }],
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
    ...preferences,
  });
}

async function observeToolClipboard(page: Page) {
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await observeClipboardWrites(page);
}

test.describe("narrow CodeMode details", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  test("keeps CodeMode script, child failures and output inspectable across settlement", async ({
    page,
  }) => {
    const send = await openReview(page);
    const args = { code: 'text(await tools.read({path: "report.txt"}));' };
    const call = tool("codemode", args);
    send(
      { type: "agent_start" },
      { type: "message_start", message: assistant([partialCall(call, args)]) },
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
      calls: [
        ...calls.map((entry, index) =>
          index === 40
            ? {
                ...entry,
                status: "error" as const,
                error: "Report is unavailable",
              }
            : { ...entry, status: "ok" as const },
        ),
        {
          key: "codemode:80",
          name: "read",
          status: "unfinished",
          argumentsOmitted: true,
        },
      ],
    };
    const stdout = "Checked fixture module\n".repeat(70);
    const result = completed(
      call,
      [
        {
          type: "text",
          text: "Script completed\nWall time 4.2 seconds\nOutput:\n",
        },
        { type: "text", text: JSON.stringify({ output: stdout }) },
      ],
      {
        isError: false,
        __inspireMessageId: "full-codemode-result",
        details: { fullOutputPath: "/tmp/review-output.txt" },
        __inspireCalls: childCalls,
      },
    );
    send(toolActivity(call, { phase: "done", calls: childCalls }), result);
    const output = card.getByRole("group", { name: "Result output" });
    const error = row.getByRole("group", { name: "Call error" });
    await expect(error).toContainText("Report is unavailable");
    await expect(row.locator("summary")).toBeInViewport();
    await expect.poll(position).toBeCloseTo(reading, 0);
    await expect(script).toBeFocused();
    const incomplete = list.locator(".child-call").filter({ hasText: "Unfinished" });
    await expect(incomplete).toBeAttached();
    await expect(
      card.getByRole("button", { name: "View full output" }),
    ).toBeVisible();
    await output.press("ArrowDown");
    await expect
      .poll(() => output.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(0);
  });
});

function tool(
  name: string,
  args: Record<string, unknown>,
  id = `review-${name}`,
): ToolCallContent {
  return { type: "toolCall", id, name, arguments: args };
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

function completed(
  call: ToolCallContent,
  content: ChatMessage["content"],
  fields: Partial<ChatMessage> = {},
) {
  return {
    type: "message_end",
    message: {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content:
        typeof content === "string"
          ? [{ type: "text", text: content }]
          : content,
      ...fields,
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

function partialCall(
  call: ToolCallContent,
  args: Record<string, unknown> = {},
  truncated = false,
): ToolCallContent {
  return {
    ...call,
    arguments: args,
    __inspireToolCall: {
      phase: "streaming",
      characters: JSON.stringify(args).length,
      truncated,
    },
  };
}

function toolCard(page: Page, name: string, resultOnly = false) {
  const label = name === "codemode" ? "CodeMode" : name;
  return page
    .locator(".card--tool")
    .filter({
      has: page.locator(".card__tool-name", {
        hasText: new RegExp(`^${label}${resultOnly ? " result" : ""}$`),
      }),
    })
    .last();
}

test("live output and partial arguments follow the reader through native execution and settlement", async ({
  page,
}) => {
  const send = await openReview(page);
  const shell = tool("bash", { command: "npm run build" });
  const path = "src/stream.ts";
  const content = Array.from(
    { length: 450 },
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
  await output.evaluate((el) => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  send(progress(`${log}Keep this reading position`));
  await expect(output).toContainText("Keep this reading position");
  expect(await output.evaluate((el) => el.scrollTop)).toBe(0);
  send(toolActivity(shell, { phase: "error" }));
  await expect(bash.getByLabel("failed", { exact: true })).toBeVisible();
  await expect(output).toHaveCount(0);
  await bash.getByRole("button", { name: "Expand bash tool" }).click();
  await expect(bash).toContainText("Finalizing result…");
  send(completed(shell, "Build failed", { isError: true }));
  await expect(bash).toContainText("Build failed");

  const writing = {
    ...assistant([partialCall(write, { path, content: "" })]),
    __inspireMessageId: "review-streamed-write",
  };
  send({ type: "message_start", message: writing });
  const card = toolCard(page, "write");
  await expect(card).toContainText("Generating arguments…");
  send({
    type: "message_update",
    message: {
      ...writing,
      content: [partialCall(write, { path, content }, true)],
    },
  });
  const code = card.locator(".tool-code");
  await expect(code).toContainText("line_399");
  await expect(code).not.toContainText("line_400");
  await expect(card.getByText("Showing first 400 lines")).toBeVisible();
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

test("raw fallback preserves opaque results, complete copies and valid images alongside malformed blocks", async ({
  page,
}) => {
  const send = await openReview(page);
  const generic = tool("review_markdown", { other: "unmatched" }, "generic-output");
  const resultOnly = tool("imported_plot", {});
  const output = `${"Useful output\n".repeat(1000)}Final result line`;
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5vQAAAAASUVORK5CYII=";
  send(
    {
      type: "message_end",
      message: {
        ...assistant([generic]),
        __inspireMessageId: "generic-output",
      },
    },
    completed(
      generic,
      [
        { type: "text", text: output },
        { type: "extensionData", line: 4 },
      ],
      { details: { tokens: 1024 } },
    ),
    completed(
      resultOnly,
      [
        { type: "text", text: "Computed spectrum" },
        { type: "image", mimeType: "image/png", data: png },
        { type: "image", mimeType: "image/svg+xml", data: "c3Zn" },
        { type: "image", mimeType: "image/png", data: "invalid<>" },
        { type: "image" },
      ],
      { details: { peak: 12.4 } },
    ),
  );
  const card = toolCard(page, "review_markdown");
  const reader = card.getByRole("group", { name: "Result text" });
  await expect(reader).toBeVisible();
  await expect(reader).not.toContainText("Final result line");
  await expect(card.getByRole("group", { name: "Result data" })).toHaveCount(0);
  await observeToolClipboard(page);
  await card
    .getByRole("button", { name: "Copy review_markdown tool block" })
    .click();
  const copied = () =>
    page.evaluate(() => window.gestureClipboardWrites.at(-1)?.text);
  await expect.poll(copied).toContain(output);
  expect(await copied()).toContain('"tokens": 1024');
  expect(await copied()).toContain('"type": "extensionData"');
  await card.getByRole("button", { name: "Show all" }).click();
  await expect(reader).toContainText("Final result line");
  await card.getByText("Result details", { exact: true }).click();
  await expect(card.getByRole("group", { name: "Result data" })).toContainText(
    '"line": 4',
  );
  const imported = toolCard(page, "imported_plot", true);
  await expect(imported.getByText("Computed spectrum")).toBeVisible();
  await expect(imported.getByText("Arguments", { exact: true })).toHaveCount(0);
  await expect(imported).toContainText(
    /Image unavailable.*Image unavailable.*Image unavailable/,
  );
  await imported.getByText("Result details", { exact: true }).click();
  await expect(
    imported.getByRole("group", { name: "Result data" }),
  ).toContainText('"peak": 12.4');
  await imported
    .getByRole("button", { name: "Preview Tool result image 1" })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Image preview" }).locator("img"),
  ).toHaveJSProperty("naturalWidth", 1);
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
    await page.getByRole("button", { name: "read tool details", exact: true }).click();
    const thumbnail = toolCard(page, "read").getByRole("button", {
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
    await page.getByRole("button", { name: "bash tool details", exact: true }).click();
    await toolCard(page, "bash")
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
