import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import type { ActiveSnapshot } from "../../shared/contracts";
import { routeSnapshots } from "./support/host-events";
import { completeOperation, rejectOperation } from "./support/host-operations";
import { hostRequest } from "./support/host-request";
import { moveCaretToEnd } from "./support/native-input";
import {
  openCommandPalette,
  pairAndOpen,
  pairedPage,
  reloadSession,
} from "./support/navigation";

const draft = "UNFINISHED DRAFT — retain these notes";
const message = (page: Page) => page.getByLabel("Message", { exact: true });

async function stageDraft(page: Page) {
  await message(page).fill(draft);
  await page.locator('input[type="file"]').setInputFiles({
    name: "draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Preserve this artifact"),
  });
  await expect(page.locator(".attachment--ready")).toBeVisible();
}

async function expectDraft(page: Page) {
  await expect(message(page)).toHaveValue(draft);
  await expect(page.locator(".attachment")).toContainText("draft.txt");
}

async function openNativeCommandSession(page: Page, info: TestInfo) {
  await pairedPage(page);
  const cwd = info.outputPath("command-workspace");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(join(cwd, "src/components"), { recursive: true });
  await Promise.all(
    ["FilePreview.tsx", "WorkspaceBrowser.tsx"].map((name) =>
      cp(resolve("src/components", name), join(cwd, "src/components", name)),
    ),
  );
  await writeFile(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({
      extensions: [resolve("docs/examples/native-ui.ts")],
    }),
  );
  const response = await hostRequest(page).post("/api/sessions/new", {
    data: { cwd, name: "Command preparation fixture" },
  });
  expect(response.ok()).toBe(true);
  const { active } = (await response.json()) as ActiveSnapshot;
  await reloadSession(page, active!.sessionId);
  await stageDraft(page);
  return active!.sessionId;
}

function observePrompts(page: Page) {
  const prompts: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/prompt")
      prompts.push(request.postDataJSON());
  });
  return prompts;
}

test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });

async function openPalette(page: Page, query = "") {
  const palette = await openCommandPalette(page);
  if (query) await palette.getByLabel("Filter commands").fill(query);
  return palette;
}

test("ranks narrow palette results and keeps model selection out of the draft", async ({
  page,
}) => {
  const title =
    "检查数据处理流程：整理实验记录，比较 analysis/session_04/calibration_notes.md 与基线及回归验证";
  await page.route("**/api/sessions**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (body.sessions?.length)
      body.sessions.unshift({
        ...body.sessions[0],
        id: "mixed-cjk",
        title,
        modified: new Date(Date.now() + 60_000).toISOString(),
      });
    await route.fulfill({ response, json: body });
  });
  await pairAndOpen(page);
  await stageDraft(page);
  await page.setViewportSize({ width: 320, height: 900 });
  const palette = await openPalette(page, "检查数据");
  const row = palette
    .getByRole("option")
    .filter({ hasText: "检查数据处理流程" });
  await expect(row.locator(".palette__hint-inline")).toBeVisible();
  expect(
    await row.evaluate((element) => element.scrollWidth - element.clientWidth),
  ).toBeLessThanOrEqual(1);

  const filter = palette.getByLabel("Filter commands");
  await filter.fill("project");
  const trust = palette.getByRole("option", { name: /^\/trust/ });
  await expect(trust).toContainText("Terminal only");
  await expect(trust.locator(".palette__hint-inline .search-match")).toHaveText(
    "project",
  );
  await filter.fill("mdl");
  await expect(palette.getByRole("option", { selected: true })).toContainText("Choose model");
  await filter.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(palette).toBeVisible();
  await palette.getByRole("option", { selected: true }).click();
  const model = page.getByRole("combobox", { name: "Search models" });
  await expect(model).toBeVisible();
  await model.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(model).toBeVisible();
  await expectDraft(page);
});

test("a busy Pi settling does not change the prepared queue delivery", async ({ page }) => {
  let busy = true;
  const transport = await routeSnapshots(page, {
    snapshot(snapshot) {
      const active = snapshot.active;
      if (!active) return;
      active.isStreaming = busy;
      snapshot.sessionStatuses[active.sessionId] = {
        runState: busy ? "running" : "idle",
      };
      active.commands.push({ name: "plan", source: "prompt" });
    },
  });
  await pairAndOpen(page);
  await expect.poll(() => transport.ready("fixture-history")).toBe(true);
  await stageDraft(page);
  const palette = await openPalette(page, "plan");
  await palette.getByRole("option", { name: /\/plan/ }).click();
  await palette.getByLabel("Prepared command").fill("/plan scoped work");
  await palette.getByRole("button", { name: "Queue", exact: true }).click();
  const release = Promise.withResolvers<void>();
  await page.route("**/api/prompt", async (route) => {
    await release.promise;
    await completeOperation(route, "prompt", null);
  }, { times: 1 });
  const request = page.waitForRequest("**/api/prompt");
  try {
    await palette.getByRole("button", { name: "Queue prompt" }).click();
    expect((await request).postDataJSON()).toMatchObject({
      message: "/plan scoped work",
      behavior: "followUp",
    });
    const settled = page.waitForResponse((response) =>
      new URL(response.url()).searchParams.get("detail") === "fixture-history",
    );
    busy = false;
    transport.send({
      type: "agent_settled",
      sessionId: "fixture-history",
      sessionStatus: { runState: "idle" },
    });
    await (await settled).finished();
    await expect(palette.getByRole("button", { name: "Sending…" })).toBeDisabled();
  } finally {
    release.resolve();
  }
  await expect(palette).toHaveCount(0);
  await expectDraft(page);
});

test.describe("touch commands", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  test("Return inserts a newline in touch command preparation; only Run submits", async ({
    page,
  }, info) => {
    await openNativeCommandSession(page, info);
    const palette = await openPalette(page, "ui-demo");
    await palette.getByRole("option", { name: /^\/ui-demo/ }).tap();
    const prepared = palette.getByLabel("Prepared command");
    const prompts = observePrompts(page);
    await prepared.fill("/ui-demo timeout 15000");
    await prepared.press("Enter");
    await expect(prepared).toHaveValue("/ui-demo timeout 15000\n");
    expect(prompts).toEqual([]);
    await palette.getByRole("button", { name: "Run", exact: true }).tap();
    const question = page.getByRole("dialog", { name: "Timed note" });
    await expect(question).toBeVisible();
    expect(prompts).toMatchObject([{ message: "/ui-demo timeout 15000" }]);
    await page.keyboard.press("Escape");
    await expect(question).toBeHidden();
    await expectDraft(page);
  });
});

test("completes a wrapped filename in prose and restores committed references", async ({
  page,
}) => {
  await pairAndOpen(page);
  const input = message(page);
  const prompts = observePrompts(page);
  await page.setViewportSize({ width: 320, height: 850 });
  const name = "温度相关的实验仪器校准与长时间重复性误差分析结果.json";
  const path = `src/analysis/${name}`;
  await page.route("**/api/files?**", async (route) =>
    route.fulfill({
      response: await route.fetch(),
      json: { files: [{ name, path }] },
    }),
  );
  await input.fill("Read @温度 and compare");
  await input.evaluate((field: HTMLTextAreaElement) => {
    const caret = field.value.indexOf(" and") - 1;
    field.setSelectionRange(caret, caret);
  });
  await input.press("ArrowRight");
  const options = page.getByRole("listbox", {
    name: "Project file completions",
  });
  const option = options.getByRole("option", { name: `${name}, ${path}` });
  await option.click();
  await input.pressSequentially("carefully ");
  const text = `Read @"${path}" carefully and compare`;
  await expect(input).toHaveValue(text);
  await page.reload();
  await expect(input).toHaveValue(text);
  await moveCaretToEnd(input);
  await input.pressSequentially(" using @.json");
  await expect(option).toBeVisible();
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    (await option.getAttribute("id"))!,
  );
  await input.press("Shift+Enter");
  await expect(input).toHaveValue(`${text} using @.json\n`);
  await input.press("Backspace");
  await option.waitFor();
  await input.press("Enter");
  await expect(input).toHaveValue(`${text} using @"${path}" `);
  await expect(options).toHaveCount(0);
  expect(prompts).toHaveLength(0);
});

test(
  "preserves prepared arguments through IME, an overlapping question and a rejected submission",
  async ({ page }, info) => {
    const transport = await routeSnapshots(page, {});
    const sessionId = await openNativeCommandSession(page, info);
    await expect.poll(() => transport.ready(sessionId)).toBe(true);
    const palette = await openPalette(page, "ui-demo");
    const pick = palette.getByRole("option", { name: /^\/ui-demo/ });
    const input = palette.getByLabel("Prepared command");
    await pick.click();
    await expect(input).toBeFocused();
    await input.fill("/ui-demo timeout 15000 @FilePreview");
    await page.getByRole("option", { name: /FilePreview\.tsx/ }).click();
    await input.pressSequentially("with @WorkspaceBrowser");
    await expect(
      page.getByRole("option", { name: /WorkspaceBrowser\.tsx/ }),
    ).toBeVisible();
    await input.press("Enter");
    const prepared =
      '/ui-demo timeout 15000 @"src/components/FilePreview.tsx" with @"src/components/WorkspaceBrowser.tsx" ';
    await expect(input).toHaveValue(prepared);
    const prompts = observePrompts(page);
    await input.dispatchEvent("compositionstart");
    await input.dispatchEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    });
    await input.dispatchEvent("compositionend");
    expect(prompts).toEqual([]);

    const release = Promise.withResolvers<void>();
    await page.route(
      "**/api/prompt",
      async (route) => {
        await release.promise;
        await rejectOperation(route, "prompt", {
          status: 409,
          message: "Extension refused after dialog",
        });
      },
      { times: 1 },
    );
    const run = palette.getByRole("button", { name: "Run", exact: true });
    const sent = page.waitForRequest("**/api/prompt");
    const question = page.getByRole("dialog", { name: "Review question" });
    try {
      await run.click();
      const body = (await sent).postDataJSON();
      expect(body.message).toBe(prepared.trimEnd());
      expect(body.attachmentIds ?? []).toEqual([]);
      transport.send({
        type: "extension_ui_pending",
        sessionId,
        request: {
          sessionId,
          id: "review-question",
          method: "input",
          title: "Review question",
        },
      });
      await expect(question.getByRole("textbox")).toBeFocused();
      await expect(palette).toBeHidden();
    } finally {
      release.resolve();
    }
    await expect(
      page.getByText("Extension refused after dialog"),
    ).toBeVisible();
    transport.send({
      type: "extension_ui_remove",
      sessionId,
      id: "review-question",
      reason: "answered",
    });
    await expect(input).toHaveValue(prepared);
    await expect(input).toBeFocused();
    await expect(run).toBeEnabled();
    expect(prompts).toHaveLength(1);
    await expectDraft(page);
  },
);

test("retries installed release notes without consuming a draft", async ({
  page,
}) => {
  await pairAndOpen(page);
  await stageDraft(page);
  const failure = Promise.withResolvers<void>();
  await page.route(
    "**/api/pi/changelog",
    async (route) => {
      await failure.promise;
      await route.fulfill({
        status: 503,
        json: { error: "Installed package temporarily unavailable" },
      });
    },
    { times: 1 },
  );
  const palette = await openPalette(page, "changelog");
  await palette.getByRole("option", { name: /Pi changelog/ }).click();
  const release = page.getByRole("dialog", { name: "Pi changelog" });
  try {
    await expect(
      release.getByText("Loading installed release notes…"),
    ).toBeVisible();
  } finally {
    failure.resolve();
  }
  const alert = release.getByRole("alert");
  await expect(alert).toContainText(
    "Installed package temporarily unavailable",
  );
  await alert.getByRole("button", { name: "Retry" }).click();
  await expect(
    release.getByRole("heading", { name: /Pi \d+\.\d+\.\d+ release notes/ }),
  ).toBeVisible();
  await release.getByRole("button", { name: "Close command help" }).click();
  await expectDraft(page);
});
