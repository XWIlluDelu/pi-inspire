import { readFile } from "node:fs/promises";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { UploadedAttachment } from "../../shared/contracts";
import { pendingTextSummary } from "../../shared/pending-preview";
import { clipboardLines } from "./support/clipboard";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import {
  openFixtureSession,
  openSettings,
  pairedPage,
} from "./support/navigation";

const token = "inspire-browser-test-token";
const pixel = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

async function openPendingSession(page: Page) {
  await pairedPage(page);
  await openFixtureSession(
    page,
    /Formula rendering and spectral analysis/,
    "fixture-active",
  );
  const composer = page.getByRole("form", { name: "Message composer" });
  const input = composer.getByRole("textbox", { name: "Message", exact: true });
  const pending = page.getByRole("region", { name: "Pending input" });
  await expect(input).toBeVisible();
  return { composer, input, pending };
}

async function startRun({
  composer,
  input,
}: {
  composer: Locator;
  input: Locator;
}) {
  await input.fill(`Keep the offline stream active ${"x".repeat(2_000)}`);
  await composer
    .getByRole("button", { name: "Send message", exact: true })
    .click();
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();
}

async function addImage(composer: Locator, name: string) {
  const uploaded = composer
    .page()
    .waitForResponse(
      (response) =>
        response.url().endsWith("/api/attachments") && response.ok(),
    );
  await composer
    .locator('input[type="file"]')
    .setInputFiles({ name, mimeType: "image/gif", buffer: pixel });
  const value: UploadedAttachment = (await (await uploaded).json())
    .attachments[0];
  await expect(composer.locator(".attachment--ready")).toHaveCount(1);
  return value;
}

test("Pending navigation keeps latest truthful in ordinary and virtualized conversations", async ({
  page,
}) => {
  let virtualized = false;
  const queue = {
    revision: 1,
    totalCount: 1,
    steering: [
      {
        id: "pending-boundary",
        ...pendingTextSummary("Review the pending changes"),
      },
    ],
    followUp: [],
  };
  await routeSnapshots(page, {
    snapshot(snapshot) {
      if (!snapshot.active) return;
      snapshot.pendingQueues = queue;
      if (virtualized) {
        snapshot.active.transcriptPage.messages = Array.from(
          { length: 90 },
          (_, index) => ({
            role: index % 2 ? "assistant" : "user",
            content: `Reading turn ${index + 1}\n\n${"A complete conversation remains readable. ".repeat(8)}`,
            timestamp: index + 1,
            __inspireMessageId: `boundary-${index}`,
          }),
        );
      }
    },
  });
  await openPendingSession(page);
  const log = page.getByRole("log");
  const latest = page.getByRole("button", { name: "Jump to latest" });
  const pending = page.getByRole("region", { name: "Pending input" });
  const trigger = page.getByRole("button", { name: "Jump to 1 pending item" });
  const remaining = () =>
    log.evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
  for (const long of [false, true]) {
    virtualized = long;
    if (long) {
      await page.reload();
      await expect(page.locator(".transcript__column--virtual")).toBeVisible();
    }
    await page.setViewportSize(
      long ? { width: 390, height: 844 } : { width: 1440, height: 960 },
    );
    await trigger.click();
    await expect(pending).toBeFocused();
    await expect.poll(remaining).toBeLessThanOrEqual(1);
    await expect(latest).toBeHidden();
    const alignment = await page.evaluate(() => {
      const activity = document
        .querySelector(".activity")!
        .getBoundingClientRect();
      const composer = document
        .querySelector(".composer")!
        .getBoundingClientRect();
      return {
        difference: Math.abs(activity.left - composer.left),
        width: activity.width - composer.width,
      };
    });
    expect(alignment.difference).toBeLessThanOrEqual(1);
    expect(Math.abs(alignment.width)).toBeLessThanOrEqual(1);
    await log.hover();
    await page.mouse.wheel(0, -500);
    await expect(latest).toBeVisible();
    await latest.click();
    await expect.poll(remaining).toBeLessThanOrEqual(1);
    await expect(latest).toBeHidden();
    await expect(pending).toBeInViewport();
  }
});

test("Pending image thumbnails open the shared viewer and wrap at narrow widths", async ({
  page,
  context,
  request,
}) => {
  const bytes = await readFile(
    "tests/browser/fixtures/file-previews/training curve.png",
  );
  const attachments: UploadedAttachment[] = [];
  for (let index = 0; index < 6; index++) {
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
        imageCount: 5,
        imageAttachmentIds: attachments.slice(0, 5).map((item) => item.id),
      },
      {
        id: "thumbnail-image-only",
        ...pendingTextSummary(""),
        imageCount: 1,
        imageAttachmentIds: [attachments[5]!.id],
      },
      { id: "thumbnail-unknown", ...pendingTextSummary("") },
    ],
    followUp: [],
  };
  const transport = await routeSnapshots(page, {
    snapshot: (value) => {
      if (value.active) value.pendingQueues = pendingProjection;
    },
  });
  try {
    const { pending } = await openPendingSession(page);
    const images = pending.locator(".pending-group__image img");
    await expect(images).toHaveCount(6);
    await expect
      .poll(() =>
        images.evaluateAll((values) =>
          values.every((image) => (image as HTMLImageElement).naturalWidth > 0),
        ),
      )
      .toBe(true);
    const rows = pending.getByRole("listitem");
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.route("**/api/pending/text", (route) =>
      route.fulfill({
        json: { text: "", imageAttachmentIds: [attachments[5]!.id] },
      }),
    );
    await rows
      .nth(1)
      .getByRole("button", { name: "Copy steer item 2" })
      .click();
    await expect(
      rows.nth(1).getByRole("button", { name: "Steer item 2 copied" }),
    ).toBeVisible();
    expect(
      await page.evaluate(async () => {
        const image = await createImageBitmap(
          await (await navigator.clipboard.read())[0]!.getType("image/png"),
        );
        const width = image.width;
        image.close();
        return width;
      }),
    ).toBe(720);
    await expect(rows.nth(0)).toContainText("Compare these charts");
    await expect(rows.nth(2)).toContainText("No text");

    const preview = pending.getByRole("button", {
      name: "Preview Pending steer item 1 image 1",
    });
    await preview.focus();
    await page.keyboard.press("Enter");
    const viewer = page.getByRole("dialog", { name: "Image preview" });
    await expect(viewer).toBeVisible();

    await expect(viewer.locator("img")).toHaveJSProperty("naturalWidth", 720);
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
    expect(boxes[4]!.top).toBeGreaterThan(boxes[0]!.top);

    await preview.click();
    await expect(viewer).toBeVisible();
    const thumbnailUrl = await preview.locator("img").getAttribute("src");
    if (!thumbnailUrl) throw new Error("Missing loaded Pending thumbnail");
    const canLoadThumbnail = () =>
      page.evaluate(async (url) => {
        const image = new Image();
        image.src = url;
        return image.decode().then(
          () => true,
          () => false,
        );
      }, thumbnailUrl);
    expect(await canLoadThumbnail()).toBe(true);
    transport.send({
      type: "queue_update",
      sessionId: "fixture-active",
      pendingQueues: { revision: 2, totalCount: 0, steering: [], followUp: [] },
    });
    await expect(viewer).toBeHidden();
    await expect(pending).toBeHidden();
    await expect.poll(canLoadThumbnail).toBe(false);
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
  await page.setViewportSize({ width: 320, height: 844 });
  await startRun({ composer, input });

  await input.fill("first pending instruction");
  await composer.getByRole("button", { name: "Send as steer" }).click();
  await expect(pending).toContainText("first pending instruction");
  const queue = composer.getByRole("button", { name: "Queue", exact: true });
  await queue.click();
  await expect(queue).toHaveAttribute("aria-pressed", "true");
  await expect(input).toHaveAttribute("placeholder", "Queue a follow-up…");
  expect(
    (
      await new AxeBuilder({ page })
        .include(".topbar")
        .include(".composer")
        .analyze()
    ).violations,
  ).toEqual([]);
  const instruction =
    "Keep the full direction readable when it wraps onto several lines in the narrow reading column.";
  await input.fill(instruction);
  await composer
    .getByRole("button", { name: "Queue after current task" })
    .click();
  const wrapped = pending
    .getByRole("listitem")
    .filter({ hasText: instruction });
  const copy = wrapped.getByRole("button", { name: "Copy queue item 1" });
  await expect(copy).toBeVisible();
  expect(
    await wrapped.evaluate((el) => el.scrollWidth - el.clientWidth),
  ).toBeLessThanOrEqual(1);
  await input.fill("draft that must survive Clear all");
  const clear = pending.getByRole("button", {
    name: "Clear all Pending input",
  });
  await page.keyboard.press("Tab");
  await clear.focus();
  await expect(clear).toBeFocused();
  expect(
    await clear.evaluate((button) => button.matches(":focus-visible")),
  ).toBe(true);
  const dangerColor = await clear.evaluate((button) => {
    const probe = document.createElement("span");
    probe.style.color = "var(--error)";
    button.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  });
  await expect(clear).toHaveCSS("color", dangerColor);
  await clear.press("Enter");
  await expect(pending).toContainText("Clear all?");
  const confirm = pending.getByRole("button", {
    name: "Clear all",
    exact: true,
  });
  await expect(confirm).toBeInViewport({ ratio: 1 });
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

test("Pending copies full text and restores queued text or images through Return and Stop", async ({
  page,
  context,
}) => {
  const { composer, input, pending } = await openPendingSession(page);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await startRun({ composer, input });
  const lines = [
    "Review the pending input presentation",
    "Keep the opening requirements",
    "Use the existing styling",
    ...Array.from(
      { length: 20 },
      (_, index) => `Middle detail ${index}: ${"x".repeat(40)}`,
    ),
    "Final requirement: preserve this last line.",
  ];
  const longText = lines.join("\n");
  await input.fill(longText);
  await composer.getByRole("button", { name: "Send as steer" }).click();
  await composer.getByRole("button", { name: "Queue", exact: true }).click();
  await input.fill("follow-up text");
  await composer
    .getByRole("button", { name: "Queue after current task" })
    .click();
  await expect(pending.getByRole("listitem")).toHaveCount(2);
  await expect(pending).toContainText(lines[0]!);
  await expect(pending).toContainText(lines.at(-1)!);
  await expect(pending).toContainText("…");
  await expect(pending).not.toContainText("Middle detail 10");
  await pending
    .getByRole("button", { name: "Copy steer item 1", exact: true })
    .click();
  await expect.poll(() => clipboardLines(page)).toEqual(lines);
  await pending.getByRole("button", { name: "Copy all pending input" }).click();
  await expect
    .poll(() => clipboardLines(page))
    .toEqual([
      `1. ${lines[0]}`,
      ...lines.slice(1).map((line) => `   ${line}`),
      "2. follow-up text",
    ]);
  await expect(pending.getByRole("listitem")).toHaveCount(2);
  await input.fill("existing draft");
  const recovery = Promise.withResolvers<void>();
  await page.route(
    "**/api/pending/recover",
    async (route) => {
      await recovery.promise;
      await route.continue();
    },
    { times: 1 },
  );
  const returnAll = pending.getByRole("button", {
    name: "Return all Pending input to composer",
  });
  try {
    await returnAll.click();
    await expect(returnAll).toBeDisabled();
    await expect(
      pending.getByRole("button", { name: "Clear all Pending input" }),
    ).toBeDisabled();
  } finally {
    recovery.resolve();
  }
  await expect(input).toHaveValue(
    `${longText}\n\nfollow-up text\n\nexisting draft`,
  );
  await expect(input).toBeFocused();
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
  await startRun({ composer, input });
  await addImage(composer, "escape-pending.gif");
  await composer.getByRole("button", { name: "Send as steer" }).click();
  const queuedImage = pending.getByRole("button", {
    name: "Preview Pending steer item 1 image 1",
  });
  await expect(queuedImage).toBeVisible();
  await input.fill("Escape draft");
  await openSettings(page);
  await page.keyboard.press("Escape");
  await expect(
    page.getByRole("dialog", { name: "Settings", exact: true }),
  ).toHaveCount(0);
  await expect(queuedImage).toBeVisible();
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();
  await input.focus();
  await page.keyboard.press("Escape");
  await expect(input).toHaveValue("Escape draft");
  await expect(input).toBeFocused();
  await expect(
    composer.getByRole("button", {
      name: "Preview escape-pending.gif",
      exact: true,
    }),
  ).toBeVisible();
  await expect(pending).toHaveCount(0);
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toHaveCount(0);
});

test("Return all restores images in order beside the draft and resends only retained attachments", async ({
  page,
}) => {
  const { composer, input, pending } = await openPendingSession(page);
  await startRun({ composer, input });
  const first = await addImage(composer, "pending-first.gif");
  await input.fill("first caption");
  await composer.getByRole("button", { name: "Send as steer" }).click();
  await expect(pending.getByRole("listitem")).toHaveCount(1);

  const second = await addImage(composer, "pending-second.gif");
  await composer.getByRole("button", { name: "Queue", exact: true }).click();
  await input.fill("second caption");
  const queue = composer.getByRole("button", {
    name: "Queue after current task",
    exact: true,
  });
  await queue.click();
  await expect(pending.getByRole("listitem")).toHaveCount(2);

  const draft = await addImage(composer, "newest-draft.gif");
  await input.fill("newest draft");
  await pending
    .getByRole("button", { name: "Return all Pending input to composer" })
    .click();
  const text = "first caption\n\nsecond caption\n\nnewest draft";
  await expect(input).toHaveValue(text);
  await expect(input).toBeFocused();
  const thumbnails = composer.locator(".attachment--image img");
  await expect(thumbnails).toHaveCount(3);
  await expect
    .poll(() =>
      thumbnails.evaluateAll((images) =>
        images.every((image) => (image as HTMLImageElement).naturalWidth > 0),
      ),
    )
    .toBe(true);

  await composer
    .getByRole("button", { name: "Remove attached image" })
    .last()
    .click();
  await expect(thumbnails).toHaveCount(2);
  const withdrawn = await hostRequest(page).get(
    `/api/attachments/${draft.id}/image`,
  );
  expect(withdrawn.status()).toBe(404);

  const resent = page.waitForRequest(
    (request) =>
      request.method() === "POST" &&
      new URL(request.url()).pathname === "/api/prompt",
  );
  await queue.click();
  expect((await resent).postDataJSON()).toMatchObject({
    message: text,
    attachmentIds: [first.id, second.id],
    behavior: "followUp",
  });
  await expect(pending.getByRole("listitem")).toHaveCount(1);
  await composer.getByRole("button", { name: "Abort running task" }).click();
  await expect(thumbnails).toHaveCount(2);
});
