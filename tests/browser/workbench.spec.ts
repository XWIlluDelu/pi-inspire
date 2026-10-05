import { basename } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import {
  browserTestToken as token,
  openCommandPalette,
  openMockSession,
  pairedPage,
} from "./support/navigation";
const mockWorkspaceName = basename(browserWorkspace);

for (const narrow of [false, true]) {
  test(`session search keyboard selection preserves drafts and navigation on ${narrow ? "narrow" : "desktop"}`, async ({
    page,
  }) => {
    await page.setViewportSize(
      narrow ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    );
    await page.emulateMedia({ reducedMotion: "reduce" });
    await pairedPage(page);
    if (narrow)
      await page
        .getByRole("button", { name: "Toggle navigation", exact: true })
        .click();
    await openMockSession(page, /Review extension event lifecycle/);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("SESSION_SEARCH_ACTIVE_DRAFT");
    await page.locator('input[type="file"]').setInputFiles({
      name: "search-draft.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("retain draft artifact"),
    });
    await expect(page.locator(".attachment--ready")).toBeVisible();
    if (narrow)
      await page
        .getByRole("button", { name: "Toggle navigation", exact: true })
        .click();
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const first = page.getByRole("textbox", { name: "First message" });
    await first.fill("SESSION_SEARCH_START_DRAFT");
    const response = await page.request.get(
      "/api/sessions?q=&offset=0&limit=40",
    );
    const catalog = (await response.json()).sessions as Array<{ id: string }>;
    const find = (id: string) => catalog.find((session) => session.id === id)!;
    // UI-only catalog pages: deliberately no title contains the query. Native content
    // matching is checked with real isolated Pi JSONL in session-catalog.test.ts.
    await page.route("**/api/sessions?**", async (route) => {
      const params = new URL(route.request().url()).searchParams;
      if (params.get("q") !== "bodyneedle") return route.continue();
      const offset = Number(params.get("offset") ?? 0);
      await route.fulfill({
        json: {
          sessions:
            offset === 0
              ? [find("mock-active"), find("mock-history")]
              : [find("mock-errors")],
          total: 3,
          offset,
          limit: 2,
        },
      });
    });
    const findSession = async () => {
      const palette = await openCommandPalette(page);
      await palette.getByLabel("Filter commands").fill("/resume");
      await palette.getByRole("option", { name: /Find a session/ }).click();
      const search = page.getByRole("searchbox", { name: "Search sessions" });
      await expect(search).toBeFocused();
      return search;
    };
    let search = await findSession();
    await search.fill("bodyneedle");
    await expect(page.locator(".nav__row-name")).toHaveCount(2);
    await expect(first).toHaveValue("SESSION_SEARCH_START_DRAFT");
    await search.press("ArrowDown");
    const highlighted = page.locator(".nav__row--highlighted .nav__row-name");
    await expect(highlighted).toHaveText("Review extension event lifecycle");
    await expect(search).toBeFocused();
    await page
      .getByRole("button", { name: "Load older sessions", exact: true })
      .click();
    await expect(page.locator(".nav__row-name")).toHaveCount(3);
    await search.focus();
    await expect(highlighted).toHaveText("Review extension event lifecycle");
    await expect(
      page.getByRole("button", { name: "Load older sessions", exact: true }),
    ).toHaveCount(0);
    const a11y = await new AxeBuilder({ page }).include(".nav").analyze();
    expect(a11y.violations).toEqual([]);
    await page.screenshot({
      path: `output/playwright/session-search-${narrow ? "narrow" : "desktop"}.png`,
      animations: "disabled",
    });
    await search.press("Enter");
    await expect(input).toHaveValue("SESSION_SEARCH_ACTIVE_DRAFT");
    await expect(page.locator(".attachment")).toContainText("search-draft.txt");
    if (narrow)
      await expect(
        page.getByRole("dialog", { name: "Sessions", exact: true }),
      ).toHaveCount(0);
    search = await findSession();
    await search.fill("");
    await search.fill("bodyneedle");
    await expect(page.locator(".nav__row-name")).toHaveCount(2);
    await search.press("ArrowUp");
    await expect(highlighted).toHaveText(
      "Formula rendering and spectral analysis",
    );
    await search.dispatchEvent("compositionstart");
    await search.dispatchEvent("keydown", {
      key: "Enter",
      isComposing: true,
      bubbles: true,
    });
    await search.dispatchEvent("keydown", {
      key: "Escape",
      isComposing: true,
      bubbles: true,
    });
    await expect(search).toHaveValue("bodyneedle");
    await expect(page.locator(".topbar__title-button")).toHaveText(
      "Review extension event lifecycle",
    );
    await search.dispatchEvent("compositionend");
    await search.press("Enter");
    await expect(page.locator(".topbar__title-button")).toHaveText(
      "Formula rendering and spectral analysis",
    );
    await expect(input).toHaveValue("");
    if (narrow)
      await page
        .getByRole("button", { name: "Toggle navigation", exact: true })
        .click();
    const curate = async (action: string) => {
      const button = page.getByRole("button", {
        name: `${action} "Review extension event lifecycle"`,
        exact: true,
      });
      await page.locator(".nav__row").filter({ has: button }).hover();
      await button.click();
    };
    await curate("Hide");
    await expect(page.locator(".nav__group--hidden")).toContainText(
      "Review extension event lifecycle",
    );
    await curate("Restore");
    await expect(page.locator(".nav__group--hidden")).toHaveCount(0);
    await curate("Pin");
    await expect(page.locator(".nav__group--pinned")).toContainText(
      "Review extension event lifecycle",
    );
    await curate("Unpin");
    await search.fill("");
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await expect(first).toHaveValue("SESSION_SEARCH_START_DRAFT");
  });
}

test("composer text drafts survive reload and stay partitioned through switching, history, sending and clearing", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const draft = "UNSENT_REFRESH_SAFE\n保留 exact draft";
  await input.fill(draft);
  await page.reload();
  await expect(input).toHaveValue(draft);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  await expect(input).toHaveValue("");
  await input.fill("other session draft");
  await openMockSession(page, /Review extension event lifecycle/);
  await expect(input).toHaveValue(draft);
  // Merely browsing history must not overwrite the saved pre-browse draft.
  await input.evaluate((element: HTMLTextAreaElement) =>
    element.setSelectionRange(0, 0),
  );
  await input.press("ArrowUp");
  await expect(input).not.toHaveValue(draft);
  await page.reload();
  await expect(input).toHaveValue(draft);
  await input.fill("send and do not resurrect");
  const accepted = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/prompt") && response.status() === 202,
  );
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await accepted;
  await expect(input).toHaveValue("");
  await page.reload();
  await expect(input).toHaveValue("");
  await input.fill("explicitly removed");
  await input.fill("");
  await page.reload();
  await expect(input).toHaveValue("");
  await page.getByRole("button", { name: "New session", exact: true }).click();
  const first = page.getByRole("textbox", { name: "First message" });
  await first.fill("separate start-surface draft");
  await page.reload();
  await expect(first).toHaveValue("separate start-surface draft");
  await first.fill("");
});

test("composer expansion follows real wrapping and preserves the same editor, artifacts and completion", async ({
  page,
  browser,
}) => {
  await page.setViewportSize({ width: 1440, height: 960 });
  await pairedPage(page);
  await openMockSession(page, /Review extension event lifecycle/);
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const expand = page.getByRole("button", {
    name: "Expand editor",
    exact: true,
  });
  const collapse = page.getByRole("button", {
    name: "Collapse editor",
    exact: true,
  });
  await input.fill("short input");
  await expect(expand).toHaveCount(0);
  const padding = await input.evaluate((element) => ({
    left: getComputedStyle(element).paddingLeft,
    right: getComputedStyle(element).paddingRight,
  }));
  expect(padding.right).toBe(padding.left);
  const wrapped = "wrapped layout text ".repeat(55);
  await input.fill(wrapped);
  await expect(expand).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(expand).toBeVisible();
  await expect
    .poll(() =>
      input.evaluate(
        (element) => element.scrollHeight > element.clientHeight + 1,
      ),
    )
    .toBe(true);
  expect(
    await input.evaluate((element) =>
      Number.parseFloat(getComputedStyle(element).paddingRight),
    ),
  ).toBeGreaterThan(Number.parseFloat(padding.right));
  await page.setViewportSize({ width: 1440, height: 960 });
  await expect(expand).toHaveCount(0);
  await page.locator(".composer__file-input").setInputFiles({
    name: "expanded.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("attachment retained"),
  });
  await expect(page.getByText("expanded.txt", { exact: true })).toBeVisible();
  const long = Array.from(
    { length: 60 },
    (_, index) =>
      `Long-form editing line ${index}: preserve the same input and selection.`,
  ).join("\n");
  await input.fill(long);
  await expect(expand).toBeVisible();
  const compactHeight = await input.evaluate((element) => element.clientHeight);
  await input.evaluate((element: HTMLTextAreaElement) => {
    element.dataset.sameEditor = "yes";
    element.focus();
    element.setSelectionRange(4, 17, "backward");
  });
  await expand.click();
  await expect(collapse).toBeVisible();
  await expect(input).toBeFocused();
  expect(
    await input.evaluate((element: HTMLTextAreaElement) => [
      element.dataset.sameEditor,
      element.selectionStart,
      element.selectionEnd,
      element.selectionDirection,
    ]),
  ).toEqual(["yes", 4, 17, "backward"]);
  expect(
    await input.evaluate((element) => element.clientHeight),
  ).toBeGreaterThan(compactHeight + 100);
  await expect(input).toHaveValue(long);
  await expect(page.getByText("expanded.txt", { exact: true })).toBeVisible();
  await collapse.focus();
  await collapse.press("Enter");
  await expect(input).toBeFocused();
  await expect(expand).toBeVisible();
  await expand.click();
  await input.fill("@TerminalSettingsDialog");
  const option = page.getByRole("option", {
    name: "TerminalSettingsDialog.tsx src/components/TerminalSettingsDialog.tsx",
    exact: true,
  });
  await expect(option).toBeVisible();
  await input.press("Tab");
  await expect(input).toHaveValue(
    '@"src/components/TerminalSettingsDialog.tsx" ',
  );
  await expect(collapse).toBeVisible();
  await input.fill("/model");
  await expect(
    page.getByRole("listbox", { name: "Slash command completions" }),
  ).toBeVisible();
  await input.press("Escape");
  await expect(
    page.getByRole("listbox", { name: "Slash command completions" }),
  ).toHaveCount(0);
  await expect(collapse).toBeVisible();
  await input.fill("short again");
  await expect(collapse).toBeVisible();
  await collapse.click();
  await expect(expand).toHaveCount(0);
  await expect(collapse).toHaveCount(0);
  await expect(input).toHaveValue("short again");
  await expect(page.getByText("expanded.txt", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "New session", exact: true }).click();
  const first = page.getByRole("textbox", { name: "First message" });
  await expect(expand).toHaveCount(0);
  await first.fill(long);
  await expect(expand).toBeVisible();
  const firstCompact = await first.evaluate((element) => element.clientHeight);
  await expand.click();
  expect(
    await first.evaluate((element) => element.clientHeight),
  ).toBeGreaterThan(firstCompact);
  await first.fill("short first message");
  await expect(collapse).toBeVisible();
  await collapse.click();
  await expect(expand).toHaveCount(0);
  await first.fill("");

  const touchContext = await browser.newContext({
    baseURL: new URL(page.url()).origin,
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
  });
  try {
    const touch = await touchContext.newPage();
    await pairedPage(touch);
    await touch.getByRole("button", { name: "Toggle navigation" }).click();
    await openMockSession(touch, /Formula rendering and spectral analysis/);
    const touchInput = touch.getByRole("textbox", {
      name: "Message",
      exact: true,
    });
    await touchInput.fill("short touch input");
    expect(
      await touchInput.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.paddingLeft === style.paddingRight;
      }),
    ).toBe(true);
    await touchInput.fill(long);
    const touchExpand = touch.getByRole("button", {
      name: "Expand editor",
      exact: true,
    });
    await expect(touchExpand).toBeVisible();
    const bounds = await touchExpand.boundingBox();
    expect(bounds!.width).toBeGreaterThanOrEqual(44);
    expect(bounds!.height).toBeGreaterThanOrEqual(44);
    expect(
      await touchInput.evaluate(
        (element) => getComputedStyle(element).paddingRight,
      ),
    ).toBe("48px");
    await touchExpand.tap();
    await expect(
      touch.getByRole("button", { name: "Collapse editor", exact: true }),
    ).toBeVisible();
    await expect(touchInput).toBeFocused();
    await touchInput.fill("touch multiline");
    await touchInput.press("Enter");
    await expect(touchInput).toHaveValue("touch multiline\n");
    await touch
      .getByRole("button", { name: "Collapse editor", exact: true })
      .tap();
    await expect(
      touch.getByRole("button", { name: "Expand editor", exact: true }),
    ).toHaveCount(0);
    expect(
      await touchInput.evaluate((element) => {
        const style = getComputedStyle(element);
        return style.paddingLeft === style.paddingRight;
      }),
    ).toBe(true);
  } finally {
    await touchContext.close();
  }
});

test("Settings activity menus remain clickable beyond their card and persist the choice", async ({
  page,
}) => {
  await pairedPage(page);
  for (const viewport of [
    { width: 1440, height: 960 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Settings", exact: true });
    await dialog.getByRole("button", { name: "Reset preferences" }).click();
    await dialog
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    await dialog.getByRole("combobox", { name: "Activity groups" }).click();
    await page
      .getByRole("listbox", { name: "Activity groups", exact: true })
      .getByRole("option", { name: "Collapsed", exact: false })
      .click();
    await expect(
      dialog.getByRole("combobox", { name: "Activity groups" }),
    ).toHaveText("Collapsed");
    await expect
      .poll(async () => {
        const response = await page.request.get("/api/bootstrap");
        return (await response.json()).preferences.activityFoldVisibility;
      })
      .toBe("collapsed");
    await page.reload();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await dialog
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    await expect(
      dialog.getByRole("combobox", { name: "Activity groups" }),
    ).toHaveText("Collapsed");
    const restored = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/preferences") &&
        response.request().method() === "PATCH",
    );
    await dialog.getByRole("button", { name: "Reset preferences" }).click();
    await restored;
    const activity = dialog.getByRole("combobox", { name: "Activity groups" });
    await activity.click();
    await page.keyboard.press("Escape");
    await expect(dialog.getByRole("listbox")).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(activity).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
  }
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

test("activity dots swap theme colors without layout motion and respect reduced motion", async ({
  page,
}, testInfo) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const dots = page
    .locator(".activity-fold__summary-badge .activity-fold__dots")
    .first();
  await expect(dots).toBeVisible();
  // Lifecycle wiring is covered by the fold unit tests. Isolate CSS here so
  // animation checks do not depend on the mock worker's streaming duration.
  await dots.evaluate((element) =>
    element.classList.add("activity-fold__dots--active"),
  );
  await page.emulateMedia({ reducedMotion: "no-preference" });
  for (const palette of ["amber", "teal"]) {
    for (const theme of ["light", "dark"]) {
      const result = await dots.evaluate(
        (element, { palette, theme }) => {
          document.documentElement.dataset.palette = palette;
          document.documentElement.dataset.theme = theme;
          const rootStyle = getComputedStyle(document.documentElement);
          const color = (token: string) => {
            const probe = document.createElement("span");
            probe.style.color = rootStyle.getPropertyValue(token).trim();
            return probe.style.color;
          };
          const frames = [100, 1100].map((time) => {
            const colors = Array.from(element.children, (dot) => {
              for (const animation of dot.getAnimations()) {
                animation.pause();
                animation.currentTime = time;
              }
              return getComputedStyle(dot, "::before").backgroundColor;
            });
            const { width, height } = element.getBoundingClientRect();
            return { colors, width, height };
          });
          const reference = document.createElement("span");
          reference.textContent = "···";
          reference.style.letterSpacing = "0.25em";
          element.parentElement!.append(reference);
          const originalWidth = reference.getBoundingClientRect().width;
          reference.remove();
          return {
            frames,
            originalWidth,
            tool: color("--activity-tool"),
            thinking: color("--activity-think"),
            squares: Array.from(element.children, (dot) => {
              const square = getComputedStyle(dot, "::before");
              return {
                width: square.width,
                height: square.height,
                radius: square.borderRadius,
              };
            }),
          };
        },
        { palette, theme },
      );
      expect(result.frames[0]!.colors).toEqual([
        result.tool,
        result.thinking,
        result.tool,
      ]);
      expect(result.frames[1]!.colors).toEqual([
        result.thinking,
        result.tool,
        result.thinking,
      ]);
      expect(result.squares).toEqual(
        Array.from({ length: 3 }, () => ({
          width: "2px",
          height: "2px",
          radius: "0px",
        })),
      );
      expect(result.frames[0]!.width).toBeCloseTo(result.originalWidth, 1);
      expect(result.frames[0]!.width).toBe(result.frames[1]!.width);
      expect(result.frames[0]!.height).toBe(result.frames[1]!.height);
    }
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator(".transcript").hover();
  await page.mouse.wheel(0, -5000);
  await dots.scrollIntoViewIfNeeded();
  await expect(dots).toBeInViewport();
  await dots.screenshot({
    path: testInfo.outputPath("square-activity-dots.png"),
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await dots.evaluate((element) =>
      Array.from(
        element.children,
        (dot) => getComputedStyle(dot).animationName,
      ),
    ),
  ).toEqual(["none", "none", "none"]);
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

test("files workbench searches, renders documents, and isolates active content", async ({
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

  const activePdfContent: string[] = [];
  page.on("dialog", async (dialog) => {
    activePdfContent.push(dialog.message());
    await dialog.dismiss();
  });
  page.on("popup", async (popup) => {
    activePdfContent.push(popup.url());
    await popup.close();
  });
  await resources
    .getByRole("button", { name: "report.pdf", exact: true })
    .click();
  const pdf = page.getByRole("document", { name: "Preview report.pdf" });
  const pdfPage = pdf.locator(".pdf-preview__page");
  const textLayer = pdf.locator(".pdf-preview__text-layer");
  await expect(textLayer).toContainText("Experiment summary");
  await expect(pdfPage).toHaveAttribute("aria-busy", "false");
  const ink = await pdf
    .locator("canvas")
    .evaluate((canvas: HTMLCanvasElement) => {
      const pixels = canvas
        .getContext("2d")!
        .getImageData(0, 0, canvas.width, canvas.height).data;
      let count = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (
          pixels[i + 3]! > 0 &&
          Math.min(pixels[i]!, pixels[i + 1]!, pixels[i + 2]!) < 200
        )
          count++;
      return count;
    });
  expect(ink).toBeGreaterThan(150);
  await pdf.getByRole("button", { name: "Next PDF page" }).click();
  await expect(textLayer).toContainText("Measurement details");
  await expect(pdfPage).toHaveAttribute("aria-busy", "false");
  await expect(
    pdf.getByRole("button", { name: "Next PDF page" }),
  ).toBeDisabled();
  const selection = await textLayer.evaluate((layer) => {
    const range = document.createRange();
    range.selectNodeContents(layer);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    return selection.toString();
  });
  expect(selection).toContain("Report page 2 - selectable text");
  await page.screenshot({
    path: "output/playwright/pdf-selection-desktop.png",
  });
  await page.evaluate(() => window.getSelection()?.removeAllRanges());

  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: 390, height: 620 });
  const scroll = pdf.getByRole("region", { name: "PDF page 2" });
  await expect
    .poll(() =>
      pdf.evaluate((root) => {
        const sheet = root.querySelector<HTMLElement>(".pdf-preview__sheet");
        const scroll = root.querySelector<HTMLElement>(".pdf-preview__scroll");
        return (
          sheet &&
          !sheet.hidden &&
          scroll &&
          Math.abs(
            sheet.getBoundingClientRect().width - (scroll.clientWidth - 24),
          ) < 1
        );
      }),
    )
    .toBe(true);
  const position = await scroll.evaluate((element) => {
    element.scrollTop = 80;
    return element.scrollTop;
  });
  expect(position).toBeGreaterThan(50);
  await pdf.getByRole("button", { name: "Zoom in PDF" }).click();
  await expect
    .poll(async () =>
      Math.abs(
        (await scroll.evaluate((element) => element.scrollTop)) -
          position * 1.25,
      ),
    )
    .toBeLessThanOrEqual(1);
  await pdf.getByRole("button", { name: "Fit PDF to width" }).click();
  await expect
    .poll(async () =>
      Math.abs(
        (await scroll.evaluate((element) => element.scrollTop)) - position,
      ),
    )
    .toBeLessThanOrEqual(1);
  expect(
    await scroll.evaluate(
      (element) => element.scrollWidth - element.clientWidth,
    ),
  ).toBeLessThanOrEqual(1);
  await page.screenshot({ path: "output/playwright/pdf-narrow.png" });
  await page.setViewportSize(viewport);

  await resources
    .getByRole("button", { name: "unsafe.pdf", exact: true })
    .click();
  const staticPdf = page.getByRole("document", { name: "Preview unsafe.pdf" });
  await expect(staticPdf.locator(".pdf-preview__page")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(staticPdf).toContainText("Static safety fixture");
  await expect(staticPdf.locator("a, form, iframe, object, embed")).toHaveCount(
    0,
  );
  expect(activePdfContent).toEqual([]);
  expect(externalRequests).toEqual([]);
  await resources
    .locator(
      '[data-workspace-path="tests/browser/fixtures/file-previews/page.html"]',
    )
    .click();
  await expect(frame.locator("#status")).not.toHaveText("SCRIPT EXECUTED");
  await expect.poll(() => page.workers().length).toBe(0);

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
  const vector = resources.getByAltText("vector.svg");
  await expect(vector).toBeVisible();
  await expect(vector).not.toHaveCSS("background-image", "none");
  const vectorGeometry = await vector.evaluate((image) => {
    const bounds = image.getBoundingClientRect();
    const canvas = image.parentElement!.getBoundingClientRect();
    return {
      ratio: bounds.width / bounds.height,
      width: bounds.width,
      height: bounds.height,
      canvasWidth: canvas.width,
      canvasHeight: canvas.height,
    };
  });
  // The checkerboard belongs to the actual image rectangle, not letterboxing;
  // viewBox-only SVGs must still have non-zero, contained intrinsic geometry.
  expect(vectorGeometry.ratio).toBeCloseTo(720 / 420, 2);
  expect(vectorGeometry.width).toBeGreaterThan(0);
  expect(vectorGeometry.height).toBeGreaterThan(0);
  expect(vectorGeometry.width).toBeLessThanOrEqual(vectorGeometry.canvasWidth);
  expect(vectorGeometry.height).toBeLessThanOrEqual(
    vectorGeometry.canvasHeight,
  );
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

test("narrow workbench preserves primary controls and drawer dismissal", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Formula rendering and spectral analysis/);
  await page.route("**/api/bootstrap**", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    for (const model of body.availableModels ?? []) model.reasoning = false;
    const active = body.snapshot?.active;
    if (active?.model) active.model.reasoning = false;
    for (const model of active?.availableModels ?? []) model.reasoning = false;
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Thinking level" }),
  ).toBeDisabled();

  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    const model = page
      .locator(".composer__meta")
      .getByRole("button", { name: "Model", exact: true });
    await expect(model).toBeVisible();
    expect((await model.boundingBox())!.width).toBeGreaterThanOrEqual(44);
    const labelFits = await model
      .locator(".dropdown__value")
      .evaluate((label) => label.scrollWidth <= label.clientWidth + 1);
    expect(labelFits).toBe(true);
    const metadata = page.locator(".topbar__workspace-meta");
    if (width === 390) {
      const meta = await metadata.boundingBox();
      const git = await page.locator(".topbar__git").boundingBox();
      expect(git!.x + git!.width).toBeLessThanOrEqual(
        meta!.x + meta!.width + 1,
      );
    } else {
      // The 320px bar yields secondary workspace details to primary controls.
      await expect(metadata).toBeHidden();
    }
    const toggle = page.getByRole("button", { name: "Toggle navigation" });
    await toggle.click();
    const navigation = page.getByRole("dialog", {
      name: "Sessions",
      exact: true,
    });
    await navigation.getByRole("button", { name: "Close navigation" }).click();
    await expect(navigation).toBeHidden();
    await expect(toggle).toBeFocused();
  }

  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  await page.getByRole("button", { name: "History", exact: true }).click();
  const history = page.getByRole("dialog", { name: "Context panel" });
  await expect(history.getByRole("button", { name: /Refresh/ })).toHaveCount(1);
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
