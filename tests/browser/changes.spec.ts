import { expect, test } from "@playwright/test";

// Files and Changes share the contextual navigation and reading surface.
import { openMockSession, pairedPage } from "./support/navigation";

test("change navigation preserves addition and deletion colors", async ({
  page,
}) => {
  await pairedPage(page);
  await openMockSession(page, /Resource virtualization and sandbox fixture/);
  await page.getByRole("button", { name: "Toggle resources panel" }).click();
  const pane = page.locator(".ctx");
  await pane.getByRole("button", { name: "Changes", exact: true }).click();
  await pane
    .getByRole("button", { name: /page\.html, unstaged modified/ })
    .click();

  const lines = pane.locator(
    ".source-diff__line--add, .source-diff__line--delete",
  );
  await expect(lines).toHaveCount(2);
  const backgrounds = () =>
    lines.evaluateAll((rows) =>
      rows.map((row) => getComputedStyle(row).backgroundColor),
    );
  const unselected = await backgrounds();
  expect(unselected[0]).not.toBe(unselected[1]);

  await pane.getByRole("button", { name: "Next change", exact: true }).click();
  await expect(pane.locator(".source-diff__line--active")).toHaveCount(2);
  expect(await backgrounds()).toEqual(unselected);
  expect(
    await lines.first().evaluate((row) => getComputedStyle(row).boxShadow),
  ).not.toBe("none");
});

for (const touch of [false, true]) {
  test.describe(`${touch ? "touch" : "desktop"} source navigation`, () => {
    test.use({
      viewport: touch
        ? { width: 390, height: 844 }
        : { width: 1280, height: 900 },
      hasTouch: touch,
    });
    test("aligns tree siblings and retains diff reading after first-change landing", async ({
      page,
    }) => {
      await pairedPage(page);
      const navigation = page.getByRole("button", {
        name: "Toggle navigation",
        exact: true,
      });
      if ((await navigation.getAttribute("aria-expanded")) === "false")
        await navigation.click();
      await openMockSession(
        page,
        /Resource virtualization and sandbox fixture/,
      );
      const toggle = page.getByRole("button", {
        name: "Toggle resources panel",
      });
      if ((await toggle.getAttribute("aria-expanded")) === "false")
        await toggle.click();
      const pane = page.locator(".ctx");
      await pane.getByRole("button", { name: "Files", exact: true }).click();
      const tree = pane.getByRole("region", { name: "Workspace file tree" });
      const file = tree
        .locator('.workspace-tree__row--file[style="padding-left: 8px;"]')
        .first();
      const folder = tree
        .locator('.workspace-tree__row--folder[style="padding-left: 8px;"]')
        .first();
      await expect(file).toBeVisible();
      const nameX = (row: typeof file) =>
        row
          .locator(".workspace-tree__name")
          .evaluate((node) => node.getBoundingClientRect().x);
      expect(await nameX(file)).toBe(await nameX(folder));

      await pane.getByRole("button", { name: "Changes", exact: true }).click();
      await pane
        .getByRole("button", { name: /page\.html, unstaged modified/ })
        .click();
      const source = pane.locator(".source-diff");
      const first = source.locator('[data-change-index="0"]');
      await expect(first).toBeInViewport();
      expect(await source.evaluate((node) => node.scrollTop)).toBeGreaterThan(
        0,
      );

      await source.evaluate((node) => {
        node.scrollTop = 800;
        node.scrollLeft = 50;
        node.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      const position = () =>
        source.evaluate((node) => [node.scrollTop, node.scrollLeft]);
      const saved = await position();
      const refreshed = page.waitForResponse(
        (response) => new URL(response.url()).pathname === "/api/git/diff",
      );
      await pane.getByRole("button", { name: "Refresh context pane" }).click();
      await refreshed;
      await expect.poll(position).toEqual(saved);
      await pane.getByRole("button", { name: "Files", exact: true }).click();
      await pane.getByRole("button", { name: "Changes", exact: true }).click();
      await expect.poll(position).toEqual(saved);
      await pane
        .getByRole("button", { name: "Next change", exact: true })
        .click();
      await expect(first).toBeInViewport();
      await expect(pane.locator(".source-diff__line--active")).toHaveCount(2);
    });
  });
}
