import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";
import type { ActiveSnapshot, ModelOption } from "../../shared/contracts";
import { actionGeometry } from "./support/action-geometry";
import { routeSnapshots } from "./support/host-events";
import { moveCaretToEnd } from "./support/native-input";
import {
  openCommandPalette,
  openFixtureSession,
  openSettings,
  pairedPage,
} from "./support/navigation";

const draft = "UNFINISHED DRAFT — retain these notes";
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
      value.runState = busy ? "running" : "idle";
      if (value.active) {
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
          // Unchanged confirmations still project this fixture's current run state.
          event.data ??= structuredClone(snapshot);
          event.data.runState = busy ? "running" : "idle";
          if (event.data.active) event.data.active.isStreaming = busy;
        }
      },
    });
    await page.route("**/api/prompt", async (route) => {
      prompts.push(route.request().postDataJSON());
      await route.fulfill({
        status: 202,
        headers: { "X-Inspire-Authority": transport.authority() },
        json: { accepted: true },
      });
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairedPage(page);
    await openFixtureSession(page, /Review extension event lifecycle/);
    const input = page.getByLabel("Message", { exact: true });
    await input.fill(draft);
    await page.locator('input[type="file"]').setInputFiles({
      name: "draft.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Preserve this artifact"),
    });
    await expect(page.locator(".attachment--ready")).toBeVisible();
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

test("keeps long file completion names readable and selectable", async ({
  page,
  commandSession,
}) => {
  const name = "温度相关的实验仪器校准与长时间重复性误差分析结果.json";
  const path = `src/analysis/${name}`;
  await page.setViewportSize({ width: 320, height: 900 });
  await page.route("**/api/files?**", async (route) => {
    await route.fulfill({
      response: await route.fetch(),
      json: {
        files: [{ name, path }],
      },
    });
  });
  await commandSession.input.fill("@");
  const option = page.getByRole("option", {
    name: `${name}, ${path}`,
    exact: true,
  });
  await expect(option).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const fits = await option.evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    const name = document.createRange();
    name.selectNodeContents(row.querySelector(".completion__title > span")!);
    return [...name.getClientRects()].every(
      (rect) => rect.right <= bounds.right && rect.bottom <= bounds.bottom,
    );
  });
  expect(fits).toBe(true);
  await option.click();
  await expect(commandSession.input).toHaveValue(`@"${path}" `);
});

test("keeps long session results and their project context readable on a narrow screen", async ({
  page,
  commandSession,
}) => {
  await page.route("**/api/sessions**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    if (Array.isArray(body.sessions) && body.sessions.length > 0) {
      body.sessions.unshift({
        ...body.sessions[0],
        id: "mixed-cjk-long-session",
        title:
          "检查数据处理流程：整理实验记录，比较 analysis/session_04/calibration_notes.md 与基线以及后续长路径回归验证说明文字",
        modified: new Date(Date.now() + 60_000).toISOString(),
      });
    }
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(commandSession.input).toBeVisible();

  await page.setViewportSize({ width: 320, height: 900 });
  const palette = await openPalette(page);
  const row = palette
    .getByRole("option")
    .filter({ hasText: "检查数据处理流程" });
  await expect(row).toBeVisible();
  const fits = await row.evaluate((element) => {
    const right = element.getBoundingClientRect().right;
    const title = element.querySelector(".palette__title")!;
    const hint = element.querySelector(".palette__hint-inline")!;
    const titleBounds = title.getBoundingClientRect();
    const hintBounds = hint.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(title).lineHeight);
    return (
      titleBounds.height <= lineHeight * 2 + 1 &&
      hintBounds.top >= titleBounds.bottom - 1 &&
      [title, hint].every(
        (label) =>
          label.scrollWidth <= label.clientWidth + 1 &&
          label.getBoundingClientRect().right <= right + 1,
      )
    );
  });
  expect(fits).toBe(true);
});

test("ranks command destinations and opens the model picker without consuming a draft", async ({
  page,
  commandSession,
}) => {
  const { assertDraft } = commandSession;
  const palette = await openPalette(page);
  const filter = palette.getByLabel("Filter commands");
  await expect(filter).toBeFocused();
  await palette
    .getByRole("option", { name: "Find a session", exact: true })
    .hover();
  await page.mouse.move(0, 0);
  await expect(filter).not.toHaveAttribute("aria-activedescendant", /.+/);
  await filter.press("ArrowDown");
  await expect(palette.getByRole("option", { selected: true })).toHaveText(
    "Settings",
  );

  await filter.fill("project");
  const trust = palette.getByRole("option", { name: /^\/trust/ });
  await expect(trust).toContainText("Terminal only");
  await expect(trust.locator(".palette__hint-inline .search-match")).toHaveText(
    "project",
  );
  for (const [query, title] of [
    ["tokens cost", "Session & usage"],
    ["mdl", "Choose model"],
  ]) {
    await filter.fill(query!);
    await expect(palette.getByRole("option").first()).toContainText(title!);
  }
  await filter.fill(" /SETTINGS ");
  await expect(
    palette.getByRole("option").first().locator(".search-match"),
  ).toHaveText("Settings");

  expect(
    (await new AxeBuilder({ page }).include(".palette").analyze()).violations,
  ).toEqual([]);
  await filter.fill("mdl");
  await filter.dispatchEvent("keydown", { key: "Enter", isComposing: true });
  await expect(palette).toBeVisible();
  await palette.getByRole("option").first().click();
  const modelSearch = page.getByRole("combobox", { name: "Search models" });
  await expect(modelSearch).toBeFocused();
  await modelSearch.dispatchEvent("keydown", {
    key: "Enter",
    isComposing: true,
  });
  await expect(modelSearch).toBeVisible();
  await assertDraft();
  await page.keyboard.press("Escape");
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

test("continues prose after inline references, including after draft reload", async ({
  page,
  commandSession,
}) => {
  const { input, prompts } = commandSession;
  const reference = '@"src/components/FilePreview.tsx"';
  const list = page.getByRole("listbox", { name: "Project file completions" });
  const option = list.getByRole("option", { name: /FilePreview\.tsx/ });
  await input.fill("Read @FilePreview and explain the result");
  await input.evaluate((element: HTMLTextAreaElement) => {
    const caret = element.value.indexOf(" and") - 1;
    element.setSelectionRange(caret, caret);
  });
  await input.press("ArrowRight");
  await option.click();
  await input.pressSequentially("carefully ");
  const draft = `Read ${reference} carefully and explain the result`;
  await expect(input).toHaveValue(draft);
  await expect(list).toHaveCount(0);

  await page.reload();
  await expect(input).toHaveValue(draft);
  await moveCaretToEnd(input);
  await input.pressSequentially(" using @FilePreview");
  await expect(option).toBeVisible();
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("aria-autocomplete", "list");
  await expect(input).toHaveAttribute(
    "aria-controls",
    (await list.getAttribute("id"))!,
  );
  await expect(
    page.getByRole("combobox", { name: "Message completion" }),
  ).toHaveAttribute("aria-expanded", "true");
  await expect(input).toHaveAttribute(
    "aria-activedescendant",
    (await option.getAttribute("id"))!,
  );
  await expect(option.locator(".search-match")).toHaveText("FilePreview");
  await input.press("Shift+Enter");
  await expect(input).toHaveValue(`${draft} using @FilePreview\n`);
  await input.press("Backspace");
  await expect(option).toBeVisible();
  await input.press("Enter");
  const repeated = `${draft} using ${reference} `;
  await expect(input).toHaveValue(repeated);
  await expect(list).toHaveCount(0);
  await input.evaluate((element: HTMLTextAreaElement) => {
    const caret = element.value.indexOf("FilePreview") + 3;
    element.setSelectionRange(caret, caret);
  });
  await input.press("ArrowRight");
  await expect(option).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue(repeated);
  expect(prompts).toHaveLength(0);
});

test("keeps prepared file completions anchored and usable by pointer and keyboard", async ({
  page,
  commandSession,
}) => {
  const palette = await openPalette(page, "review");
  await palette.getByRole("option", { name: /\/review/ }).click();
  const input = palette.getByLabel("Prepared command");
  await input.fill("/review @FilePreview");
  const menu = page.locator(".completion").filter({
    has: page.getByRole("listbox", { name: "Project file completions" }),
  });
  await expect(
    menu.getByRole("option", { name: /FilePreview\.tsx/ }),
  ).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  const initialInput = (await input.boundingBox())!;
  const initialMenu = (await menu.boundingBox())!;
  const offset = initialMenu.y - initialInput.y;
  // Exercise the same filtered containing block without installed-PWA emulation.
  await page.evaluate(() =>
    document.documentElement.style.setProperty(
      "--window-titlebar-height",
      "40px",
    ),
  );
  await expect
    .poll(async () => {
      const anchor = (await input.boundingBox())!;
      const box = (await menu.boundingBox())!;
      return Math.abs(box.y - anchor.y - offset);
    })
    .toBeLessThanOrEqual(0.5);
  await menu.getByRole("option", { name: /FilePreview\.tsx/ }).click();
  await expect(input).toHaveValue('/review @"src/components/FilePreview.tsx" ');
  await expect(input).toBeFocused();
  await expect(menu).toHaveCount(0);
  await input.pressSequentially("with @WorkspaceBrowser");
  await expect(
    menu.getByRole("option", { name: /WorkspaceBrowser\.tsx/ }),
  ).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue(
    '/review @"src/components/FilePreview.tsx" with @"src/components/WorkspaceBrowser.tsx" ',
  );
  await commandSession.assertDraft();
  expect(commandSession.prompts).toHaveLength(0);
});

test("preserves command preparation through a native question and rejected submission", async ({
  page,
  commandSession,
}) => {
  const palette = await openPalette(page, "review");
  await palette.getByRole("option", { name: /\/review/ }).click();
  const input = palette.getByLabel("Prepared command");
  await input.fill("/review valuable unsubmitted arguments");
  commandSession.showQuestion();
  const question = page.getByRole("dialog", { name: "Review question" });
  await expect(question).toBeVisible();
  await expect(palette).toBeHidden();
  commandSession.hideQuestion();
  await expect(question).toBeHidden();
  await expect(palette).toBeVisible();
  await expect(input).toHaveValue("/review valuable unsubmitted arguments");
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
      const { authorityId, operationId } = route.request().postDataJSON();
      await route.fulfill({
        status: 409,
        headers: {
          "X-Inspire-Authority": authorityId,
          "X-Inspire-Prompt-Operation": operationId,
          "X-Inspire-Prompt-Outcome": "rejected",
        },
        json: { error: "Extension refused after dialog" },
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
      message: "/review valuable unsubmitted arguments",
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
  await expect(input).toHaveValue("/review valuable unsubmitted arguments");
  await expect(
    page.getByRole("button", { name: "Restore", exact: true }),
  ).toHaveCount(0);
  await run.click();
  await expect(palette).toBeHidden();
  expect(commandSession.prompts).toHaveLength(1);
  await commandSession.assertDraft();
});

test("keeps large model and supported thinking completions usable without sending", async ({
  page,
  commandSession,
}) => {
  const { input, prompts, setModels } = commandSession;
  setModels(
    Array.from({ length: 250 }, (_, index) => ({
      provider: "scale",
      id: `model${String(index).padStart(4, "0")}`,
      name: `Model ${index}`,
    })),
  );
  await page.reload();
  await expect(input).toBeVisible();
  const options = page.getByRole("option");
  await input.fill("/model");
  await input.press("Space");
  await expect(options.first()).toHaveAttribute("aria-setsize", "250");
  expect(await options.count()).toBeLessThan(30);
  for (let index = 0; index < 75; index++) await input.press("ArrowDown");
  const selected = page.getByRole("option", { selected: true });
  await expect(selected).toHaveAttribute("aria-posinset", "76");
  await expect(selected).toBeInViewport();
  await input.press("Enter");
  await expect(input).toHaveValue("/model scale/model0075");

  await input.fill("/model scale/model0249");
  await expect(options).toHaveCount(1);
  await input.press("Tab");
  await expect(input).toHaveValue("/model scale/model0249");
  await expect(options).toHaveCount(0);

  await page.setViewportSize({ width: 320, height: 740 });
  await input.fill("/model ");
  await expect(options.first()).toHaveAttribute("aria-setsize", "250");
  const menu = page.locator(".completion");
  const last = page.getByRole("option", { name: "scale/model0249 Model 249" });
  await menu.hover();
  // Observe browser visibility after layout delivery, not transient bounds from
  // estimated virtual rows. Keep wheeling as newly mounted rows are measured.
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 4000);
      if (!(await last.count())) return false;
      return last.evaluate(
        (element) =>
          new Promise<boolean>((resolve) => {
            const observer = new IntersectionObserver(([entry]) => {
              observer.disconnect();
              resolve(entry?.intersectionRatio === 1);
            });
            observer.observe(element);
          }),
      );
    })
    .toBe(true);
  await expect(last).toBeInViewport();
  expect(await options.count()).toBeLessThan(30);

  await last.click();
  await expect(input).toHaveValue("/model scale/model0249");
  await input.fill("/thinking h");
  await expect(
    page.getByRole("listbox", { name: "Thinking level argument completions" }),
  ).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue("/thinking high");
  await input.fill("/compact preserve API names");
  await expect(page.getByRole("note")).toContainText("Optional instructions");
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
  await expect(help).toContainText("Browse prompt history");
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

test("new-session completion opens below its caret line inside the viewport", async ({
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

  const layout = await menu.evaluate((element) => {
    const welcome = document.querySelector<HTMLElement>(".welcome");
    const input = document.querySelector<HTMLTextAreaElement>(
      ".welcome__composer .composer__input",
    );
    const surface = element.closest<HTMLElement>(".completion");
    if (!welcome || !input || !surface)
      throw new Error("Missing start surface");
    const menuBox = surface.getBoundingClientRect();
    const welcomeBox = welcome.getBoundingClientRect();
    const inputBox = input.getBoundingClientRect();
    return {
      menuTop: menuBox.top,
      menuBottom: menuBox.bottom,
      welcomeTop: welcomeBox.top,
      welcomeBottom: welcomeBox.bottom,
      inputTop: inputBox.top,
      inputBottom: inputBox.bottom,
    };
  });

  expect(layout.menuTop).toBeGreaterThan(layout.inputTop);
  expect(layout.menuTop).toBeLessThan(layout.inputBottom);
  expect(layout.menuTop).toBeGreaterThanOrEqual(layout.welcomeTop);
  expect(layout.menuBottom).toBeLessThanOrEqual(layout.welcomeBottom);
});
