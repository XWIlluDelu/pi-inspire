import { cp, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo, test } from "@playwright/test";
import type { ActiveSnapshot } from "../../shared/contracts";
import { actionGeometry } from "./support/action-geometry";
import { routeSnapshots } from "./support/host-events";
import { completeOperation, rejectOperation } from "./support/host-operations";
import { hostRequest } from "./support/host-request";
import { moveCaretToEnd } from "./support/native-input";
import {
  openCommandPalette,
  openSettings,
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
  for (const [query, label] of [
    ["tokens cost", "Session & usage"],
    [" /SETTINGS ", "Settings"],
    ["mdl", "Choose model"],
  ]) {
    await filter.fill(query!);
    await expect(palette.getByRole("option", { selected: true })).toContainText(
      label!,
    );
  }
  await filter.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(palette).toBeVisible();
  expect(
    (await new AxeBuilder({ page }).include(".palette").analyze()).violations,
  ).toEqual([]);
  await palette.getByRole("option", { selected: true }).click();
  const model = page.getByRole("combobox", { name: "Search models" });
  await expect(model).toBeVisible();
  await model.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(model).toBeVisible();
  await expectDraft(page);
});

test("keeps prepared actions stable while a busy Pi settles", async ({
  page,
}) => {
  const command = "审阅/检查";
  let busy = true;
  const transport = await routeSnapshots(page, {
    snapshot(snapshot) {
      const active = snapshot.active;
      if (!active) return;
      active.isStreaming = busy;
      snapshot.sessionStatuses[active.sessionId] = {
        runState: busy ? "running" : "idle",
      };
      active.commands.push(
        { name: command, source: "extension" },
        { name: "plan", source: "prompt" },
      );
    },
  });
  await pairAndOpen(page);
  await expect.poll(() => transport.ready("fixture-history")).toBe(true);
  await stageDraft(page);
  await page.setViewportSize({ width: 320, height: 900 });
  for (const [name, text, behavior] of [
    [command, `/${command} keep paths\nnext`, undefined],
    ["plan", "/plan scoped work", "followUp"],
  ] as const) {
    busy = true;
    transport.send({
      type: "agent_start",
      sessionId: "fixture-history",
      sessionStatus: { runState: "running" },
    });
    const palette = await openPalette(page, name);
    await palette.getByRole("option", { name: new RegExp("/" + name) }).click();
    const prepared = palette.getByLabel("Prepared command");
    const delivery = palette.getByRole("group", {
      name: "Prepared prompt delivery",
    });
    if (behavior) {
      await prepared.fill("/missing argument");
      await expect(
        palette.getByRole("button", { name: "Steer Pi" }),
      ).toBeDisabled();
      await prepared.fill('/export "report copy.jsonl"');
      await expect(
        palette.getByRole("button", { name: "Run", exact: true }),
      ).toBeEnabled();
    }
    await prepared.fill(behavior ? text : text.replace(" keep", "\tkeep"));
    await expect(delivery).toHaveCount(behavior ? 1 : 0);
    if (behavior)
      await delivery
        .getByRole("button", { name: "Queue", exact: true })
        .click();
    const release = Promise.withResolvers<void>();
    await page.route(
      "**/api/prompt",
      async (route) => {
        await release.promise;
        await completeOperation(route, "prompt", null);
      },
      { times: 1 },
    );
    const request = page.waitForRequest("**/api/prompt");
    const geometry = async () =>
      (await actionGeometry(palette.locator(".palette__prepare-actions"))).map(
        ({ x, width, height }) => ({ x, width, height }),
      );
    if (behavior) await page.evaluate(() => document.fonts.ready);
    const before = behavior ? await geometry() : null;
    try {
      await palette
        .getByRole("button", {
          name: behavior ? "Queue prompt" : "Run",
          exact: true,
        })
        .click();
      const sending = palette.getByRole("button", {
        name: "Sending…",
        exact: true,
      });
      await expect(sending).toBeDisabled();
      if (before) expect(await geometry()).toEqual(before);
      const settled = page.waitForResponse((response) => {
        const url = new URL(response.url());
        return (
          url.pathname === "/api/snapshot" &&
          url.searchParams.get("detail") === "fixture-history"
        );
      });
      busy = false;
      transport.send({
        type: "agent_settled",
        sessionId: "fixture-history",
        sessionStatus: { runState: "idle" },
      });
      await (await settled).finished();
      await expect(sending).toBeDisabled();
      if (before) expect(await geometry()).toEqual(before);
    } finally {
      release.resolve();
    }
    const sent = (await request).postDataJSON();
    expect(sent.message).toBe(text);
    expect(sent.behavior).toBe(behavior);
    await expect(palette).toHaveCount(0);
  }
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
  await expect(option).toBeVisible();
  expect(
    await option.evaluate((row) => row.scrollWidth - row.clientWidth),
  ).toBeLessThanOrEqual(1);
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
  {
    tag: "@cross-browser",
  },
  async ({ page }, info) => {
    const transport = await routeSnapshots(page, {});
    const sessionId = await openNativeCommandSession(page, info);
    await expect.poll(() => transport.ready(sessionId)).toBe(true);
    const palette = await openPalette(page, "ui-demo");
    const pick = palette.getByRole("option", { name: /^\/ui-demo/ });
    const input = palette.getByLabel("Prepared command");
    await pick.click();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("/ui-demo ");
    await input.press("Escape");
    await expect(palette.getByLabel("Filter commands")).toHaveValue("ui-demo");
    await pick.click();
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
        type: "extension_ui_request",
        sessionId,
        id: "review-question",
        method: "input",
        title: "Review question",
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
    await expect(
      page.getByRole("button", { name: "Restore", exact: true }),
    ).toHaveCount(0);
    expect(prompts).toHaveLength(1);
    await run.click();
    const actual = page.getByRole("dialog", { name: "Timed note" });
    await expect(actual).toBeVisible();
    expect(prompts).toHaveLength(2);
    await page.keyboard.press("Escape");
    await expect(actual).toBeHidden();
    await expectDraft(page);
  },
);

test("keeps a large completion list usable through keyboard and wheel navigation", async ({
  page,
}) => {
  const models = Array.from({ length: 250 }, (_, index) => ({
    provider: "scale",
    id: `model${String(index).padStart(4, "0")}`,
    name: `Model ${index}`,
  }));
  await routeSnapshots(page, {
    snapshot(snapshot) {
      if (snapshot.active) snapshot.active.availableModels = models;
    },
  });
  await pairAndOpen(page);
  const input = message(page);
  const prompts = observePrompts(page);
  await input.fill("/model");
  await input.press("Space");
  const options = page.getByRole("listbox", {
    name: "Model argument completions",
  });
  const selected = options.getByRole("option", { selected: true });
  await expect(selected).toHaveAttribute("aria-posinset", "1");
  await input.press("ArrowDown");
  await input.press("ArrowDown");
  await expect(selected).toHaveAttribute("aria-setsize", "250");
  await input.press("Enter");
  await expect(input).toHaveValue(/\/model scale\/model000[12]/);
  await page.setViewportSize({ width: 320, height: 740 });
  await input.fill("/model ");
  await expect(options).toBeVisible();
  await options.hover();
  const last = options.getByRole("option", {
    name: "scale/model0249 Model 249",
  });
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 4000);
      return (
        (await last.count()) > 0 &&
        (await last.evaluate((row) => {
          const box = row.closest('[role="listbox"]')!.getBoundingClientRect();
          const bounds = row.getBoundingClientRect();
          return bounds.top >= box.top && bounds.bottom <= box.bottom + 1;
        }))
      );
    })
    .toBe(true);
  await last.click();
  await expect(input).toHaveValue("/model scale/model0249");
  await input.fill("/thinking h");
  await expect(
    page.getByRole("listbox", { name: "Thinking level argument completions" }),
  ).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue("/thinking high");
  expect(prompts).toEqual([]);
});

test("reads current shortcuts and retries installed release notes without consuming a draft", async ({
  page,
}) => {
  await pairAndOpen(page);
  await stageDraft(page);
  await page.evaluate(() =>
    Object.defineProperty(navigator, "platform", { value: "MacIntel" }),
  );
  const openHelp = async () => {
    const palette = await openPalette(page, "hotkeys");
    await palette.getByRole("option", { name: /Keyboard shortcuts/ }).click();
  };
  await openHelp();
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  const chords = (label: string) =>
    help.getByText(label, { exact: true }).locator("..").locator("kbd");
  const closeHelp = help.getByRole("button", { name: "Close command help" });
  const send = "Send with the selected delivery mode (desktop)";
  const lineBreak = "Insert a line break (Alt+Enter also works)";
  await expect(chords(send)).toHaveText(["Enter"]);
  await expect(chords(lineBreak)).toHaveText(["Shift+Enter"]);
  await expect(
    chords("Native copy / paste; Ctrl+C always interrupts"),
  ).toHaveText(["⌘+C", "⌘+V"]);
  await expect(help).toContainText("Open input history");
  expect(
    (await new AxeBuilder({ page }).include(".command-help").analyze())
      .violations,
  ).toEqual([]);
  await closeHelp.click();
  const changeSendKey = async (label: string) => {
    await openSettings(page);
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await settings
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    const saved = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/preferences") &&
        response.request().method() === "PATCH",
    );
    await settings
      .getByRole("combobox", { name: "Send key", exact: true })
      .selectOption({ label: label });
    expect((await saved).ok()).toBe(true);
    await page.keyboard.press("Escape");
    await expect(settings).toBeHidden();
  };
  try {
    await changeSendKey("Ctrl/⌘+Enter");
    await openHelp();
    await expect(chords(send)).toHaveText(["Ctrl/⌘+Enter"]);
    await expect(chords(lineBreak)).toHaveText(["Enter", "Shift+Enter"]);
  } finally {
    if (await help.isVisible()) await closeHelp.click();
    await changeSendKey("Enter");
  }

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

test("new-session completion stays visible in a short window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 715, height: 571 });
  await pairedPage(page);
  await page.getByRole("textbox", { name: "First message" }).fill("/");
  const menu = page.getByRole("listbox", {
    name: "Slash command completions",
  });
  await expect(menu).toBeVisible();

  await expect(menu).toBeInViewport();
  await expect(
    page.getByRole("textbox", { name: "First message" }),
  ).toBeFocused();
});
