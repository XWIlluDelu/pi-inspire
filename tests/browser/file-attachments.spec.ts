import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import { observeClipboardWrites } from "./support/clipboard";
import { openEventSession } from "./support/host-events";

// Exercise native artifact admission and persisted file references through the Host.
test.use({ serviceWorkers: "block" });

test("sent file prompts retain readable names, original bytes, and history across reload", {
  tag: "@cross-browser",
}, async ({ page, context, browserName }) => {
  if (browserName === "chromium")
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await openEventSession(
    page,
    "Sent file references",
    emptyToolPresentationConfiguration(),
    {},
  );
  await observeClipboardWrites(page);
  const question = "Review these attached guidelines";
  const input = page.getByRole("textbox", { name: "Message", exact: true });
  const names = [
    "AGENTS 1.md",
    `Long-project-guidance-${"details-".repeat(12)}.txt`,
    "diagram.svg",
    "cafe\u0301-" + "研究".repeat(50) + ".txt",
  ];
  const payloads = names.map((name) =>
    Buffer.from(
      name === "diagram.svg"
        ? '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="16"/>'
        : `Attachment content for ${name}.\n`,
    ),
  );
  const uploaded = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/attachments" &&
      response.request().method() === "POST",
  );
  await page.locator(".composer__file-input").setInputFiles(
    names.map((name, index) => ({
      name,
      mimeType: name === "diagram.svg" ? "image/svg+xml" : "text/plain",
      buffer: payloads[index]!,
    })),
  );
  await expect(
    page.locator(".composer__attachments .attachment--ready"),
  ).toHaveCount(names.length);
  const uploadResponse = await uploaded;
  expect(uploadResponse.ok()).toBe(true);
  const { attachments } = await uploadResponse.json();
  const uploadedNames: string[] = attachments.map(
    (file: { fileName: string }) => file.fileName,
  );
  // Safari normalizes local filenames before uploading. Verify the same
  // Unicode name and require the UI to show the Host's accepted spelling.
  expect(uploadedNames.map((name) => name.normalize("NFC"))).toEqual(
    names.map((name) => name.normalize("NFC")),
  );
  expect(
    attachments.find(
      (file: { fileName: string }) => file.fileName === "diagram.svg",
    ),
  ).toMatchObject({ kind: "file" });
  const staged = page.getByRole("list", { name: "Attachments", exact: true });
  await expect(
    staged.getByRole("button", { name: "Preview diagram.svg" }).locator("img"),
  ).toHaveJSProperty("naturalWidth", 32);
  await input.fill(question);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  const bubble = page
    .locator(".user-bubble")
    .filter({ hasText: question })
    .last();
  const files = bubble.getByRole("list", { name: "Referenced files" });
  await expect(files.getByRole("listitem")).toHaveCount(names.length);
  for (const name of uploadedNames)
    await expect(files.getByText(name, { exact: true })).toBeVisible();
  const sourcePaths = await files
    .getByRole("listitem")
    .evaluateAll((items) => items.map((item) => item.getAttribute("title")!));
  expect(sourcePaths.map((path) => readFileSync(path))).toEqual(payloads);

  await bubble.locator("..").hover();
  await bubble
    .locator("..")
    .getByRole("button", { name: "Copy message", exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(() => window.gestureClipboardWrites.at(-1)?.text ?? ""),
    )
    .toContain(question);
  const copied = (await page.evaluate(
    () => window.gestureClipboardWrites.at(-1)!.text,
  ))!;
  expect(copied).toContain(
    "Referenced files available to the agent (JSON paths):",
  );
  for (const path of sourcePaths)
    expect(copied).toContain(JSON.stringify(path));
  await page.reload();
  await expect(files.getByText(names[0]!, { exact: true })).toBeVisible();
  await expect(bubble.locator(".rich-text")).toHaveText(question);
  await input.press("ArrowUp");
  await expect(input).toHaveValue(question);
  const recalled = page.locator(".composer__attachments");
  for (const name of uploadedNames)
    await expect(recalled.getByText(name, { exact: true })).toBeVisible();
  const removeRecalled = recalled.getByRole("button", { name: /Remove/ });
  for (const _ of names) await removeRecalled.first().click();
  await input.fill("");
  await page.locator(".composer__file-input").setInputFiles({
    name: "only-reference.md",
    mimeType: "text/markdown",
    buffer: Buffer.from("# Only a file\n"),
  });
  await expect(recalled.locator(".attachment--ready")).toHaveCount(1);
  await page.getByRole("button", { name: "Send message", exact: true }).click();
  await expect(
    page
      .locator(".user-bubble")
      .filter({ hasText: "only-reference.md" })
      .getByRole("listitem"),
  ).toHaveText("only-reference.md");
});
