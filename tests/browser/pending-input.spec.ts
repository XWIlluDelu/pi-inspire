import { readFile } from "node:fs/promises";
import { expect, type Page, test } from "@playwright/test";
import type { UploadedAttachment } from "../../shared/contracts";
import { pendingTextSummary } from "../../shared/pending-preview";

const token = "inspire-browser-test-token";
const pixel = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

async function openPendingSession(page: Page) {
  await page.goto("/");
  await page.getByLabel("Access token").fill(token);
  await page.getByRole("button", { name: "Pair", exact: true }).click();
  await page
    .locator(".nav__row-main")
    .filter({ hasText: /Formula rendering and spectral analysis/ })
    .click();
  const composer = page.getByRole("form", { name: "Message composer" });
  const input = composer.getByRole("textbox", { name: "Message", exact: true });
  const pending = page.getByRole("region", { name: "Pending input" });
  await expect(input).toBeVisible();
  return { composer, input, pending };
}

test("Pending image thumbnails open the shared viewer and wrap at narrow widths", async ({
  page,
  request,
}) => {
  const bytes = await readFile(
    "tests/browser/fixtures/file-previews/training curve.png",
  );
  const attachments: UploadedAttachment[] = [];
  for (let index = 0; index < 5; index++) {
    const response = await request.post("/api/attachments", {
      headers: { Authorization: `Bearer ${token}` },
      multipart: {
        files: {
          name: `pending-${index}.png`,
          mimeType: "image/png",
          buffer: bytes,
        },
      },
    });
    expect(response.status()).toBe(200);
    attachments.push((await response.json()).attachments[0]);
  }
  // Mock Pi has no image owner. Supply its known-handle projection only;
  // thumbnail bytes still come from the isolated Host's real attachment route.
  const pendingProjection = {
    revision: 1,
    totalCount: 3,
    steering: [
      {
        id: "thumbnail-caption",
        ...pendingTextSummary("Compare these charts"),
        imageCount: 4,
        imageAttachmentIds: attachments.slice(0, 4).map((item) => item.id),
      },
      {
        id: "thumbnail-image-only",
        ...pendingTextSummary(""),
        imageCount: 1,
        imageAttachmentIds: [attachments[4]!.id],
      },
      { id: "thumbnail-unknown", ...pendingTextSummary("") },
    ],
    followUp: [],
  };
  await page.route("**/api/sessions/open", async (route) => {
    const response = await route.fetch();
    await route.fulfill({
      response,
      json: { ...(await response.json()), pendingQueues: pendingProjection },
    });
  });
  await page.routeWebSocket("**/events**", (socket) => {
    const server = socket.connectToServer();
    server.onMessage((message) => {
      const frame = JSON.parse(String(message));
      if (frame.type === "snapshot" && frame.data?.active)
        frame.data.pendingQueues = pendingProjection;
      socket.send(JSON.stringify(frame));
    });
  });
  try {
    const { pending } = await openPendingSession(page);
    const images = pending.locator(".pending-group__image img");
    await expect(images).toHaveCount(5);
    await expect
      .poll(() =>
        images.evaluateAll((values) =>
          values.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
      )
      .toBe(true);
    const rows = pending.getByRole("listitem");
    await expect(rows.nth(0)).toContainText("Compare these charts");
    await expect(rows.nth(1).locator("pre")).toHaveCount(0);
    await expect(rows.nth(2)).toContainText("No text");
    await page.screenshot({
      path: "output/playwright/pending-thumbnails/desktop.png",
      animations: "disabled",
    });
    const preview = pending.getByRole("button", {
      name: "Preview Pending steer item 1 image 1",
    });
    await preview.focus();
    await page.keyboard.press("Enter");
    const viewer = page.getByRole("dialog", { name: "Image preview" });
    await expect(viewer).toBeVisible();
    await page.screenshot({
      path: "output/playwright/pending-thumbnails/viewer.png",
      animations: "disabled",
    });
    await viewer.getByRole("button", { name: "Zoom image" }).click();
    await expect(
      viewer.getByRole("button", { name: "Fit image to window" }),
    ).toHaveAttribute("aria-pressed", "true");
    await viewer.getByRole("button", { name: "White", exact: true }).click();
    await expect(viewer.locator("img")).toHaveAttribute(
      "data-background",
      "white",
    );
    await page.keyboard.press("Escape");
    await expect(viewer).toHaveCount(0);
    await expect(preview).toBeFocused();
    await expect(rows).toHaveCount(3);
    await page.setViewportSize({ width: 320, height: 720 });
    await preview.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
    const boxes = await pending
      .locator(".pending-group__image")
      .evaluateAll((buttons) =>
        buttons.map((button) => {
          const box = button.getBoundingClientRect();
          return {
            width: box.width,
            height: box.height,
            right: box.right,
            top: box.top,
          };
        }),
      );
    expect(
      boxes.every(
        (box) => box.width === 44 && box.height === 44 && box.right <= 320,
      ),
    ).toBe(true);
    expect(boxes[3]!.top).toBeGreaterThan(boxes[0]!.top);
    await page.screenshot({
      path: "output/playwright/pending-thumbnails/narrow.png",
      animations: "disabled",
    });
  } finally {
    for (const item of attachments)
      await request.delete(`/api/attachments/${item.id}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
  }
});

test("Pending Clear all keeps its explicit two-step confirmation and leaves the draft", async ({
  page,
}) => {
  const { composer, input, pending } = await openPendingSession(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await input.fill(`long running prompt ${"x".repeat(260)}`);
  await composer.getByRole("button", { name: "Send message" }).click();
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();

  const delivery = await composer
    .locator(".composer__delivery")
    .evaluate((row) => {
      const box = row.getBoundingClientRect();
      const group = row.querySelector(".segmented")!.getBoundingClientRect();
      const buttons = [...row.querySelectorAll("button")].map((button) => {
        const { width, height } = button.getBoundingClientRect();
        return { width, height };
      });
      return { rowWidth: box.width, groupWidth: group.width, buttons };
    });
  expect(delivery.groupWidth).toBeCloseTo(delivery.rowWidth, 0);
  expect(delivery.buttons[0]!.width).toBeCloseTo(delivery.buttons[1]!.width, 0);
  expect(delivery.buttons.every(({ height }) => height >= 34)).toBe(true);
  await composer.screenshot({
    path: "output/playwright/pending-thumbnails/mobile-delivery.png",
    animations: "disabled",
  });

  await input.fill("first pending instruction");
  await composer.getByRole("button", { name: "Send as steer" }).click();
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
  await input.fill("draft that must survive Clear all");
  await pending
    .getByRole("button", { name: "Clear all Pending input" })
    .click();
  await expect(pending).toContainText("Clear all?");
  await expect(pending.getByRole("listitem")).toHaveCount(2);
  await pending
    .getByRole("button", { name: "Cancel clearing Pending input" })
    .click();
  await expect(
    pending.getByRole("button", { name: "Clear all", exact: true }),
  ).toHaveCount(0);
  await pending
    .getByRole("button", { name: "Clear all Pending input" })
    .click();
  await pending.getByRole("button", { name: "Clear all", exact: true }).click();
  await expect(pending).toHaveCount(0);
  await expect(input).toHaveValue("draft that must survive Clear all");
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();
  await composer.getByRole("button", { name: "Abort running task" }).click();
});

test("Pending copies complete text and returns mixed input; Stop and Escape restore drafts", async ({
  page,
  context,
}) => {
  const { composer, input, pending } = await openPendingSession(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  const start = async () => {
    await input.fill(`long running prompt ${"x".repeat(260)}`);
    await composer.getByRole("button", { name: "Send message" }).click();
    await expect(
      composer.getByRole("button", { name: "Abort running task" }),
    ).toBeVisible();
  };
  await start();
  const longText = `${"pending long text ".repeat(100)}EXACT_END`;
  await input.fill(longText);
  await composer.getByRole("button", { name: "Send as steer" }).click();
  await composer.getByRole("button", { name: "Queue", exact: true }).click();
  await input.fill("follow-up text");
  await composer
    .getByRole("button", { name: "Queue after current task" })
    .click();
  await expect(pending.getByRole("listitem")).toHaveCount(2);
  await expect(pending).toContainText("EXACT_END");
  await pending.getByRole("button", { name: "Copy all pending input" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`1. ${longText}\n2. follow-up text`);
  await expect(pending.getByRole("listitem")).toHaveCount(2);
  await input.fill("existing draft");
  await pending
    .getByRole("button", { name: "Return all Pending input to composer" })
    .click();
  await expect(input).toHaveValue(
    `${longText}\n\nfollow-up text\n\nexisting draft`,
  );
  await expect(pending).toHaveCount(0);
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();
  // The editable merged draft resends through the currently selected Queue mode.
  await composer
    .getByRole("button", { name: "Queue after current task" })
    .click();
  await expect(
    page.getByRole("region", { name: "Pending queue" }),
  ).toBeVisible();
  await input.fill("typed before Stop");
  await composer.getByRole("button", { name: "Abort running task" }).click();
  await expect(input).toHaveValue(
    `${longText}\n\nfollow-up text\n\nexisting draft\n\ntyped before Stop`,
  );
  await expect(pending).toHaveCount(0);
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toHaveCount(0);
  await start();
  await input.fill("Escape pending");
  await composer.getByRole("button", { name: "Send as steer" }).click();
  await expect(pending).toContainText("Escape pending");
  await input.fill("Escape draft");
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await expect(pending).toContainText("Escape pending");
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();
  await input.focus();
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("Escape pending\n\nEscape draft");
  await expect(pending).toHaveCount(0);
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toHaveCount(0);
});

for (const action of ["Return all", "Escape"] as const) {
  test(`Pending images ${action}: thumbnails, newest draft, removal and resend`, async ({
    page,
  }) => {
    const { composer, input, pending } = await openPendingSession(page);
    const boot = await (await page.request.get("/api/bootstrap")).json();
    const uploads = new Map<string, UploadedAttachment>();
    let queued: Array<{
      mode: "steer" | "followUp";
      images: UploadedAttachment[];
    }> = [];
    let lastSent: {
      message: string;
      attachmentIds?: string[];
      behavior?: string;
    } | null = null;
    await page.route("**/api/prompt", async (route) => {
      const body = route.request().postDataJSON();
      lastSent = body;
      if (body.behavior)
        queued.push({
          mode: body.behavior,
          images: (body.attachmentIds ?? []).map(
            (id: string) => uploads.get(id)!,
          ),
        });
      await route.continue();
    });
    // Mock Pi owns text queue behavior; augment only its receipt with real,
    // isolated staged upload handles. Thumbnail GET/removal use the actual Host.
    await page.route("**/api/pending/recover", async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      const attachments = [
        ...queued.filter((item) => item.mode === "steer"),
        ...queued.filter((item) => item.mode === "followUp"),
      ].flatMap((item) => item.images);
      queued = [];
      await route.fulfill({
        response,
        json: {
          ...body,
          ...(attachments.length
            ? { attachments, authorityId: boot.authorityId }
            : {}),
        },
      });
    });
    const addImage = async (name: string) => {
      const uploaded = page.waitForResponse(
        (response) =>
          response.url().endsWith("/api/attachments") &&
          response.status() === 200,
      );
      await composer
        .locator('input[type="file"]')
        .setInputFiles({ name, mimeType: "image/gif", buffer: pixel });
      const value: UploadedAttachment = (await (await uploaded).json())
        .attachments[0];
      uploads.set(value.id, value);
      await expect(composer.locator(".attachment--ready")).toHaveCount(1);
      return value;
    };
    await input.fill(`Keep the mock stream active ${"x".repeat(2000)}`);
    await composer
      .getByRole("button", { name: "Send message", exact: true })
      .click();
    await expect(
      composer.getByRole("button", { name: "Abort running task" }),
    ).toBeVisible();
    const first = await addImage("pending-first.gif");
    await input.fill(action === "Escape" ? "" : "first caption");
    await composer.getByRole("button", { name: "Send as steer" }).click();
    await expect(pending.getByRole("listitem")).toHaveCount(1);
    let second: UploadedAttachment | null = null;
    if (action === "Return all") {
      second = await addImage("pending-second.gif");
      await composer
        .getByRole("button", { name: "Queue", exact: true })
        .click();
      await input.fill("second caption");
      await composer
        .getByRole("button", { name: "Queue after current task" })
        .click();
      await expect(pending.getByRole("listitem")).toHaveCount(2);
    }
    const draftImage = await addImage("newest-draft.gif");
    await input.fill("newest draft");
    if (action === "Return all")
      await pending
        .getByRole("button", { name: "Return all Pending input to composer" })
        .click();
    else {
      await input.focus();
      await input.press("Escape");
    }
    await expect(input).toHaveValue(
      action === "Return all"
        ? "first caption\n\nsecond caption\n\nnewest draft"
        : "newest draft",
    );
    await expect(input).toBeFocused();
    const count = second ? 3 : 2;
    await expect(composer.locator(".attachment--image")).toHaveCount(count);
    await expect
      .poll(() =>
        composer
          .locator(".attachment--image img")
          .evaluateAll(
            (images) =>
              images.filter(
                (image) =>
                  (image as HTMLImageElement).complete &&
                  (image as HTMLImageElement).naturalWidth > 0,
              ).length,
          ),
      )
      .toBe(count);
    await page.screenshot({
      path: `output/playwright/pending-images-${action === "Return all" ? "return" : "escape"}.png`,
    });
    await composer
      .getByRole("button", { name: "Remove attached image" })
      .last()
      .click();
    await expect(composer.locator(".attachment--image")).toHaveCount(count - 1);
    const withdrawn = await page.request.get(
      `/api/attachments/${draftImage.id}/image`,
    );
    expect(withdrawn.status()).toBe(404);
    await composer
      .getByRole("button", {
        name:
          action === "Return all" ? "Queue after current task" : "Send message",
        exact: true,
      })
      .click();
    await expect
      .poll(() => lastSent?.attachmentIds)
      .toEqual(second ? [first.id, second.id] : [first.id]);
    if (action === "Return all") {
      await expect(pending.getByRole("listitem")).toHaveCount(1);
      await composer
        .getByRole("button", { name: "Abort running task" })
        .click();
      await expect(composer.locator(".attachment--image")).toHaveCount(2);
    }
    // The Escape case restarts after abort; stop the isolated mock before exit.
    if (action === "Escape")
      await composer
        .getByRole("button", { name: "Abort running task" })
        .click();
  });
}

test("Pending text preserves visible head and tail while copying and returning the full input", async ({
  page,
  context,
}) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  const { composer, input, pending } = await openPendingSession(page);
  await input.fill(`Keep mock work running ${"x".repeat(2000)}`);
  await composer
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();
  const text = [
    "Review the pending input presentation",
    "Keep the opening requirements",
    "Use the existing styling",
    ...Array.from(
      { length: 20 },
      (_, index) => `Middle detail ${index}: ${"x".repeat(40)}`,
    ),
    "Final requirement: preserve this last line.",
  ].join("\n");
  await input.fill(text);
  await composer.getByRole("button", { name: "Send as steer" }).click();
  await expect(pending).toContainText("Review the pending input presentation");
  await expect(pending).toContainText(
    "Final requirement: preserve this last line.",
  );
  await expect(pending).toContainText("…");
  await expect(pending).not.toContainText("Middle detail 10");
  await expect(pending).not.toContainText("Display previews only");
  await page.screenshot({
    path: "output/playwright/pending-head-tail.png",
    animations: "disabled",
  });
  await pending
    .getByRole("button", { name: "Copy steer item 1", exact: true })
    .click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(text);
  await pending
    .getByRole("button", { name: "Return all Pending input to composer" })
    .click();
  await expect(input).toHaveValue(text);
  await expect(pending).toHaveCount(0);
  await composer.getByRole("button", { name: "Abort running task" }).click();
});
