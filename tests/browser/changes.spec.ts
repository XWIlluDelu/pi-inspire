import { expect, test } from "@playwright/test";
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
