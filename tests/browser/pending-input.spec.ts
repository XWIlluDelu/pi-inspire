import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import type { UploadedAttachment } from "../../shared/contracts";
import { pendingTextSummary } from "../../shared/pending-preview";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { clipboardLines } from "./support/clipboard";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import {
  browserTestToken,
  openFixtureSession,
  pairedPage,
  reloadSession,
} from "./support/navigation";

const pixel = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

async function openPendingSession(page: Page, owned = false) {
  await pairedPage(page);
  if (owned) {
    const created = await hostRequest(page).post("/api/sessions/new", {
      data: { cwd: browserWorkspace, name: "Pending input fixture" },
    });
    expect(created.ok()).toBe(true);
    await reloadSession(page, (await created.json()).active.sessionId);
  } else {
    await openFixtureSession(
      page,
      /Formula rendering and spectral analysis/,
      "fixture-active",
    );
  }
  const composer = page.getByRole("form", { name: "Message composer" });
  const input = composer.getByRole("textbox", { name: "Message", exact: true });
  const pending = page.getByRole("region", { name: "Pending input" });
  await expect(input).toBeVisible();
  return { composer, input, pending };
}

async function startRun(composer: Locator, input: Locator) {
  await sendInput(
    composer,
    input,
    "Send message",
    `Keep the offline stream active ${"x".repeat(2_000)}`,
  );
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();
}

async function sendInput(
  composer: Locator,
  input: Locator,
  button: string,
  message: string,
) {
  await input.fill(message);
  await composer.getByRole("button", { name: button, exact: true }).click();
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

test("Pending image thumbnails open the shared viewer and wrap at narrow widths", async ({
  page,
  request,
}) => {
  const bytes = await readFile(
    "tests/browser/fixtures/file-previews/training curve.png",
  );
  const headers = { Authorization: `Bearer ${browserTestToken}` };
  const response = await request.post("/api/attachments", {
    headers,
    multipart: {
      files: { name: "pending.png", mimeType: "image/png", buffer: bytes },
    },
  });
  expect(response.ok()).toBe(true);
  const { id }: UploadedAttachment = (await response.json()).attachments[0];
  // A fixed queue makes the five-thumbnail layout reproducible; each
  // thumbnail still reads its bytes from the real attachment route.
  const pendingProjection = {
    revision: 1,
    totalCount: 3,
    steering: [
      {
        id: "thumbnail-caption",
        ...pendingTextSummary("Compare these charts"),
        imageCount: 5,
        imageAttachmentIds: Array<string>(5).fill(id),
      },
      {
        id: "thumbnail-image-only",
        ...pendingTextSummary(""),
        imageCount: 1,
        imageAttachmentIds: [id],
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
    await page.setViewportSize({ width: 320, height: 720 });
    await preview.scrollIntoViewIfNeeded();
    await expect
      .poll(() =>
        page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
      )
      .toBe(true);
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
    await request.delete(`/api/attachments/${id}`, { headers });
  }
});

test("Pending Clear all keeps its explicit two-step confirmation and leaves the draft", async ({
  page,
}) => {
  const { composer, input, pending } = await openPendingSession(page, true);
  await page.setViewportSize({ width: 320, height: 844 });
  await startRun(composer, input);

  await sendInput(
    composer,
    input,
    "Send as steer",
    "first pending instruction",
  );
  await expect(pending).toContainText("first pending instruction");
  await composer.getByRole("button", { name: "Queue", exact: true }).click();
  await sendInput(composer, input, "Queue after current task", "second pending instruction");
  await input.fill("draft that must survive Clear all");
  const clear = pending.getByRole("button", {
    name: "Clear all Pending input",
  });
  await clear.focus();
  await clear.press("Enter");
  await expect(pending).toContainText("Clear all?");
  const confirm = pending.getByRole("button", {
    name: "Clear all",
    exact: true,
  });
  await expect(confirm).toBeInViewport({ ratio: 1 });
  await pending
    .getByRole("button", { name: "Cancel clearing Pending input" })
    .click();
  await expect(
    pending.getByRole("button", { name: "Clear all", exact: true }),
  ).toHaveCount(0);
  await clear.click();
  await confirm.click();
  await expect(pending).toHaveCount(0);
  await expect(input).toHaveValue("draft that must survive Clear all");
  await expect(
    composer.getByRole("button", { name: "Abort running task" }),
  ).toBeVisible();
  await composer.getByRole("button", { name: "Abort running task" }).click();
});

test("Pending copies the full queue and returns input to the currently edited draft", async ({
  page,
  context,
}) => {
  const { composer, input, pending } = await openPendingSession(page, true);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin: new URL(page.url()).origin,
  });
  await startRun(composer, input);
  const lines = [
    "Review the pending input presentation",
    ...Array.from(
      { length: 20 },
      (_, index) => `Middle detail ${index}: ${"x".repeat(40)}`,
    ),
    "Final requirement: preserve this last line.",
  ];
  const longText = lines.join("\n");
  await addImage(composer, "pending-first.gif");
  await sendInput(composer, input, "Send as steer", longText);
  await addImage(composer, "pending-second.gif");
  await composer.getByRole("button", { name: "Queue", exact: true }).click();
  await sendInput(composer, input, "Queue after current task", "Follow-up");
  const items = pending.getByRole("listitem");
  await expect(items).toHaveCount(2);
  await expect(items.first()).toContainText(lines[0]!);
  await expect(items.first()).toContainText(lines.at(-1)!);
  await expect(items.first()).toContainText("…");
  await expect(items.first()).not.toContainText("Middle detail 10");
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
      "2. Follow-up",
    ]);
  await expect(items).toHaveCount(2);

  await addImage(composer, "newest-draft.gif");
  await input.fill("newest draft");
  const returnAll = pending.getByRole("button", {
    name: "Return all Pending input to composer",
  });
  await returnAll.click();
  const text = `${longText}\n\nFollow-up\n\nnewest draft`;
  await expect(input).toHaveValue(text);
  await expect(input).toBeFocused();
  await expect(pending).toHaveCount(0);
  await expect(composer.locator(".attachment--image img")).toHaveCount(3);
  await composer.getByRole("button", { name: "Abort running task" }).click();
});
