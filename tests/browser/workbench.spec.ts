import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";

const token = "inspire-browser-test-token";

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

type FontTransfer = { url: string; encodedBytes: number };

/** CDP's encodedDataLength is an observed cold-cache transfer metric. It is
 * intentionally separate from the static package-candidate size report. */
async function measureColdStartFonts(page: import("@playwright/test").Page) {
  const cdp = await page.context().newCDPSession(page);
  const pending = new Map<string, string>();
  const fonts: FontTransfer[] = [];
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  cdp.on(
    "Network.responseReceived",
    (event: { requestId: string; type: string; response: { url: string } }) => {
      if (event.type === "Font")
        pending.set(event.requestId, event.response.url);
    },
  );
  cdp.on(
    "Network.loadingFinished",
    (event: { requestId: string; encodedDataLength: number }) => {
      const url = pending.get(event.requestId);
      if (!url) return;
      fonts.push({ url, encodedBytes: event.encodedDataLength });
      pending.delete(event.requestId);
    },
  );
  return async () => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForLoadState("networkidle");
    await cdp.detach();
    return {
      measurement:
        "CDP Network.loadingFinished encodedDataLength with cache disabled",
      fonts,
      totalEncodedBytes: fonts.reduce(
        (total, font) => total + font.encodedBytes,
        0,
      ),
    };
  };
}

async function attachFontTransfer(
  page: import("@playwright/test").Page,
  testInfo: import("@playwright/test").TestInfo,
  label: string,
) {
  const stop = await measureColdStartFonts(page);
  return async () => {
    const report = await stop();
    // Keep the metric in the CI artifact even for a passing test; reporters
    // are allowed to discard in-memory attachments for successful cases.
    const directory = join("output", "playwright", "font-transfer");
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${label}.json`);
    await writeFile(path, JSON.stringify(report, null, 2));
    await testInfo.attach(`cold-start-font-transfer-${label}.json`, {
      path,
      contentType: "application/json",
    });
    return report;
  };
}

test("mock workbench pairs, clears its URL token, and opens context surfaces", async ({
  page,
}, testInfo) => {
  const stopFontTransfer = await attachFontTransfer(page, testInfo, "desktop");
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
    page.getByRole("complementary", { name: "Files and resources" }),
  ).toBeVisible();
  expect(externalRequests).toEqual([]);
  const fontTransfer = await stopFontTransfer();
  expect(fontTransfer.totalEncodedBytes).toBeGreaterThanOrEqual(0);
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

test("paused Pending remains a lightweight editable queue across settlement", async ({
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
  await pending.getByRole("button", { name: "Pause Pending input" }).click();

  const paused = page.getByRole("region", { name: "Pending input paused" });
  await expect(paused).toBeVisible();
  await composer.getByRole("button", { name: "Queue" }).click();
  await input.fill("second pending instruction");
  await composer
    .getByRole("button", { name: "Queue after current task" })
    .click();
  await expect(paused).toContainText("second pending instruction");

  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toHaveCount(0, { timeout: 10_000 });
  await expect(paused).toContainText("first pending instruction");
  await paused
    .getByRole("button", { name: "Move Steer item 1 to Queue" })
    .click();
  await expect(
    paused.getByRole("region", { name: "Pending queue" }),
  ).toContainText("first pending instruction");
  await paused.getByRole("button", { name: "Delete Queue item 1" }).click();
  await expect(paused).not.toContainText("second pending instruction");

  await paused.getByRole("button", { name: "Clear all Pending input" }).click();
  await paused.getByRole("button", { name: "Clear all" }).click();
  await expect(paused).toContainText("Pending paused");
  await expect(paused.getByRole("listitem")).toHaveCount(0);

  await input.fill("queued while idle and paused");
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect(paused).toContainText("queued while idle and paused");
  await paused.getByRole("button", { name: "Resume Pending input" }).click();
  await expect(
    page.getByRole("region", { name: "Pending input paused" }),
  ).toHaveCount(0);
});

test("narrow pairing controls contain a long access token", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await page.goto("/");
  await page.getByLabel("Access token").fill("x".repeat(64));

  const layout = await page.locator(".token-gate__card").evaluate((card) => {
    const form = card.querySelector("form");
    const input = card.querySelector("input");
    const button = card.querySelector("button");
    if (!form || !input || !button) throw new Error("Missing pairing controls");
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    };
    const cardBox = box(card);
    const fits = (element: Element) => {
      const rect = box(element);
      return rect.left >= cardBox.left && rect.right <= cardBox.right;
    };
    return {
      cardOverflow: card.scrollWidth > card.clientWidth,
      documentOverflow:
        document.documentElement.scrollWidth >
        document.documentElement.clientWidth,
      form: fits(form),
      input: fits(input),
      button: fits(button),
    };
  });

  expect(layout.cardOverflow).toBe(false);
  expect(layout.documentOverflow).toBe(false);
  expect(layout.form).toBe(true);
  expect(layout.input).toBe(true);
  expect(layout.button).toBe(true);
});

test("narrow composer keeps its trailing action stable without a context meter", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairedPage(page);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await page.getByRole("button", { name: "New session" }).click();
  await expect(
    page.getByRole("form", { name: "Start a session" }),
  ).toBeVisible();

  const layout = await page
    .locator(".welcome__composer .composer__meta")
    .evaluate((meta) => {
      const action = meta.querySelector<HTMLElement>(
        "[aria-label='Start session']",
      );
      if (!action) throw new Error("Missing start-session action");
      const metaBox = meta.getBoundingClientRect();
      const actionBox = action.getBoundingClientRect();
      return {
        actionAtTrailingEdge: Math.abs(metaBox.right - actionBox.right) < 1,
        metaOverflow: meta.scrollWidth > meta.clientWidth,
      };
    });

  expect(layout.metaOverflow).toBe(false);
  expect(layout.actionAtTrailingEdge).toBe(true);
});

test("narrow user prompts preserve source lines and normal-sized math", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await pairedPage(page);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await openMockSession(page, /Formula rendering and spectral analysis/);
  await page
    .getByRole("textbox", { name: "Message" })
    .fill("第一行说明\n第二行含有 $E = mc^2$\n第三行结论");
  await page.getByRole("button", { name: "Send message" }).click();
  const prompt = page.locator(".turn--user").last();
  await expect(prompt).toContainText("第一行说明");
  await expect(prompt).toContainText("第三行结论");

  const layout = await prompt.evaluate((turn) => {
    const root = turn.querySelector<HTMLElement>(".rich-text--user");
    const paragraph = root?.querySelector<HTMLElement>("p");
    const math = root?.querySelector<HTMLElement>(".katex");
    if (!root || !paragraph || !math) throw new Error("Missing user math");
    return {
      overflow: root.scrollWidth > root.clientWidth,
      whiteSpace: getComputedStyle(paragraph).whiteSpace,
      mathScale:
        Number.parseFloat(getComputedStyle(math).fontSize) /
        Number.parseFloat(getComputedStyle(paragraph).fontSize),
    };
  });

  expect(layout.overflow).toBe(false);
  expect(layout.whiteSpace).toBe("pre-wrap");
  expect(layout.mathScale).toBeCloseTo(1.05, 2);
  await page.getByRole("button", { name: "Abort running task" }).click();
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

test("resource history virtualizes rows and sandboxed HTML makes no external request", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const resources = page.getByRole("region", { name: "Referenced files" });
  await expect(
    resources.getByRole("button", { name: /^Earlier files \(65\)$/ }),
  ).toBeVisible();
  await resources
    .getByRole("button", { name: /^Earlier files \(65\)$/ })
    .click();
  await expect(resources.locator(".res__virtual")).toBeVisible();
  const mountedRows = await resources.locator(".res__virtual-row").count();
  expect(mountedRows).toBeGreaterThan(0);
  expect(mountedRows).toBeLessThan(73);

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
  await resources
    .getByRole("button", { name: /sandbox-resource\.html/ })
    .click();
  await expect(
    page.getByRole("button", { name: "Open in sandboxed view" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Open in sandboxed view" }).click();
  const frame = page.frameLocator("iframe[title^='Sandboxed preview']");
  await expect(frame.locator("h1")).toHaveText("Sandbox fixture");
  await expect
    .poll(async () => {
      const sandbox = page
        .frames()
        .find((candidate) => candidate.url().startsWith("blob:"));
      return sandbox ? sandbox.evaluate(() => document.readyState) : null;
    })
    .toBe("complete");
  expect(externalRequests).toEqual([]);
});

test("earlier-branch banner can fork and return to the durable leaf", async ({
  page,
}) => {
  await pairedPage(page);
  const title = /Earlier branch recovery fixture/;
  await openMockSession(page, title);
  const banner = page.getByRole("region", { name: "Earlier branch context" });
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Fork from here" }).click();
  await expect(banner).toBeHidden();

  await openMockSession(page, title);
  await expect(banner).toBeVisible();
  await banner.getByRole("button", { name: "Back to latest" }).click();
  await expect(banner).toBeHidden();
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
  await page.route("**/api/sessions/open", async (route) => {
    await openGate;
    await route.continue();
  });

  const composer = page.getByRole("form", { name: "Message composer" });
  const message = page.getByRole("textbox", { name: "Message" });
  try {
    await page
      .locator(".nav__row-main")
      .filter({ hasText: /Review extension event lifecycle/ })
      .click();
    await expect(composer).toHaveAttribute("aria-busy", "true");
    await expect(message).toBeDisabled();
  } finally {
    releaseOpen();
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
  const liveAppearance = await page
    .locator(".composer")
    .evaluate((composer) => {
      const root = document.documentElement;
      const initialTheme = root.getAttribute("data-theme");
      const initialPalette = root.getAttribute("data-palette");
      const states = ["light", "dark"].flatMap((theme) =>
        ["amber", "teal"].map((palette) => {
          root.setAttribute("data-theme", theme);
          root.setAttribute("data-palette", palette);
          const style = getComputedStyle(composer);
          return {
            animation: style.animationName,
            duration: style.animationDuration,
            shadow: style.boxShadow,
          };
        }),
      );
      if (initialTheme === null) root.removeAttribute("data-theme");
      else root.setAttribute("data-theme", initialTheme);
      if (initialPalette === null) root.removeAttribute("data-palette");
      else root.setAttribute("data-palette", initialPalette);
      return states;
    });
  expect(
    liveAppearance.every(
      ({ animation, duration, shadow }) =>
        animation === "composer-running-breathe" &&
        duration === "2.8s" &&
        shadow !== "none",
    ),
  ).toBe(true);
  const firstBreath = await page
    .locator(".composer")
    .evaluate((composer) => getComputedStyle(composer).boxShadow);
  await page.waitForTimeout(700);
  expect(
    await page
      .locator(".composer")
      .evaluate((composer) => getComputedStyle(composer).boxShadow),
  ).not.toBe(firstBreath);
  await page.emulateMedia({ reducedMotion: "reduce" });
  const reducedMotionAppearance = await page
    .locator(".composer")
    .evaluate((composer) => {
      const style = getComputedStyle(composer);
      return { animation: style.animationName, shadow: style.boxShadow };
    });
  expect(reducedMotionAppearance.animation).toBe("none");
  expect(reducedMotionAppearance.shadow).not.toBe("none");

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
}, testInfo) => {
  const stopFontTransfer = await attachFontTransfer(
    page,
    testInfo,
    "mobile-390px",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await pairedPage(page);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await openMockSession(page, /Formula rendering and spectral analysis/);
  const controlCenterDelta = await page
    .locator(".composer__meta")
    .evaluate((meta) => {
      const model = meta.querySelector<HTMLElement>("[aria-label='Model']");
      const effort = meta.querySelector<HTMLElement>(
        "[aria-label='Thinking level']",
      );
      if (!model || !effort) return Number.POSITIVE_INFINITY;
      const modelBox = model.getBoundingClientRect();
      const effortBox = effort.getBoundingClientRect();
      return Math.abs(
        modelBox.y + modelBox.height / 2 - (effortBox.y + effortBox.height / 2),
      );
    });
  expect(controlCenterDelta).toBeLessThan(2);
  const message = page.getByRole("textbox", { name: "Message" });
  await message.fill("keep the status visible");
  await page.getByRole("button", { name: "Send message" }).click();
  const composer = page.locator(".composer");
  await expect(composer).toHaveClass(/composer--running/);
  await page.getByRole("button", { name: "Abort running task" }).focus();
  const runningVisual = await composer.evaluate((element) => {
    const focused = element.matches(":focus-within");
    const focusedStyle = getComputedStyle(element);
    const focusedAnimation = focusedStyle.animationName;
    const focusedShadow = focusedStyle.boxShadow;
    (document.activeElement as HTMLElement | null)?.blur();
    const unfocusedStyle = getComputedStyle(element);
    return {
      focused,
      focusedAnimation,
      focusedShadow,
      unfocusedAnimation: unfocusedStyle.animationName,
      unfocusedShadow: unfocusedStyle.boxShadow,
    };
  });
  expect(runningVisual.focused).toBe(true);
  expect(runningVisual.focusedAnimation).toBe("composer-running-breathe");
  expect(runningVisual.unfocusedAnimation).toBe("composer-running-breathe");
  expect(runningVisual.focusedShadow).not.toBe("none");
  expect(runningVisual.unfocusedShadow).not.toBe("none");

  const results = await new AxeBuilder({ page })
    .include(".topbar")
    .include(".composer")
    .analyze();
  expect(results.violations).toEqual([]);
  const fontTransfer = await stopFontTransfer();
  expect(fontTransfer.totalEncodedBytes).toBeGreaterThanOrEqual(0);
});

test("narrow running composer contains a long model label at 360px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 740 });
  await pairedPage(page);
  await page.getByRole("button", { name: "Toggle navigation" }).click();
  await openMockSession(page, /Formula rendering and spectral analysis/);
  await page.getByRole("textbox", { name: "Message" }).fill("start layout run");
  await page.getByRole("button", { name: "Send message" }).click();
  await expect(
    page.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();

  const layout = await page.locator(".composer__meta").evaluate((meta) => {
    const model = meta.querySelector<HTMLElement>("[aria-label='Model']");
    const label = model?.querySelector<HTMLElement>(".dropdown__value");
    if (!model || !label) throw new Error("Missing model trigger");
    label.textContent = "claude-3-7-sonnet-thinking-experimental";
    const box = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
      };
    };
    const controls = [...meta.children]
      .map((element) => box(element as HTMLElement))
      .filter((control) => control.width > 0);
    const overlaps = controls.some((control, index) =>
      controls
        .slice(index + 1)
        .some(
          (other) =>
            control.left < other.right &&
            control.right > other.left &&
            control.top < other.bottom &&
            control.bottom > other.top,
        ),
    );
    return {
      controls,
      metaOverflow: meta.scrollWidth > meta.clientWidth,
      modelContentOverflow: model.scrollWidth > model.clientWidth,
      labelIsTruncated: label.scrollWidth > label.clientWidth,
      overlaps,
    };
  });

  expect(layout.metaOverflow).toBe(false);
  expect(layout.modelContentOverflow).toBe(false);
  expect(layout.labelIsTruncated).toBe(true);
  expect(layout.overlaps).toBe(false);
  await page.getByRole("button", { name: "Abort running task" }).click();
});

test.describe("touch narrow workbench", () => {
  test.use({ hasTouch: true, isMobile: true });

  test("keeps control hit areas separate and honors simulated safe edges", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await pairedPage(page);
    await page.evaluate(() => {
      const root = document.documentElement.style;
      root.setProperty("--safe-top", "24px");
      root.setProperty("--safe-right", "20px");
      root.setProperty("--safe-bottom", "16px");
      root.setProperty("--safe-left", "18px");
    });
    await page.getByRole("button", { name: "Toggle navigation" }).click();
    await openMockSession(page, /Formula rendering and spectral analysis/);

    const layout = await page.evaluate(() => {
      const box = (element: Element) => {
        const rect = (element as HTMLElement).getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      };
      const overlaps = (
        left: ReturnType<typeof box>,
        right: ReturnType<typeof box>,
      ) =>
        left.x < right.x + right.width &&
        left.x + left.width > right.x &&
        left.y < right.y + right.height &&
        left.y + left.height > right.y;
      const topbarButtons = [
        ...document.querySelectorAll(".topbar .icon-button"),
      ].map(box);
      const composerButtons = [
        ...document.querySelectorAll(
          ".composer__meta .icon-button, .composer__send",
        ),
      ].map(box);
      const topbar = getComputedStyle(document.querySelector(".topbar")!);
      const dock = getComputedStyle(document.querySelector(".composer-dock")!);
      return {
        composerButtons,
        composerButtonsOverlap: composerButtons.some((button, index) =>
          composerButtons
            .slice(index + 1)
            .some((other) => overlaps(button, other)),
        ),
        documentOverflow:
          document.documentElement.scrollWidth -
          document.documentElement.clientWidth,
        dockPaddingLeft: Number.parseFloat(dock.paddingLeft),
        dockPaddingRight: Number.parseFloat(dock.paddingRight),
        topbarButtons,
        topbarButtonsOverlap: topbarButtons.some((button, index) =>
          topbarButtons
            .slice(index + 1)
            .some((other) => overlaps(button, other)),
        ),
        topbarPaddingLeft: Number.parseFloat(topbar.paddingLeft),
        topbarPaddingRight: Number.parseFloat(topbar.paddingRight),
        topbarPaddingTop: Number.parseFloat(topbar.paddingTop),
      };
    });

    expect(layout.documentOverflow).toBeLessThanOrEqual(1);
    expect(layout.topbarPaddingTop).toBeGreaterThanOrEqual(24);
    expect(layout.topbarPaddingLeft).toBeGreaterThanOrEqual(18);
    expect(layout.topbarPaddingRight).toBeGreaterThanOrEqual(20);
    expect(layout.dockPaddingLeft).toBeGreaterThanOrEqual(18);
    expect(layout.dockPaddingRight).toBeGreaterThanOrEqual(20);
    expect(layout.topbarButtons).toHaveLength(4);
    expect(
      layout.topbarButtons.every(
        (button) => button.width >= 36 && button.height >= 36,
      ),
    ).toBe(true);
    expect(layout.topbarButtonsOverlap).toBe(false);
    expect(
      layout.composerButtons.every(
        (button) => button.width >= 36 && button.height >= 36,
      ),
    ).toBe(true);
    expect(layout.composerButtonsOverlap).toBe(false);
  });
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
  const restingStep = (await previous.isEnabled()) ? previous : next;
  await expect
    .poll(() =>
      restingStep.evaluate((element) => getComputedStyle(element).opacity),
    )
    .toBe("0.28");
  await page.getByRole("button", { name: "Open prompt map" }).hover();
  await expect(page.locator(".prompt-map__list")).toBeVisible();
  expect(
    await restingStep.evaluate((element) => getComputedStyle(element).opacity),
  ).toBe("0.28");
  await page.locator(".topbar__title").hover();
  await expect(page.locator(".prompt-map__list")).toBeHidden();
  await page.getByRole("button", { name: "Open prompt map" }).click();
  await expect(page.locator(".prompt-map__list")).toBeVisible();
  await expect
    .poll(async () => (await map.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(258);
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
  const disabledOpacity = Number(
    await previous.evaluate((element) => getComputedStyle(element).opacity),
  );
  const enabledOpacity = Number(
    await next.evaluate((element) => getComputedStyle(element).opacity),
  );
  expect(disabledOpacity).toBeLessThan(enabledOpacity);

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
  const mobileToolbar = page.locator(".transcript-mobile-toolbar");
  const searchLauncher = page.getByRole("button", {
    name: "Open conversation search",
  });
  const promptLauncher = page.getByRole("button", {
    name: "Open prompt navigation",
  });
  await expect(searchLauncher).toBeVisible();
  await expect(promptLauncher).toBeVisible();
  await expect(
    promptLauncher.locator(".lucide-gallery-horizontal-end"),
  ).toBeVisible();
  await expect
    .poll(() =>
      mobileToolbar
        .getByRole("button")
        .evaluateAll((buttons) =>
          buttons.map((button) => button.getAttribute("aria-label")),
        ),
    )
    .toEqual(["Open prompt navigation", "Open conversation search"]);
  const launcherBoxes = await Promise.all([
    searchLauncher.boundingBox(),
    promptLauncher.boundingBox(),
  ]);
  expect(
    launcherBoxes.every(
      (box) => box !== null && box.width >= 44 && box.height >= 44,
    ),
  ).toBe(true);
  const toolbarBox = await mobileToolbar.boundingBox();
  const transcriptBox = await transcript.boundingBox();
  expect((toolbarBox?.y ?? 0) + (toolbarBox?.height ?? 0)).toBeLessThanOrEqual(
    transcriptBox?.y ?? 0,
  );

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
  const compactBox = await map.boundingBox();
  expect(compactBox?.width).toBeGreaterThanOrEqual(340);
  expect(compactBox?.height).toBe(44);
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
  const mobileTicks = await map
    .locator("[data-prompt-ordinal]")
    .evaluateAll((elements) =>
      elements.map((element) => {
        const bounds = element.getBoundingClientRect();
        return { width: bounds.width, height: bounds.height };
      }),
    );
  expect(mobileTicks.every((tick) => tick.height > tick.width)).toBe(true);

  await page.getByRole("button", { name: "Open prompt map" }).click();
  await expect(list).toBeVisible();
  await expect
    .poll(async () => (await map.boundingBox())?.width ?? 0)
    .toBeGreaterThanOrEqual(360);
  const overflow = await page
    .locator("html")
    .evaluate((element) => element.scrollWidth - element.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
});
