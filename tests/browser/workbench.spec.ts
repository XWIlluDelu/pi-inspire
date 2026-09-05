import { basename } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const token = "inspire-browser-test-token";
const mockWorkspaceName = basename(process.cwd());

async function pairedPage(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("main")).toBeVisible();
}

async function openMockSession(
  page: import("@playwright/test").Page,
  title: RegExp,
) {
  await page.locator(".nav__row-main").filter({ hasText: title }).click();
  await expect(page.locator(".topbar__title-button")).toHaveText(title);
}

test("project terminals survive browser detach and keep multiple tabs", async ({
  context,
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.evaluate(() => {
    window.localStorage.setItem(
      "inspire:terminal-ui-settings:v1",
      JSON.stringify({ screenReaderMode: true }),
    );
  });
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();

  const emptyTerminal = page.locator(".terminal-empty");
  await emptyTerminal.getByRole("button", { name: "New terminal" }).click();
  const readTerminals = async () => {
    const response = await page.request.get(
      `/api/terminals?cwd=${encodeURIComponent(process.cwd())}`,
    );
    expect(response.ok()).toBe(true);
    return response.json() as Promise<{
      terminals: Array<{ id: string; nextOutputOffset: number }>;
    }>;
  };
  const terminalInput = page.locator(".xterm-helper-textarea");
  await expect(terminalInput).toBeVisible();
  const firstCatalog = await readTerminals();
  const firstTerminal = firstCatalog.terminals[0]!;
  await terminalInput.pressSequentially("printf 'INSPIRE_TERMINAL_E2E\\n'");
  await terminalInput.press("Enter");
  await expect
    .poll(async () => (await readTerminals()).terminals[0]!.nextOutputOffset)
    .toBeGreaterThan(firstTerminal.nextOutputOffset);
  const visibleTerminalOutput = page.locator(
    ".terminal-views__item:not([hidden]) .xterm-accessibility-tree",
  );
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await page.evaluate(async () => {
    await navigator.clipboard.writeText("printf '终端✓\\n'");
  });
  await page.getByRole("button", { name: "Paste into terminal" }).click();
  await terminalInput.press("Enter");
  await expect(visibleTerminalOutput).toContainText("终端✓");
  await terminalInput.pressSequentially(
    "printf '\\033[?1049hINSPIRE_ALT_SCREEN'",
  );
  await terminalInput.press("Enter");
  await expect(visibleTerminalOutput).toContainText("INSPIRE_ALT_SCREEN");

  await page.getByRole("button", { name: "New terminal" }).click();
  await expect(page.locator(".terminal-tab__select")).toHaveCount(2);
  const terminalIds = (await readTerminals()).terminals.map(({ id }) => id);
  const terminalAccessibility = await new AxeBuilder({ page })
    .include(".terminal-pane")
    .analyze();
  expect(terminalAccessibility.violations).toEqual([]);

  await page.reload();
  await expect(page.getByRole("main")).toBeVisible();
  await openMockSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "Terminal", exact: true }).click();
  await expect(page.locator(".terminal-tab__select")).toHaveCount(2);
  expect((await readTerminals()).terminals.map(({ id }) => id)).toEqual(
    terminalIds,
  );

  await page.locator(`#terminal-tab-${terminalIds[0]}`).click();
  await expect(page.getByText("Controlling", { exact: true })).toBeVisible();
  const restoredInput = page.locator(
    ".terminal-views__item:not([hidden]) .xterm-helper-textarea",
  );
  await expect(
    page.locator(
      ".terminal-views__item:not([hidden]) .xterm-accessibility-tree",
    ),
  ).toContainText("INSPIRE_ALT_SCREEN");
  await restoredInput.pressSequentially("printf '\\033[?1049l'");
  await restoredInput.press("Enter");

  const focusedPage = await context.newPage();
  const focusedUrl = new URL(page.url());
  focusedUrl.searchParams.set("terminal", terminalIds[0]!);
  focusedUrl.searchParams.set("terminalFocus", "1");
  await focusedPage.goto(focusedUrl.href);
  await expect(focusedPage.locator(".terminal-pane--focused")).toBeVisible();
  await expect(
    focusedPage.getByText("View only", { exact: true }),
  ).toBeVisible();
  await focusedPage.keyboard.press("Control+k");
  await focusedPage
    .getByPlaceholder("Type a command or search…")
    .fill("take control");
  await focusedPage
    .getByRole("option", { name: /Take control of terminal/ })
    .click();
  await expect(
    focusedPage.getByText("Controlling", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("View only", { exact: true })).toBeVisible();
  await openMockSession(page, /Formula rendering and spectral analysis/);
  await expect(focusedPage.locator(".terminal-pane--focused")).toBeVisible();
  await expect(
    focusedPage.locator(`#terminal-tab-${terminalIds[0]}`),
  ).toHaveAttribute("aria-pressed", "true");
  await focusedPage.close();

  for (const terminalId of terminalIds) {
    const response = await page.request.delete(
      `/api/terminals/${encodeURIComponent(terminalId)}?force=1`,
    );
    expect(response.ok()).toBe(true);
  }
  await expect.poll(async () => (await readTerminals()).terminals).toEqual([]);
});

test("mock workbench pairs, clears its URL token, and opens context surfaces", async ({
  page,
}) => {
  const externalRequests: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost")
      externalRequests.push(url.href);
  });

  await pairedPage(page);
  await page
    .getByRole("button", { name: "Review extension event lifecycle 2d" })
    .click();
  await expect(
    page.getByText("Review extension event lifecycle").last(),
  ).toBeVisible();
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await expect(
    page.getByRole("complementary", { name: "Context panel" }),
  ).toBeVisible();
  expect(externalRequests).toEqual([]);
});

test("an expired pairing returns to Pair without clearing unrelated cookies", async ({
  page,
}) => {
  await pairedPage(page);
  const origin = new URL(page.url()).origin;
  const accessCookie = (await page.context().cookies(origin)).find((cookie) =>
    cookie.name.startsWith("inspire_access_"),
  );
  expect(accessCookie).toBeDefined();
  await page.context().addCookies([
    {
      name: accessCookie!.name,
      value: "expired-pairing",
      url: origin,
      httpOnly: true,
      sameSite: "Strict",
    },
    {
      name: "unrelated_browser_cookie",
      value: "preserved",
      url: origin,
    },
  ]);

  await page.reload();
  await expect(page.getByLabel("Access token")).toBeVisible();
  const cookiesAfterExpiry = await page.context().cookies(origin);
  expect(
    cookiesAfterExpiry.some((cookie) => cookie.name === accessCookie!.name),
  ).toBe(false);
  expect(
    cookiesAfterExpiry.find(
      (cookie) => cookie.name === "unrelated_browser_cookie",
    )?.value,
  ).toBe("preserved");

  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Pair" }).click();
  await expect(page.getByRole("main")).toBeVisible();
});

test("activity folds move through the manual density ladder", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);

  const fold = page.locator("[data-activity-fold]").first();
  await expect(fold).toHaveAttribute(
    "data-activity-fold-presentation",
    "collapsed",
  );
  await fold
    .getByRole("button", { name: "Expand assistant activity", exact: true })
    .click();
  await expect(fold).toHaveAttribute(
    "data-activity-fold-presentation",
    "compact",
  );
  await expect(
    fold.getByText("Earlier activity is available on demand"),
  ).toHaveCount(0);
  await fold
    .getByRole("button", {
      name: "Collapse assistant activity from the upper boundary",
    })
    .click();
  await expect(fold).toHaveAttribute(
    "data-activity-fold-presentation",
    "collapsed",
  );
});

test("Pending stays read-only until an explicit Clear all confirmation", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);

  const composer = page.getByRole("form", { name: "Message composer" });
  const input = composer.getByRole("textbox", { name: "Message" });
  await input.fill(`long running prompt ${"x".repeat(260)}`);
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();

  await input.fill("first pending instruction");
  await composer.getByRole("button", { name: "Send as steer" }).click();
  const pending = page.getByRole("region", { name: "Pending input" });
  await expect(pending).toContainText("first pending instruction");
  await expect(
    pending.getByRole("button", { name: /pause|resume|delete|move/i }),
  ).toHaveCount(0);
  await composer.getByRole("button", { name: "Queue" }).click();
  await input.fill("second pending instruction");
  await composer
    .getByRole("button", { name: "Queue after current task" })
    .click();
  await expect(pending).toContainText("second pending instruction");
  await pending
    .getByRole("button", { name: "Clear all Pending input" })
    .click();
  await expect(pending).toContainText(
    "whatever remains queued when Pi handles this request",
  );
  await expect(pending.getByRole("listitem")).toHaveCount(2);
  await pending.getByRole("button", { name: "Clear all" }).click();
  await expect(pending).toHaveCount(0);
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
    if (!welcome || !input) throw new Error("Missing start surface");
    const menuBox = element.getBoundingClientRect();
    const welcomeBox = welcome.getBoundingClientRect();
    const inputBox = input.getBoundingClientRect();
    return {
      placement: element.dataset.placement,
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

test("project-file picker restores focus to its trigger", async ({ page }) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const trigger = page.getByRole("button", { name: "Add project files" });
  await trigger.click();
  const search = page.getByRole("combobox", { name: "Search project files" });
  await expect(search).toBeFocused();
  await search.press("Escape");
  await expect(trigger).toBeFocused();
});

test("files workbench searches, scrolls source, and isolates HTML previews", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const resources = page.getByRole("complementary", {
    name: "Context panel",
  });
  const recent = resources
    .locator(".files-browser__section")
    .filter({ hasText: "Recent" });
  await expect(recent.locator(".recent-file")).toHaveCount(5);
  await expect(
    resources.locator(".files-browser__section--workspace > h2"),
  ).toHaveText(mockWorkspaceName);

  const localOrigin = new URL(page.url()).origin;
  const externalRequests: string[] = [];
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    const external =
      (url.protocol === "http:" || url.protocol === "https:") &&
      url.origin !== localOrigin;
    if (external) {
      externalRequests.push(url.href);
      await route.abort();
      return;
    }
    await route.continue();
  });
  await recent.getByRole("button", { name: /page\.html/ }).click();
  const workspaceBack = resources.getByRole("button", {
    name: `Back to file browser for ${mockWorkspaceName}`,
  });
  await expect(workspaceBack).toHaveText(mockWorkspaceName);
  await expect(
    resources.getByRole("button", { name: "Source", exact: true }),
  ).toBeEnabled();
  const frame = page.frameLocator("iframe[title='Preview page.html']");
  await expect(frame.locator("h1")).toHaveText(
    "Quiet systems, legible signals.",
  );
  await expect(frame.locator("#status")).not.toHaveText("SCRIPT EXECUTED");
  expect(externalRequests).toEqual([]);

  const workspaceIndex = resources.locator(".res__index");
  const workspaceIndexHeight = () =>
    workspaceIndex.evaluate(
      (element) => element.getBoundingClientRect().height,
    );
  const stableIndexHeight = await workspaceIndexHeight();
  expect(stableIndexHeight).toBeGreaterThan(200);

  await resources.getByRole("button", { name: "Changes", exact: true }).click();
  await expect(resources.locator(".res__index-title")).toHaveText(
    "mock/analysis",
  );
  await expect(resources.locator(".res__index-summary")).toHaveText(
    "1 working",
  );
  await expect(resources.locator(".changes__additions")).toHaveText("+1");
  await expect(resources.locator(".changes__deletions")).toHaveText("−1");
  await expect(
    resources.getByRole("region", {
      name: /Source changes for .*page\.html/,
    }),
  ).toBeVisible();
  await resources.getByRole("button", { name: "Next change" }).click();
  await expect(resources.locator(".source-diff__line--active")).toHaveCount(2);
  expect(await workspaceIndexHeight()).toBeCloseTo(stableIndexHeight, 1);
  await resources.getByRole("button", { name: "Files", exact: true }).click();
  await expect(frame.locator("h1")).toHaveText(
    "Quiet systems, legible signals.",
  );

  await resources.getByRole("button", { name: "Back to file browser" }).click();
  const search = resources.getByRole("searchbox", {
    name: "Search workspace files",
  });
  await search.fill("file-previews/notebook.ipynb");
  await resources
    .locator(
      '[data-workspace-path="tests/browser/fixtures/file-previews/notebook.ipynb"]',
    )
    .click();
  await expect(
    resources.getByRole("document", { name: "Notebook preview" }),
  ).toBeVisible();
  await expect(
    resources.getByRole("heading", { name: "Observation window" }),
  ).toBeVisible();
  await expect(
    resources.getByText("24/24 samples passed continuity checks", {
      exact: true,
    }),
  ).toBeVisible();
  await resources.getByRole("button", { name: "Source", exact: true }).click();
  await expect(
    resources.getByRole("region", { name: "File source" }),
  ).toContainText('"nbformat": 4');

  await resources.getByRole("button", { name: "Back to file browser" }).click();
  await search.fill("file-previews/vector.svg");
  await resources
    .locator(
      '[data-workspace-path="tests/browser/fixtures/file-previews/vector.svg"]',
    )
    .click();
  await expect(resources.getByAltText("vector.svg")).toBeVisible();
  await resources.getByRole("button", { name: "Source", exact: true }).click();
  await expect(
    resources.getByRole("region", { name: "File source" }),
  ).toContainText("<svg");

  await resources.getByRole("button", { name: "Back to file browser" }).click();
  await search.fill("file-previews/document.md");
  await resources
    .locator(
      '[data-workspace-path="tests/browser/fixtures/file-previews/document.md"]',
    )
    .click();
  await expect(
    resources.getByRole("heading", { name: "Observation log · Station 07" }),
  ).toBeVisible();
  const fileHeader = resources.locator(".file-detail-header");
  const headerActionGeometry = () =>
    fileHeader.evaluate((header) => {
      const download = header.querySelector<HTMLElement>(".icon-button");
      const view = header.querySelector<HTMLElement>(
        ".file-detail-header__view",
      );
      if (!download || !view)
        throw new Error("File header actions are missing");
      return {
        downloadLeft: download.getBoundingClientRect().left,
        viewWidth: view.getBoundingClientRect().width,
      };
    });
  const previewHeaderGeometry = await headerActionGeometry();
  await resources.getByRole("button", { name: "Source", exact: true }).click();
  await expect(
    resources.getByRole("region", { name: "File source" }),
  ).toContainText("Working reading");
  const sourceHeaderGeometry = await headerActionGeometry();
  expect(sourceHeaderGeometry.downloadLeft).toBeCloseTo(
    previewHeaderGeometry.downloadLeft,
    1,
  );
  expect(sourceHeaderGeometry.viewWidth).toBeCloseTo(
    previewHeaderGeometry.viewWidth,
    1,
  );

  await resources.getByRole("button", { name: "Back to file browser" }).click();
  await search.fill("FilePreview.tsx");
  await resources
    .locator('[data-workspace-path="src/components/FilePreview.tsx"]')
    .click();
  const source = resources.getByRole("region", { name: "File source" });
  await expect(source).toBeVisible();
  expect(await workspaceIndexHeight()).toBeCloseTo(stableIndexHeight, 1);
  expect(
    await source.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);

  await source.evaluate((element) => {
    element.scrollTop = 0;
  });
  await source.hover({ position: { x: 12, y: 2 } });
  await page.mouse.wheel(0, 480);
  await expect
    .poll(() => source.evaluate((element) => element.scrollTop))
    .toBeGreaterThan(0);
});

test("files navigation preserves context across desktop and narrow workspaces", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();

  const pane = page.getByRole("complementary", { name: "Context panel" });
  const search = pane.getByRole("searchbox", {
    name: "Search workspace files",
  });
  await search.fill("WorkspaceBrowser.tsx");
  await pane
    .locator('[data-workspace-path="src/components/WorkspaceBrowser.tsx"]')
    .click();
  await expect(
    pane.getByRole("button", { name: "Back to file browser" }),
  ).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });
  const drawer = page.getByRole("dialog", { name: "Context panel" });
  await expect(drawer).toBeVisible();
  await drawer.getByRole("button", { name: "Back to file browser" }).click();
  await expect(
    drawer.getByRole("searchbox", { name: "Search workspace files" }),
  ).toHaveValue("WorkspaceBrowser.tsx");
  await drawer.getByRole("button", { name: "Close context pane" }).click();

  await page.getByRole("button", { name: "Toggle navigation" }).click();
  const navigation = page.getByRole("dialog", { name: "Sessions" });
  const explorer = navigation.getByRole("region", { name: "Workspace files" });
  await explorer.locator(".explorer__header").click();
  await explorer.locator('[data-workspace-path="README.md"]').click();

  await expect(page.getByRole("dialog", { name: "Sessions" })).toHaveCount(0);
  await expect(page.getByRole("dialog")).toHaveCount(1);
  await expect(
    page
      .getByRole("dialog", { name: "Context panel" })
      .getByRole("button", { name: "Back to file browser" }),
  ).toBeVisible();
});

test("session transitions cannot accept input for the previous session", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);

  let releaseOpen!: () => void;
  const openGate = new Promise<void>((resolve) => {
    releaseOpen = resolve;
  });
  let confirmOpenStarted!: () => void;
  const openStarted = new Promise<void>((resolve) => {
    confirmOpenStarted = resolve;
  });
  await page.route(/\/api\/sessions\/open(?:\?|$)/, async (route) => {
    confirmOpenStarted();
    await openGate;
    await route.continue();
  });

  const composer = page.getByRole("form", { name: "Message composer" });
  const message = page.getByRole("textbox", { name: "Message" });
  const switchSession = page
    .locator(".nav__row-main")
    .filter({ hasText: /Review extension event lifecycle/ })
    .click();
  try {
    await openStarted;
    await expect(composer).toHaveAttribute("aria-busy", "true");
    await expect(message).toBeDisabled();
  } finally {
    releaseOpen();
    await switchSession;
  }

  await expect(page.locator(".topbar__title-button")).toHaveText(
    /Review extension event lifecycle/,
  );
  await expect(message).toBeEnabled();
});

test("running composer exposes steer, queue, and abort controls", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("start a run for delivery controls");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("button", { name: "Steer", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Queue", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Abort running task", exact: true }),
  ).toBeVisible();

  const queue = page.getByRole("button", {
    name: "Queue",
    exact: true,
  });
  await queue.click();
  await expect(queue).toHaveAttribute("aria-pressed", "true");
  await expect(message).toHaveAttribute(
    "placeholder",
    "Add a follow-up for after this task…",
  );

  await page.getByRole("button", { name: "Abort running task" }).click();
  await expect(
    page.getByRole("button", { name: "Abort running task" }),
  ).toBeHidden();
});

test("narrow workbench keeps runtime status readable to accessibility tooling", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairedPage(page);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("keep the status visible");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();

  const results = await new AxeBuilder({ page })
    .include(".topbar")
    .include(".composer")
    .analyze();
  expect(results.violations).toEqual([]);
});

test("prompt map navigates user turns and adapts to the narrow workbench", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Prompt map long-session fixture/);
  await page.setViewportSize({ width: 1_280, height: 1_400 });
  const transcript = page.locator(".transcript");
  await transcript.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  const map = page.getByRole("navigation", { name: "User prompt navigation" });
  const previous = page.locator(".prompt-map__step--previous");
  const next = page.locator(".prompt-map__step--next");
  await expect(map).toBeVisible();
  await expect(next).toBeDisabled();
  const ticks = map.locator("[data-prompt-ordinal]");
  await expect(ticks).toHaveCount(12);
  const restingOrdinals = await ticks.evaluateAll((elements) =>
    elements.map((element) =>
      Number((element as HTMLElement).dataset.promptOrdinal),
    ),
  );
  expect(restingOrdinals).toEqual(
    Array.from({ length: 12 }, (_, index) => index + 1),
  );
  await expect(map.locator(".prompt-map__tick--active")).toHaveAttribute(
    "data-prompt-ordinal",
    "12",
  );
  await page.getByRole("button", { name: "Open prompt map" }).hover();
  await expect(page.locator(".prompt-map__list")).toBeVisible();
  await page.locator(".topbar__title").hover();
  await expect(page.locator(".prompt-map__list")).toBeHidden();
  await page.getByRole("button", { name: "Open prompt map" }).click();
  await expect(page.locator(".prompt-map__list")).toBeVisible();
  const list = page.locator(".prompt-map__list");
  await expect
    .poll(() =>
      list.evaluate((element) => element.scrollHeight > element.clientHeight),
    )
    .toBe(true);
  await list.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const firstPrompt = page.locator(".prompt-map__turn").first();
  await expect(firstPrompt).toBeVisible();
  await firstPrompt.click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.locator(".topbar__title").hover();
  await expect(
    page.getByRole("button", { name: "Open prompt map" }),
  ).toBeVisible();
  await expect(previous).toBeDisabled();
  await expect(next).toBeEnabled();

  await next.click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect(previous).toBeDisabled();

  await page.getByRole("button", { name: "Open prompt map" }).click();
  await expect(list).toBeVisible();
  await list.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  const lastPrompt = page.getByRole("button", {
    name: /^13\. Prompt map fixture turn 13/,
  });
  await expect(lastPrompt).toBeVisible();
  await lastPrompt.click();
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await page.locator(".topbar__title").hover();
  await expect(previous).toBeEnabled();
  await expect(next).toBeDisabled();

  await page.getByRole("button", { name: "Open prompt map" }).click();
  await expect(list).toBeVisible();
  await list.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
  });
  await page.locator(".prompt-map__turn").first().click();
  await page.locator(".topbar__title").hover();
  await expect(previous).toBeDisabled();

  await page.setViewportSize({ width: 390, height: 780 });
  await expect(map).toBeHidden();
  const searchLauncher = page.getByRole("button", {
    name: "Open conversation search",
  });
  const promptLauncher = page.getByRole("button", {
    name: "Open prompt navigation",
  });
  await expect(searchLauncher).toBeVisible();
  await expect(promptLauncher).toBeVisible();
  const launcherBoxes = await Promise.all([
    searchLauncher.boundingBox(),
    promptLauncher.boundingBox(),
  ]);
  expect(
    launcherBoxes.every(
      (box) => box !== null && box.width >= 44 && box.height >= 44,
    ),
  ).toBe(true);

  await searchLauncher.click();
  const mobileSearch = page.getByRole("searchbox", {
    name: "Search conversation",
  });
  await expect(mobileSearch).toBeVisible();
  await expect(mobileSearch).toBeFocused();
  await mobileSearch.fill("Prompt map fixture turn 13");
  await expect(page.getByLabel("Transcript search matches")).toContainText(
    "1 match",
  );
  await page.getByRole("button", { name: "Close conversation search" }).click();
  await expect(searchLauncher).toBeVisible();

  await promptLauncher.click();
  await expect(map).toBeVisible();
  const mobileControls = await map
    .locator(".prompt-map__step")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      }),
    );
  expect(
    mobileControls.every(
      (control) => control.width >= 44 && control.height >= 44,
    ),
  ).toBe(true);

  await page.getByRole("button", { name: "Open prompt map" }).click();
  await expect(list).toBeVisible();
  const overflow = await page
    .locator("html")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
