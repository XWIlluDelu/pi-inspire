import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type WebSocketRoute, test } from "@playwright/test";
import type { ToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import type { ToolCallContent } from "../../src/events";
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
      if (event.type === "snapshot")
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
  await page.reload();
  await expect(
    page.getByRole("button", { name: "Rename session", exact: true }),
  ).toHaveText("Tool presentation review");
  await expect.poll(() => sessionId).not.toBeNull();
  return (...events: Record<string, unknown>[]) => {
    for (const event of events)
      socket!.send(JSON.stringify({ ...event, sessionId }));
  };
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
        hasText: new RegExp(`^${name}$`),
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
