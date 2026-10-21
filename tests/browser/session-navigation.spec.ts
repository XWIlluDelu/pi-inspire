import { hostRequest } from "./support/host-request";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "@playwright/test";
import {
  openCommandPalette,
  openMockSession,
  pairedPage,
} from "./support/navigation";

async function preserveCuration(page: Page) {
  const before = await (await hostRequest(page).get("/api/preferences")).json();
  return async () => {
    const restored = await hostRequest(page).patch("/api/preferences", {
      data: {
        pinnedSessionIds: before.pinnedSessionIds,
        hiddenSessionIds: before.hiddenSessionIds,
      },
    });
    expect(restored.ok()).toBe(true);
  };
}

test("session search paginates unloaded results and keyboard selection preserves drafts", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await pairedPage(page);
  const restoreCuration = await preserveCuration(page);
  try {
    await openMockSession(page, /Review extension event lifecycle/);
    const input = page.getByRole("textbox", { name: "Message", exact: true });
    await input.fill("SESSION_SEARCH_ACTIVE_DRAFT");
    await page.locator('input[type="file"]').setInputFiles({
      name: "search-draft.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("retain draft artifact"),
    });
    await expect(page.locator(".attachment--ready")).toBeVisible();
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    const first = page.getByRole("textbox", { name: "First message" });
    await first.fill("SESSION_SEARCH_START_DRAFT");
    const response = await hostRequest(page).get(
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
              : [
                  {
                    ...find("mock-active"),
                    id: "unloaded-catalog-result",
                    title: "Unloaded catalog result",
                  },
                  find("mock-errors"),
                ],
          total: 4,
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
    await expect(page.locator(".nav__row--highlighted")).toHaveCount(0);
    await search.press("Enter");
    await expect(first).toHaveValue("SESSION_SEARCH_START_DRAFT");
    await expect(page.locator(".nav__row--active")).toHaveCount(0);
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
    await expect(page.locator(".nav__row-name")).toHaveCount(4);
    await expect(
      page
        .locator(".nav__row-name")
        .filter({ hasText: "Unloaded catalog result" }),
    ).toBeVisible();
    await search.focus();
    await expect(highlighted).toHaveText("Review extension event lifecycle");
    await expect(
      page.getByRole("button", { name: "Load older sessions", exact: true }),
    ).toHaveCount(0);
    const a11y = await new AxeBuilder({ page }).include(".nav").analyze();
    expect(a11y.violations).toEqual([]);
    await search.press("Enter");
    await expect(input).toHaveValue("SESSION_SEARCH_ACTIVE_DRAFT");
    await expect(page.locator(".attachment")).toContainText("search-draft.txt");
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
    await search.focus();
    await expect(page.locator(".nav__row--highlighted")).toHaveCount(0);
    await search.press("Enter");
    await expect(page.locator(".topbar__title-button")).toHaveText(
      "Formula rendering and spectral analysis",
    );
    await page
      .getByRole("button", { name: "New session", exact: true })
      .click();
    await expect(first).toHaveValue("SESSION_SEARCH_START_DRAFT");
  } finally {
    await restoreCuration();
  }
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

test.describe("touch session drawer", () => {
  test.use({ viewport: { width: 320, height: 740 }, hasTouch: true });
  test("direct curation does not select a session; selection dismisses the drawer and restores its draft", async ({
    page,
  }) => {
    await pairedPage(page);
    const restoreCuration = await preserveCuration(page);
    try {
      await openMockSession(page, /Review extension event lifecycle/);
      const input = page.getByRole("textbox", { name: "Message", exact: true });
      await input.fill("Keep this touch draft");
      await page
        .getByRole("button", { name: "Toggle navigation", exact: true })
        .tap();
      const drawer = page.getByRole("dialog", {
        name: "Sessions",
        exact: true,
      });
      const title = "Review extension event lifecycle";
      const action = (name: string) =>
        drawer.getByRole("button", {
          name: name + ' "' + title + '"',
          exact: true,
        });
      await action("Pin").tap();
      await expect(drawer.locator(".nav__group--pinned")).toContainText(title);
      await action("Hide").tap();
      const hidden = drawer.locator(".nav__group--hidden");
      await hidden.getByRole("button", { name: "Hidden", exact: true }).tap();
      await expect(hidden).toContainText(title);
      await action("Restore").tap();
      await expect(drawer.locator(".nav__group--hidden")).toHaveCount(0);
      // Hiding clears the pin; restoring returns a regular session row.
      await expect(action("Pin")).toBeVisible();
      await expect(input).toHaveValue("Keep this touch draft");
      await drawer.locator(".nav__row-main").filter({ hasText: title }).tap();
      await expect(drawer).toHaveCount(0);
      await expect(input).toHaveValue("Keep this touch draft");
    } finally {
      await restoreCuration();
    }
  });
});
