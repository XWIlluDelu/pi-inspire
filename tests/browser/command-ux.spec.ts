import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";
import type { ActiveSnapshot, ModelOption } from "../../shared/contracts";
import { actionGeometry } from "./support/action-geometry";
import { routeSnapshots } from "./support/host-events";
import { completeOperation, rejectOperation } from "./support/host-operations";
import { moveCaretToEnd } from "./support/native-input";
import {
  openCommandPalette,
  openFixtureSession,
  openSettings,
  pairedPage,
} from "./support/navigation";

const draft = "UNFINISHED DRAFT — retain these notes";
async function attachDraft(page: Page) {
  await page.locator('input[type="file"]').setInputFiles({
    name: "draft.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Preserve this artifact"),
  });
  await expect(page.locator(".attachment--ready")).toBeVisible();
}

interface CommandSession {
  input: ReturnType<Page["getByLabel"]>;
  prompts: Array<Record<string, unknown>>;
  setBusy: (busy: boolean) => Promise<void>;
  setModels: (models: ModelOption[]) => void;
  showQuestion: () => void;
  hideQuestion: () => void;
  assertDraft: () => Promise<void>;
}
const test = base.extend<{ commandSession: CommandSession }>({
  commandSession: async ({ page }, use) => {
    let snapshot!: ActiveSnapshot;
    let busy = false;
    let modelOptions: ModelOption[] | undefined;
    const prompts: Array<Record<string, unknown>> = [];
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const addCommands = (value: ActiveSnapshot) => {
      if (value.active) {
        value.sessionStatuses[value.active.sessionId] = {
          runState: busy ? "running" : "idle",
        };
        value.active.isStreaming = busy;
        if (modelOptions) value.active.availableModels = modelOptions;
        value.active.commands.push(
          {
            name: "review",
            source: "extension",
            description: "Review changed files",
          },
          {
            name: "审阅/检查",
            source: "extension",
          },
          {
            name: "plan",
            source: "prompt",
            description: "Prepare an implementation plan",
          },
        );
      }
      snapshot = structuredClone(value);
      return value;
    };
    const transport = await routeSnapshots(page, {
      snapshot: addCommands,
      event: (event) => {
        if (
          event.type === "snapshot" &&
          snapshot?.active &&
          (event.detailSessionId ?? event.data?.active?.sessionId) ===
            snapshot.active.sessionId
        ) {
          event.data ??= structuredClone(snapshot);
          const active = event.data.active;
          if (active) {
            event.data.sessionStatuses[active.sessionId] = {
              runState: busy ? "running" : "idle",
            };
            active.isStreaming = busy;
          }
        }
      },
    });
    await page.route("**/api/prompt", async (route) => {
      prompts.push(route.request().postDataJSON());
      await completeOperation(route, "prompt", null);
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairedPage(page);
    await openFixtureSession(page, /Review extension event lifecycle/);
    const input = page.getByLabel("Message", { exact: true });
    await input.fill(draft);
    await attachDraft(page);
    const assertDraft = async () => {
      await expect(input).toHaveValue(draft);
      await expect(page.locator(".attachment")).toContainText("draft.txt");
    };
    await use({
      input,
      prompts,
      assertDraft,
      setModels: (models) => {
        modelOptions = models;
      },
      showQuestion: () =>
        transport.send({
          type: "extension_ui_request",
          sessionId: snapshot.active!.sessionId,
          id: "command-test-question",
          method: "input",
          title: "Review question",
        }),
      hideQuestion: () =>
        transport.send({
          type: "extension_ui_remove",
          sessionId: snapshot.active!.sessionId,
          id: "command-test-question",
          reason: "answered",
        }),
      setBusy: async (value) => {
        // A settle refreshes the snapshot asynchronously. Finish that response
        // before the next scenario starts a run, so stale fixture state cannot
        // overtake its newer event.
        const refreshed = value
          ? undefined
          : page.waitForResponse((response) => {
              const url = new URL(response.url());
              return (
                url.pathname === "/api/snapshot" &&
                url.searchParams.get("detail") === snapshot.active!.sessionId
              );
            });
        busy = value;
        transport.send({
          type: value ? "agent_start" : "agent_settled",
          sessionId: snapshot.active!.sessionId,
          sessionStatus: { runState: value ? "running" : "idle" },
        });
        if (refreshed) {
          const failure = await (await refreshed).finished();
          if (failure) throw failure;
        }
      },
    });
    // Settled events can start snapshot reads after the visible state changes.
    // Drain this fixture's handlers before its page and API responses are closed.
    await page.unrouteAll({ behavior: "wait" });
    expect(errors).toEqual([]);
  },
});
test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });

async function openPalette(page: Page, query = "") {
  const palette = await openCommandPalette(page);
  if (query) await palette.getByLabel("Filter commands").fill(query);
  return palette;
}

test("ranks narrow palette results and keeps model selection out of the draft", async ({
  page,
  commandSession,
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
  await page.reload();
  await attachDraft(page);
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
  await commandSession.assertDraft();
});

test("types and runs prepared arguments without consuming the draft", {
  tag: "@cross-browser",
}, async ({ page, commandSession }) => {
  const { prompts, assertDraft } = commandSession;
  const palette = await openPalette(page, "review");
  await palette.getByRole("option", { name: /\/review/ }).click();
  const prepared = palette.getByLabel("Prepared command");
  await expect(prepared).toBeFocused();
  await expect(prepared).toHaveValue("/review ");
  await prepared.press("Escape");
  await expect(palette.getByLabel("Filter commands")).toHaveValue("review");
  await palette.getByRole("option", { name: /\/review/ }).click();
  await prepared.pressSequentially("scoped changes");
  await prepared.dispatchEvent("compositionstart");
  await prepared.dispatchEvent("keydown", {
    key: "Enter",
    ctrlKey: true,
    isComposing: true,
  });
  expect(prompts).toEqual([]);
  await prepared.dispatchEvent("compositionend");
  await palette.getByRole("button", { name: "Run", exact: true }).click();
  expect(prompts[0]).toMatchObject({ message: "/review scoped changes" });
  expect(prompts[0]?.attachmentIds ?? []).toEqual([]);
  await assertDraft();
});

test("keeps pending prepared actions stable and dispatches the chosen command policy", async ({
  page,
  commandSession,
}) => {
  const { prompts, setBusy, assertDraft } = commandSession;
  await page.setViewportSize({ width: 320, height: 900 });
  let responseReady: Promise<void>;
  await page.route("**/api/prompt", async (route) => {
    await responseReady;
    await route.fallback();
  });
  for (const command of ["审阅/检查", "review"] as const) {
    await setBusy(true);
    const palette = await openPalette(page, command);
    await palette
      .getByRole("option", { name: new RegExp("/" + command) })
      .click();
    const delivery = palette.getByRole("group", {
      name: "Prepared prompt delivery",
    });
    const prepared = palette.getByLabel("Prepared command");
    const queue = command === "review";
    if (queue) {
      await prepared.fill("/missing argument");
      await expect(
        palette.getByRole("button", { name: "Steer Pi" }),
      ).toBeDisabled();
      await prepared.fill('/export "report copy.jsonl"');
      await expect(
        palette.getByRole("button", { name: "Run", exact: true }),
      ).toBeEnabled();
      await prepared.fill("/plan scoped work");
      await expect(delivery).toBeVisible();
      await delivery
        .getByRole("button", { name: "Queue", exact: true })
        .click();
    } else {
      await prepared.fill(`/${command}\tkeep paths\nnext`);
      await expect(delivery).toHaveCount(0);
    }
    const action = palette.getByRole("button", {
      name: queue ? "Queue prompt" : "Run",
      exact: true,
    });
    const row = palette.locator(".palette__prepare-actions");
    await expect(action).toBeVisible();
    if (queue) await page.evaluate(() => document.fonts.ready);
    const horizontalGeometry = async () =>
      (await actionGeometry(row)).map(({ x, width, height }) => ({
        x,
        width,
        height,
      }));
    const before = queue ? await horizontalGeometry() : null;
    let release!: () => void;
    responseReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    await action.click();
    try {
      const sending = palette.getByRole("button", {
        name: "Sending…",
        exact: true,
      });
      await expect(sending).toBeDisabled();
      if (before) expect(await horizontalGeometry()).toEqual(before);
      await setBusy(false);
      await expect(sending).toBeDisabled();
      if (before) expect(await horizontalGeometry()).toEqual(before);
    } finally {
      release();
    }
    await expect(palette).toHaveCount(0);
    const prompt = prompts.at(-1);
    expect(prompt).toMatchObject({
      message: queue ? "/plan scoped work" : `/${command} keep paths\nnext`,
    });
    if (queue) expect(prompt).toHaveProperty("behavior", "followUp");
    else expect(prompt).not.toHaveProperty("behavior");
  }
  await assertDraft();
});

test.describe("touch commands", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
  });
  test("Return inserts a newline in touch command preparation; only Run submits", async ({
    page,
    commandSession,
  }) => {
    const palette = await openPalette(page, "review");
    await palette.getByRole("option", { name: /\/review/ }).tap();
    const prepared = palette.getByLabel("Prepared command");
    await prepared.fill("/review scoped changes");
    await prepared.press("Enter");
    await expect(prepared).toHaveValue("/review scoped changes\n");
    expect(commandSession.prompts).toEqual([]);
    await prepared.press("Backspace");
    await palette.getByRole("button", { name: "Run", exact: true }).tap();
    expect(commandSession.prompts).toMatchObject([
      { message: "/review scoped changes" },
    ]);
    await commandSession.assertDraft();
  });
});

test("completes a wrapped filename in prose and restores committed references", async ({
  page,
  commandSession: { input, prompts },
}) => {
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

test("preserves command preparation through a native question and rejected submission", async ({
  page,
  commandSession,
}) => {
  const palette = await openPalette(page, "review");
  await palette.getByRole("option", { name: /\/review/ }).click();
  const input = palette.getByLabel("Prepared command");
  await input.fill("/review @FilePreview");
  const option = page.getByRole("option", { name: /FilePreview\.tsx/ });
  await expect(option).toBeInViewport();
  await option.click();
  await input.pressSequentially("with @WorkspaceBrowser");
  await expect(
    page.getByRole("option", { name: /WorkspaceBrowser\.tsx/ }),
  ).toBeVisible();
  await input.press("Enter");
  await expect(input).toBeFocused();
  const text =
    '/review @"src/components/FilePreview.tsx" with @"src/components/WorkspaceBrowser.tsx" ';
  await expect(input).toHaveValue(text);
  commandSession.showQuestion();
  const question = page.getByRole("dialog", { name: "Review question" });
  await expect(question).toBeVisible();
  await expect(palette).toBeHidden();
  commandSession.hideQuestion();
  await expect(question).toBeHidden();
  await expect(palette).toBeVisible();
  await expect(input).toHaveValue(text);
  await expect(input).toBeFocused();
  await commandSession.assertDraft();
  expect(commandSession.prompts).toHaveLength(0);

  let reject!: () => void;
  const release = new Promise<void>((resolve) => {
    reject = resolve;
  });
  await page.route(
    "**/api/prompt",
    async (route) => {
      await release;
      await rejectOperation(route, "prompt", {
        status: 409,
        message: "Extension refused after dialog",
      });
    },
    { times: 1 },
  );
  const sent = page.waitForRequest("**/api/prompt");
  const rejected = page.waitForResponse("**/api/prompt");
  const run = palette.getByRole("button", { name: "Run", exact: true });
  try {
    await run.click();
    const body = (await sent).postDataJSON();
    expect(body).toMatchObject({
      message: text.trimEnd(),
    });
    commandSession.showQuestion();
    await expect(question.getByRole("textbox")).toBeFocused();
    await expect(palette).toBeHidden();
  } finally {
    reject();
  }
  expect((await rejected).status()).toBe(409);
  await expect(page.getByText("Extension refused after dialog")).toBeVisible();
  commandSession.hideQuestion();
  await expect(run).toBeEnabled();
  await expect(input).toHaveValue(text);
  await expect(
    page.getByRole("button", { name: "Restore", exact: true }),
  ).toHaveCount(0);
  await run.click();
  await expect(palette).toBeHidden();
  expect(commandSession.prompts).toHaveLength(1);
  await commandSession.assertDraft();
});

test("keeps a large completion list usable through keyboard and wheel navigation", async ({
  page,
  commandSession: { input, prompts, setModels },
}) => {
  setModels(
    Array.from({ length: 250 }, (_, index) => ({
      provider: "scale",
      id: `model${String(index).padStart(4, "0")}`,
      name: `Model ${index}`,
    })),
  );
  await page.reload();
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
  commandSession,
}) => {
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
      .getByRole("group", { name: "Send key" })
      .getByRole("button", { name: label, exact: true })
      .click();
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
  await commandSession.assertDraft();
});

test("new-session completion stays visible in a short window", async ({
  page,
}) => {
  await page.setViewportSize({ width: 715, height: 571 });
  await pairedPage(page);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await openFixtureSession(page, /Formula rendering and spectral analysis/);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("button", { name: "New session" }).click();

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
