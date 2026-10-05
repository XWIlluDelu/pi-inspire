import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test, type WebSocketRoute } from "@playwright/test";
import {
  customMessageConfiguration,
  incomingIntercom,
} from "../web/fixtures/custom-message-presentation";
import { browserWorkspace } from "./fixtures/workspace.mjs";

test.use({ serviceWorkers: "block" });

async function openReview(page: Page) {
  let socket: WebSocketRoute | undefined;
  let sessionId: string | null = null;
  await page.routeWebSocket(/\/events(?:\?|$)/, (client) => {
    socket = client;
    const server = client.connectToServer();
    server.onMessage((data) => {
      const event = JSON.parse(String(data));
      if (event.type === "snapshot")
        sessionId =
          event.detailSessionId ?? event.data?.active?.sessionId ?? null;
      client.send(data);
    });
  });
  await page.route("**/api/bootstrap", async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = await response.json();
    body.preferences = {
      ...body.preferences,
      theme: "light",
      palette: "amber",
      toolVisibility: "hidden",
      thinkingVisibility: "hidden",
      activityFoldVisibility: "collapsed",
    };
    body.toolPresentations = customMessageConfiguration;
    await route.fulfill({ response, json: body });
  });
  await page.goto("/");
  await page.getByLabel("Access token").fill("inspire-browser-test-token");
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await expect(page.getByRole("main")).toBeVisible();
  const created = await page.request.post("/api/sessions/new", {
    data: { cwd: browserWorkspace, name: "Custom message review" },
  });
  expect(created.ok()).toBe(true);
  sessionId = null;
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^Session actions:/ }),
  ).toHaveText("Custom message review");
  await expect.poll(() => sessionId).not.toBeNull();
  return (message: ReturnType<typeof incomingIntercom>) => {
    socket!.send(JSON.stringify({ type: "message_end", message, sessionId }));
  };
}

test("sender-led custom messages retain exact content, raw inspection, keyboard access and responsive geometry", async ({
  page,
  context,
}) => {
  test.setTimeout(90_000);
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const send = await openReview(page);
  const message = incomingIntercom();
  send(message);
  const card = page.getByRole("article", { name: "Inspire: composer editing" });
  await expect(
    card.getByRole("heading", { name: "Composer review ready" }),
  ).toBeVisible();
  await expect(card.locator(".custom-message__source")).toHaveText("Intercom");
  await expect(card.locator(".custom-message__body strong").last()).toHaveText(
    "final paragraph",
  );
  await expect(
    card.locator(
      ".custom-message__raw, .custom-message__type, time, .card__status",
    ),
  ).toHaveCount(0);
  for (const hidden of [
    "intercom_message",
    "To reply",
    "/home/reviewer",
    "seq 42",
    "2030-",
    "broker",
    "injected",
  ])
    await expect(card).not.toContainText(hidden);

  for (const palette of ["amber", "teal"]) {
    for (const theme of ["light", "dark"]) {
      await page.evaluate(
        ({ palette, theme }) => {
          document.documentElement.dataset.palette = palette;
          document.documentElement.dataset.theme = theme;
        },
        { palette, theme },
      );
      for (const width of [1280, 390, 320]) {
        await page.setViewportSize({ width, height: 1000 });
        await card.scrollIntoViewIfNeeded();
        const geometry = await card.evaluate((element) => {
          const title = element
            .querySelector(".custom-message__title")!
            .getBoundingClientRect();
          const body = element
            .querySelector(".custom-message__body")!
            .getBoundingClientRect();
          const details = element
            .querySelector("summary")!
            .getBoundingClientRect();
          const identity = element.querySelector(".custom-message__identity")!;
          const identityBox = identity.getBoundingClientRect();
          const copy = element
            .querySelector(".custom-message__copy")!
            .getBoundingClientRect();
          return {
            overflow: element.scrollWidth - element.clientWidth,
            transcriptOverflow:
              element.closest(".transcript")!.scrollWidth -
              element.closest(".transcript")!.clientWidth,
            titleLeft: title.left,
            bodyLeft: body.left,
            detailsLeft: details.left,
            identityRight: identityBox.right,
            copyLeft: copy.left,
            alignment: getComputedStyle(identity).alignItems,
            shortWordLines: Array.from(element.querySelectorAll("th, td"))
              .filter((cell) =>
                ["Surface", "Desktop"].includes(cell.textContent ?? ""),
              )
              .map((cell) => {
                const range = document.createRange();
                range.selectNodeContents(cell);
                return range.getClientRects().length;
              }),
          };
        });
        expect(geometry.overflow).toBeLessThanOrEqual(1);
        expect(geometry.transcriptOverflow).toBeLessThanOrEqual(1);
        expect(geometry.titleLeft).toBeCloseTo(geometry.bodyLeft, 0);
        expect(geometry.bodyLeft).toBeCloseTo(geometry.detailsLeft, 0);
        expect(geometry.identityRight).toBeLessThan(geometry.copyLeft);
        expect(geometry.alignment).toBe("baseline");
        expect(geometry.shortWordLines).toEqual([1, 1]);
        const summary = card.locator("summary");
        await summary.focus();
        await expect(summary).toBeFocused();
        expect(
          await summary.evaluate(
            (element) => getComputedStyle(element).outlineStyle,
          ),
        ).toBe("solid");
        await summary.press("Enter");
        await expect(card.locator("details")).toHaveAttribute("open", "");
        const raw = await card.locator(".custom-message__raw").textContent();
        expect(JSON.parse(raw!)).toEqual({
          customType: message.customType,
          content: message.content,
          details: message.details,
        });
        await summary.press("Space");
        await expect(card.locator(".custom-message__raw")).toHaveCount(0);
        expect(
          (await new AxeBuilder({ page }).include(".custom-message").analyze())
            .violations,
        ).toEqual([]);
        await summary.evaluate((element: HTMLElement) => element.blur());
        const jump = page.getByRole("button", {
          name: "Jump to latest",
          exact: true,
        });
        if (await jump.isVisible()) await jump.click();
        await expect(jump).not.toBeVisible();
        await card.screenshot({
          path: `output/playwright/intercom-card-${palette}-${theme}-${width}.png`,
        });
      }
    }
  }

  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  const copy = card.getByRole("button", {
    name: "Copy inspire: composer editing block",
  });
  await copy.focus();
  await copy.press("Enter");
  await expect(
    card.getByRole("button", {
      name: "Inspire: composer editing block copied",
    }),
  ).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied.replace(/\r\n/g, "\n")).toContain(
    String(message.content).replace(/\r\n/g, "\n"),
  );
  expect(copied.replace(/\r\n/g, "\n")).toContain(
    JSON.stringify(message.details, null, 2),
  );

  // Unbroken titles reflow rather than colliding with Copy or losing attribution.
  const longMessage = incomingIntercom("The full body is still here.");
  (longMessage.details as { from: { name: string } }).from.name =
    "sender_with_a_very_long_unbroken_name_".repeat(5);
  longMessage.__inspireMessageId = "custom-message-long-sender";
  send(longMessage);
  const longCard = page.getByRole("article", {
    name: "sender_with_a_very_long_unbroken_name_".repeat(5),
  });
  await expect(longCard).toContainText("The full body is still here.");
  const wrappedHeader = await longCard.evaluate((element) => {
    const header = element
      .querySelector(".custom-message__head")!
      .getBoundingClientRect();
    const icon = element
      .querySelector(".custom-message__head > svg")!
      .getBoundingClientRect();
    const copy = element
      .querySelector(".custom-message__copy")!
      .getBoundingClientRect();
    return {
      fits: element.scrollWidth <= element.clientWidth + 1,
      headerHeight: header.height,
      copyHeight: copy.height,
      iconCenter: icon.y + icon.height / 2,
      copyCenter: copy.y + copy.height / 2,
      headerCenter: header.y + header.height / 2,
    };
  });
  expect(wrappedHeader.fits).toBe(true);
  expect(wrappedHeader.headerHeight).toBeGreaterThan(wrappedHeader.copyHeight);
  expect(wrappedHeader.iconCenter).toBeCloseTo(wrappedHeader.headerCenter, 1);
  expect(wrappedHeader.copyCenter).toBeCloseTo(wrappedHeader.headerCenter, 1);
  await longCard.screenshot({
    path: "output/playwright/intercom-card-long-sender-320.png",
  });
  expect(errors).toEqual([]);
});

test("Markdown tables preserve word minima and keep long tokens in their own scrollport", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  const send = await openReview(page);
  const token = "AnUnbrokenTableToken".repeat(20);
  send(
    incomingIntercom(
      `| Surface | Result |\n| --- | --- |\n| Desktop | ${token} |\n\nOutside table: ${token}`,
    ),
  );
  const card = page.getByRole("article", { name: "Inspire: composer editing" });
  const table = card.locator("table");
  await expect(table).toContainText(token);
  const geometry = await table.evaluate((element) => ({
    width: element.clientWidth,
    scroll: element.scrollWidth,
    wrap: getComputedStyle(element).overflowWrap,
    tokenLines: (() => {
      const range = document.createRange();
      range.selectNodeContents(element.querySelector("tbody td:last-child")!);
      return range.getClientRects().length;
    })(),
  }));
  expect(geometry.scroll).toBeGreaterThan(geometry.width);
  expect(geometry.wrap).toBe("normal");
  expect(geometry.tokenLines).toBe(1);
  const paragraph = card.locator(".rich-text p");
  await expect(paragraph).toContainText(token);
  expect(
    await paragraph.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
  expect(
    await card.evaluate(
      (element) => element.scrollWidth <= element.clientWidth + 1,
    ),
  ).toBe(true);
});

test.describe("touch custom messages", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });
  test("keeps real Copy and Details targets operable without overlapping content", async ({
    page,
  }) => {
    const send = await openReview(page);
    send(incomingIntercom());
    const card = page.getByRole("article", {
      name: "Inspire: composer editing",
    });
    const copy = card.getByRole("button", {
      name: "Copy inspire: composer editing block",
    });
    await expect(copy).toBeVisible();
    const copyBox = (await copy.boundingBox())!;
    expect(copyBox.width).toBeGreaterThanOrEqual(44);
    expect(copyBox.height).toBeGreaterThanOrEqual(44);
    const summary = card.locator("summary");
    const summaryBox = (await summary.boundingBox())!;
    expect(summaryBox.height).toBeGreaterThanOrEqual(44);
    await summary.tap();
    await expect(card.locator("details")).toHaveAttribute("open", "");
    await expect(card.locator(".custom-message__raw")).toContainText(
      "replyCommand",
    );
    await summary.tap();
    await expect(card.locator(".custom-message__raw")).toHaveCount(0);
    expect(
      await card.evaluate(
        (element) => element.scrollWidth <= element.clientWidth + 1,
      ),
    ).toBe(true);
  });
});
