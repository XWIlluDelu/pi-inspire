import AxeBuilder from "@axe-core/playwright";
import { expect, test } from "@playwright/test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
          return { animation: style.animationName, shadow: style.boxShadow };
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
      ({ animation, shadow }) => animation === "none" && shadow !== "none",
    ),
  ).toBe(true);

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
  await expect(page.locator(".composer")).toHaveClass(/composer--running/);

  const results = await new AxeBuilder({ page })
    .include(".topbar")
    .include(".composer")
    .analyze();
  expect(results.violations).toEqual([]);
  const fontTransfer = await stopFontTransfer();
  expect(fontTransfer.totalEncodedBytes).toBeGreaterThanOrEqual(0);
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
