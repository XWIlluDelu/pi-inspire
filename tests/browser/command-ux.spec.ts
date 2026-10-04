import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import {
  test as base,
  expect,
  type Page,
  type WebSocketRoute,
} from "@playwright/test";
import type { ActiveSnapshot, ModelOption } from "../../shared/contracts";
import { openCommandPalette } from "./support/navigation";

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
    let socket!: WebSocketRoute;
    let authority = "";
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
    await page.routeWebSocket("**/events**", (ws) => {
      socket = ws;
      const upstream = ws.connectToServer();
      upstream.onMessage((message) => {
        const event = JSON.parse(String(message));
        if (event.type === "snapshot" && event.data)
          event.data = addCommands(event.data);
        ws.send(JSON.stringify(event));
      });
      ws.onMessage((message) => upstream.send(message));
    });
    for (const pattern of [
      "**/api/bootstrap**",
      "**/api/snapshot**",
      "**/api/sessions/open",
    ]) {
      await page.route(pattern, async (route) => {
        const response = await route.fetch();
        authority = response.headers()["x-inspire-authority"] ?? authority;
        const data = await response.json();
        if (data.snapshot) data.snapshot = addCommands(data.snapshot);
        else if (data.active) addCommands(data);
        await route.fulfill({ response, json: data });
      });
    }
    await page.route("**/api/prompt", async (route) => {
      prompts.push(route.request().postDataJSON());
      await route.fulfill({
        status: 202,
        headers: { "X-Inspire-Authority": authority },
        json: { accepted: true },
      });
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.getByLabel("Access token").fill("inspire-browser-test-token");
    await page.getByRole("button", { name: "Pair", exact: true }).click();
    await expect(page.getByRole("main")).toBeVisible();
    const toggle = page.getByRole("button", {
      name: "Toggle navigation",
      exact: true,
    });
    if (
      (await toggle.getAttribute("aria-expanded")) === "false" ||
      (await page.locator(".nav--rail").count())
    )
      await toggle.click();
    await page
      .locator(".nav__row-main")
      .filter({ hasText: "Review extension event lifecycle" })
      .click();
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
        socket.send(
          JSON.stringify({
            type: "extension_ui_request",
            sessionId: snapshot.active!.sessionId,
            id: "command-test-question",
            method: "input",
            title: "Review question",
          }),
        ),
      hideQuestion: () =>
        socket.send(
          JSON.stringify({
            type: "extension_ui_remove",
            sessionId: snapshot.active!.sessionId,
            id: "command-test-question",
            reason: "answered",
          }),
        ),
      setBusy: (value) => {
        busy = value;
        socket.send(
          JSON.stringify({
            type: value ? "agent_start" : "agent_end",
            sessionId: snapshot.active!.sessionId,
          }),
        );
      },
    });
    expect(errors).toEqual([]);
  },
});
test.use({ serviceWorkers: "block" });

async function openPalette(page: Page, query = "") {
  const palette = await openCommandPalette(page);
  if (query) await palette.getByLabel("Filter commands").fill(query);
  return palette;
}

for (const touch of [false, true]) {
  const size = touch ? "narrow" : "desktop";
  test.describe(`${size} command tasks`, () => {
    test.use({
      viewport: touch
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      hasTouch: touch,
    });

    test("finds sessions and task destinations without consuming a draft", async ({
      page,
      commandSession,
    }) => {
      const { assertDraft } = commandSession;
      await page.route("**/api/sessions?**", async (route) => {
        if (
          new URL(route.request().url()).searchParams.get("q") !==
          "catalog-only"
        )
          return route.continue();
        await route.fulfill({
          json: {
            sessions: [
              {
                id: "00000000-0000-4000-8000-000000000099",
                title: "Unloaded catalog result",
                cwd: "/catalog",
                project: "catalog",
                created: "2026-10-01T00:00:00Z",
                modified: "2026-10-01T00:00:00Z",
                messageCount: 1,
              },
            ],
            total: 1,
            offset: 0,
            limit: 40,
          },
        });
      });
      let palette = await openPalette(page, "/resume");
      await palette.getByRole("option", { name: /Find a session/ }).click();
      const search = page.getByRole("searchbox", { name: "Search sessions" });
      await expect(search).toBeFocused();
      await search.fill("catalog-only");
      await expect(
        page
          .locator(".nav__row-name")
          .filter({ hasText: "Unloaded catalog result" }),
      ).toBeVisible();
      await assertDraft();
      await page.screenshot({
        path: `output/playwright/command-ux-${size}-catalog.png`,
      });
      await search.fill("");
      if (touch)
        await page
          .getByRole("button", { name: "Close navigation", exact: true })
          .click();
      else
        await page
          .getByRole("button", { name: "Toggle navigation", exact: true })
          .click();
      palette = await openPalette(page);
      expect(await palette.getByRole("option").count()).toBeLessThan(20);
      await expect(
        palette.getByRole("option", { name: /^New session/ }),
      ).toHaveCount(1);
      const filter = palette.getByLabel("Filter commands");
      for (const [query, title] of [
        ["settings", "Settings"],
        ["cost", "Session information"],
        ["mdl", "Choose model"],
      ]) {
        await filter.fill(query!);
        await expect(palette.getByRole("option").first()).toContainText(title!);
      }
      await filter.fill("cost");
      await page.screenshot({
        path: `output/playwright/command-ux-${size}-task-search.png`,
      });
      if (!touch)
        expect(
          (await new AxeBuilder({ page }).include(".palette").analyze())
            .violations,
        ).toEqual([]);
      await filter.fill("mdl");
      await palette.getByRole("option").first().click();
      await expect(
        page.getByRole("combobox", { name: "Search models" }),
      ).toBeFocused();
      await assertDraft();
      await page.keyboard.press("Escape");
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
      await page.screenshot({
        path: `output/playwright/command-ux-${size}-prepare.png`,
      });
      if (touch) {
        await prepared.press("Enter");
        await expect(prepared).toHaveValue("/review scoped changes\n");
        await prepared.press("Backspace");
      } else {
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

    test("continues prose after inline references, including after draft reload", async ({
      page,
      commandSession,
    }) => {
      const { input, prompts } = commandSession;
      if (!touch) {
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
      await expect(input).toHaveValue(
        'Read @"src/components/FilePreview.tsx" ',
      );
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
      await input.press("Control+End");
      await input.pressSequentially(" with more context");
      await expect(
        page.getByRole("listbox", { name: "Project file completions" }),
      ).toHaveCount(0);
      await expect(input).toHaveValue(
        'Read @"src/components/FilePreview.tsx" and explain the result with more context',
      );
      expect(prompts).toHaveLength(0);
      await page.screenshot({
        path: `output/playwright/command-ux-${size}-inline-reference.png`,
      });
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
      await expect(input).toHaveValue(
        '/review @"src/components/FilePreview.tsx" ',
      );
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

    test("exports the current branch through a real download while keeping draft attachments", async ({
      page,
      commandSession,
    }, info) => {
      const { assertDraft } = commandSession;
      const palette = await openPalette(page, "export");
      await palette.getByRole("option", { name: /Export session/ }).click();
      await expect(palette).toBeHidden();
      const dialog = page.getByRole("dialog", {
        name: "Export session",
        exact: true,
      });
      await dialog.getByRole("radio", { name: "JSONL Current branch" }).check();
      const downloadEvent = page.waitForEvent("download");
      await dialog
        .getByRole("button", { name: "Download", exact: true })
        .click();
      const download = await downloadEvent;
      expect(download.suggestedFilename()).toMatch(/\.jsonl$/);
      const path = info.outputPath("branch-copy.jsonl");
      await download.saveAs(path);
      expect(
        (await readFile(path, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line))[0],
      ).toMatchObject({ type: "session", version: 3 });
      await assertDraft();
      await page.screenshot({
        path: `output/playwright/command-ux-${size}-download.png`,
      });
    });
  });
}

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
  await page.locator(".completion").evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const last = page.getByRole("option", { name: "scale/model0249 Model 249" });
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
  await page.screenshot({
    path: "output/playwright/command-ux-desktop-changelog.png",
  });
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
