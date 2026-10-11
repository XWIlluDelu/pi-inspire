import AxeBuilder from "@axe-core/playwright";
import { test as base, expect, type Page } from "@playwright/test";
import type { ActiveSnapshot, ModelOption } from "../../shared/contracts";
import { routeMockSnapshots } from "./support/mock-host";
import { moveCaretToEnd } from "./support/native-input";
import {
  openCommandPalette,
  openMockSession,
  pairedPage,
} from "./support/navigation";

const draft = "UNFINISHED DRAFT — retain these notes";
interface CommandSession {
  input: ReturnType<Page["getByLabel"]>;
  prompts: Array<Record<string, unknown>>;
  setBusy: (busy: boolean) => void;
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
            name: "plan",
            source: "prompt",
            description: "Prepare an implementation plan",
          },
        );
      }
      snapshot = structuredClone(value);
      return value;
    };
    const transport = await routeMockSnapshots(page, { snapshot: addCommands });
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
    await openMockSession(page, /Review extension event lifecycle/);
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
      setBusy: (value) => {
        busy = value;
        transport.send({
          type: value ? "agent_start" : "agent_end",
          sessionId: snapshot.active!.sessionId,
        });
      },
    });
    expect(errors).toEqual([]);
  },
});
test.use({ serviceWorkers: "block", viewport: { width: 1280, height: 900 } });

async function openPalette(page: Page, query = "") {
  const palette = await openCommandPalette(page);
  if (query) await palette.getByLabel("Filter commands").fill(query);
  return palette;
}

test("file completions keep full filenames readable beside or above their paths", async ({
  page,
  commandSession,
}) => {
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await commandSession.input.fill("@TerminalSettingsDialog");
    const option = page.getByRole("option", {
      name: "TerminalSettingsDialog.tsx, src/components/TerminalSettingsDialog.tsx",
      exact: true,
    });
    await expect(option).toBeVisible();
    await expect(option.locator(".completion__title")).toHaveText(
      "TerminalSettingsDialog.tsx",
    );
    await expect(
      option.locator(".completion__hint .resource-path__visible"),
    ).toHaveText("src/components");
    await expect
      .poll(() =>
        option.evaluate((element) => {
          const title = element.querySelector(".completion__title")!;
          const bounds = title.getBoundingClientRect();
          const hint = element
            .querySelector(".completion__hint")!
            .getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(title);
          return (
            [...range.getClientRects()].every(
              (rect) =>
                rect.left >= bounds.left &&
                rect.right <= bounds.right &&
                rect.bottom <= bounds.bottom,
            ) &&
            (hint.left >= bounds.right || hint.top >= bounds.bottom)
          );
        }),
      )
      .toBe(true);
  }
});

test("ranks command destinations and opens the model picker without consuming a draft", async ({
  page,
  commandSession,
}) => {
  const { assertDraft } = commandSession;
  const palette = await openPalette(page);
  expect(await palette.getByRole("option").count()).toBeLessThan(20);
  await expect(
    palette.getByRole("option", { name: /^New session/ }),
  ).toHaveCount(1);
  const filter = palette.getByLabel("Filter commands");
  for (const [query, title] of [
    ["settings", "Settings"],
    ["cost", "Session & usage"],
    ["mdl", "Choose model"],
  ]) {
    await filter.fill(query!);
    await expect(palette.getByRole("option").first()).toContainText(title!);
  }
  await filter.fill("cost");

  expect(
    (await new AxeBuilder({ page }).include(".palette").analyze()).violations,
  ).toEqual([]);
  await filter.fill("mdl");
  await palette.getByRole("option").first().click();
  await expect(
    page.getByRole("combobox", { name: "Search models" }),
  ).toBeFocused();
  await assertDraft();
  await page.keyboard.press("Escape");
});

test("native terminal-only commands remain discoverable in the composer", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Compaction checkpoint fixture/);
  await page.getByLabel("Message", { exact: true }).fill("/bug");
  await expect(
    page.getByRole("option", { name: /\/bug.*Terminal only/ }),
  ).toBeVisible();
});

test("types and runs prepared arguments without consuming the draft", async ({
  page,
  commandSession,
}) => {
  const { prompts, assertDraft } = commandSession;
  let palette = await openPalette(page, "review");
  await palette.getByRole("option", { name: /\/review/ }).click();
  const prepared = palette.getByLabel("Prepared command");
  await expect(prepared).toBeFocused();
  await expect(prepared).toHaveValue("/review ");
  await prepared.pressSequentially("scoped changes");
  await expect(prepared).toHaveValue("/review scoped changes");
  await expect(
    palette.getByRole("group", { name: "Prepared prompt delivery" }),
  ).toHaveCount(0);

  {
    await prepared.dispatchEvent("compositionstart");
    await prepared.dispatchEvent("keydown", {
      key: "Enter",
      ctrlKey: true,
      isComposing: true,
    });
    expect(prompts).toEqual([]);
    await prepared.dispatchEvent("compositionend");
  }
  await prepared.press("Escape");
  await expect(palette.getByLabel("Filter commands")).toHaveValue("review");
  await palette.getByRole("option", { name: /\/review/ }).click();
  await palette
    .getByLabel("Prepared command")
    .pressSequentially("scoped changes");
  await palette
    .getByRole("button", { name: "Run command", exact: true })
    .click();
  expect(prompts[0]).toMatchObject({ message: "/review scoped changes" });
  expect(prompts[0]).not.toHaveProperty("attachmentIds");
  expect(prompts[0]).not.toHaveProperty("behavior");
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
    await palette
      .getByRole("button", { name: "Run command", exact: true })
      .tap();
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
  {
    await input.fill("/model kimi");
    await page
      .getByRole("listbox", { name: "Model argument completions" })
      .getByRole("option")
      .first()
      .click();
    await expect(input).toHaveValue(/\/model [^\s]+\/[^\s]+/);
    await input.fill("/thinking h");
    await expect(
      page.getByRole("listbox", {
        name: "Thinking level argument completions",
      }),
    ).toBeVisible();
    await input.press("Enter");
    await expect(input).toHaveValue("/thinking high");
  }
  await input.fill("Read @FilePreview");
  await page
    .getByRole("listbox", { name: "Project file completions" })
    .getByRole("option", { name: /FilePreview\.tsx/ })
    .click();
  await expect(input).toHaveValue('Read @"src/components/FilePreview.tsx" ');
  await input.pressSequentially("and explain the result");
  await expect(input).toHaveValue(
    'Read @"src/components/FilePreview.tsx" and explain the result',
  );
  await expect(
    page.getByRole("listbox", { name: "Project file completions" }),
  ).toHaveCount(0);
  await page.reload();
  await expect(input).toHaveValue(
    'Read @"src/components/FilePreview.tsx" and explain the result',
  );
  await moveCaretToEnd(input);
  await input.pressSequentially(" with more context");
  await expect(
    page.getByRole("listbox", { name: "Project file completions" }),
  ).toHaveCount(0);
  await expect(input).toHaveValue(
    'Read @"src/components/FilePreview.tsx" and explain the result with more context',
  );
  expect(prompts).toHaveLength(0);
});

test("selects completions in command preparation by pointer and keyboard", async ({
  page,
  commandSession,
}) => {
  const palette = await openPalette(page, "review");
  await palette.getByRole("option", { name: /\/review/ }).click();
  const input = palette.getByLabel("Prepared command");
  await input.fill("/review @FilePreview");
  const files = page.getByRole("listbox", {
    name: "Project file completions",
  });
  await files.getByRole("option", { name: /FilePreview\.tsx/ }).click();
  await expect(palette).toBeVisible();
  await expect(input).toHaveValue('/review @"src/components/FilePreview.tsx" ');
  await expect(input).toBeFocused();
  await input.pressSequentially("with @WorkspaceBrowser");
  await expect(
    files.getByRole("option", { name: /WorkspaceBrowser\.tsx/ }),
  ).toBeVisible();
  await input.press("Enter");
  await expect(input).toHaveValue(
    '/review @"src/components/FilePreview.tsx" with @"src/components/WorkspaceBrowser.tsx" ',
  );
  expect(commandSession.prompts).toHaveLength(0);
  await commandSession.assertDraft();
});

test("resumes unsubmitted command preparation after a native question", async ({
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
});

test("bounds large argument menus without dropping search, scrolling or keyboard choices", async ({
  page,
  commandSession,
}) => {
  const { input, setModels } = commandSession;
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
  // Real wheel input continues through measured row-height changes after resize.
  await expect
    .poll(async () => {
      await page.mouse.wheel(0, 4000);
      if (!(await last.count())) return false;
      return last.evaluate((element) => {
        const row = element.getBoundingClientRect();
        const menu = element.closest(".completion")!.getBoundingClientRect();
        return row.top >= menu.top && row.bottom <= menu.bottom;
      });
    })
    .toBe(true);
  await expect(last).toBeInViewport();
  expect(await options.count()).toBeLessThan(30);

  await last.click();
  await expect(input).toHaveValue("/model scale/model0249");
});

test("queues prepared prompts but runs extension commands under their own policy", async ({
  page,
  commandSession,
}) => {
  const { prompts, setBusy, assertDraft } = commandSession;
  setBusy(true);
  await expect(
    page.getByRole("button", { name: "Send as steer", exact: true }),
  ).toBeVisible();
  let palette = await openPalette(page, "plan");
  await palette.getByRole("option", { name: /\/plan/ }).click();
  await expect(
    palette.getByRole("group", { name: "Prepared prompt delivery" }),
  ).toBeVisible();
  await palette.getByRole("button", { name: "Queue", exact: true }).click();
  await palette
    .getByRole("button", { name: "Queue prompt", exact: true })
    .click();
  expect(prompts[0]).toMatchObject({ message: "/plan", behavior: "followUp" });
  expect(prompts[0]).not.toHaveProperty("attachmentIds");
  await assertDraft();
  palette = await openPalette(page, "review");
  await palette.getByRole("option", { name: /\/review/ }).click();
  await expect(
    palette.getByRole("group", { name: "Prepared prompt delivery" }),
  ).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  setBusy(false);
});

test("reads shortcuts and installed release notes, including from the start screen", async ({
  page,
  commandSession,
}) => {
  let palette = await openPalette(page, "hotkeys");
  await palette.getByRole("option", { name: /Keyboard shortcuts/ }).click();
  const help = page.getByRole("dialog", { name: "Keyboard shortcuts" });
  await expect(help).toContainText("Browse prompt history");
  await expect(help).toContainText("IME composition");
  expect(
    (await new AxeBuilder({ page }).include(".command-help").analyze())
      .violations,
  ).toEqual([]);
  await help.getByRole("button", { name: "Close command help" }).click();
  palette = await openPalette(page, "changelog");
  await palette.getByRole("option", { name: /Pi changelog/ }).click();
  const release = page.getByRole("dialog", { name: "Pi changelog" });
  await expect(
    release.getByRole("heading", { name: /Pi \d+\.\d+\.\d+ release notes/ }),
  ).toBeVisible();
  await expect(release).toContainText("From the installed Pi package");
  await expect(
    page.locator(".command-help .rich-text:not(.rich-text--deferred)"),
  ).toBeVisible();

  await release.getByRole("button", { name: "Close command help" }).click();
  await commandSession.assertDraft();
  palette = await openPalette(page, "/new");
  await palette.getByRole("option", { name: /^New session/ }).click();
  const firstMessage = page.getByLabel("First message", { exact: true });
  await firstMessage.fill("UNFINISHED START DRAFT");
  palette = await openPalette(page, "/resume");
  await palette.getByRole("option", { name: /Find a session/ }).click();
  await expect(
    page.getByRole("searchbox", { name: "Search sessions" }),
  ).toBeFocused();
  await expect(firstMessage).toHaveValue("UNFINISHED START DRAFT");
});

test("new-session completion opens below its caret line inside the viewport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 715, height: 571 });
  await pairedPage(page);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await openMockSession(page, /Formula rendering and spectral analysis/);
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
      placement: surface.dataset.placement,
      menuTop: menuBox.top,
      menuBottom: menuBox.bottom,
      welcomeTop: welcomeBox.top,
      welcomeBottom: welcomeBox.bottom,
      inputTop: inputBox.top,
      inputBottom: inputBox.bottom,
    };
  });

  expect(layout.placement).toBe("down");
  expect(layout.menuTop).toBeGreaterThan(layout.inputTop);
  expect(layout.menuTop).toBeLessThan(layout.inputBottom);
  expect(layout.menuTop).toBeGreaterThanOrEqual(layout.welcomeTop);
  expect(layout.menuBottom).toBeLessThanOrEqual(layout.welcomeBottom);
});
