import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expect, type Page, test } from "@playwright/test";
import type { ActiveSnapshot } from "../../shared/contracts";
import { browserWorkspace } from "./fixtures/workspace.mjs";
import { routeSnapshots } from "./support/host-events";
import { hostRequest } from "./support/host-request";
import { imageFile } from "./support/images";
import { openFixtureSession, pairedPage } from "./support/navigation";

test.use({ serviceWorkers: "block" });

async function openNew(page: Page) {
  const button = page.getByRole("button", { name: "New session", exact: true });
  if (!(await button.isVisible()))
    await page.getByRole("button", { name: "Toggle navigation" }).click();
  await button.click();
}

const firstInput = (page: Page) =>
  page.getByRole("textbox", { name: "First message", exact: true });
const startButton = (page: Page) =>
  page.getByRole("button", { name: "Start session", exact: true });
const creation = (page: Page) =>
  page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sessions/new" && response.ok(),
  );

test("New resolves trusted model defaults and sends explicit then inherited native choices", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const root = await mkdtemp(join(tmpdir(), "inspire-welcome-model-"));
  const cwd = await realpath(root);
  try {
    await mkdir(join(cwd, ".pi/extensions"), { recursive: true });
    const extension = pathToFileURL(
      resolve("tests/fixtures/pi-model-workflow-extension.ts"),
    ).href;
    await writeFile(
      join(cwd, ".pi/extensions/model.ts"),
      `import { registerModelWorkflow } from ${JSON.stringify(extension)}; export default pi => registerModelWorkflow(pi, "project");`,
    );
    await writeFile(
      join(cwd, ".pi/settings.json"),
      JSON.stringify({
        defaultProvider: "project-router",
        defaultModel: "auto",
        defaultThinkingLevel: "low",
      }),
    );
    await routeSnapshots(page, {
      socket: false,
      bootstrap(body) {
        body.toolPresentations = {
          version: 1,
          rules: {},
          mappings: {},
          controls: [
            {
              id: "project.mode",
              slot: "thinking",
              label: "Project response mode",
              command: "/project-mode",
              state: { key: "project-mode", value: "mode" },
              options: [
                { value: "normal", label: "Normal" },
                { value: "quick", label: "Quick" },
              ],
            },
          ],
        };
      },
    });
    await pairedPage(page);
    await page.getByRole("textbox", { name: "Project directory" }).fill(cwd);
    const model = page.getByRole("button", { name: "Model", exact: true });
    const thinking = page.getByLabel("Thinking level", { exact: true });
    await expect(model).toHaveText("project router");
    await expect(model).toHaveAttribute(
      "title",
      "Use workspace model defaults",
    );
    await expect(thinking).toContainText("Low");
    const message = firstInput(page);
    const project = page.getByRole("textbox", { name: "Project directory" });
    await message.fill("/project-mode");
    await expect(
      page.getByRole("option", { name: /project-mode/ }),
    ).toBeVisible();
    await message.press("Escape");
    await project.fill(browserWorkspace);
    await expect(thinking).toHaveAttribute("aria-haspopup", "listbox");
    await project.fill(cwd);
    await expect(thinking).toHaveAttribute("aria-haspopup", "dialog");

    await model.click();
    await page.getByRole("option", { name: /project router.*Router/ }).click();
    await thinking.click();
    await page
      .getByRole("listbox", { name: /thinking/i })
      .getByRole("option", { name: "High", exact: true })
      .click();
    await thinking.click();
    await page.getByText("Quick", { exact: true }).click();

    let sourceId: string | undefined;
    for (const text of ["First routed input", "Continue the selected router"]) {
      if (sourceId) {
        await openNew(page);
        await expect(model).toHaveAttribute(
          "title",
          "Inherit model from source session",
        );
        await expect(thinking).toContainText("High");
      }
      await message.fill(text);
      const started = creation(page);
      await startButton(page).click();
      const response = await started;
      const { receipt: _receipt, ...options } = response.request().postDataJSON();
      expect(options).toEqual({
        cwd,
        model: { provider: "project-router", id: "auto" },
        thinkingLevel: "high",
      });
      const snapshot: ActiveSnapshot = await response.json();
      expect(snapshot.active).toMatchObject({
        model: { provider: "project-router", id: "auto", virtual: true },
        thinkingLevel: "high",
      });
      await expect(
        page.locator(".user-bubble").filter({ hasText: text }),
      ).toBeVisible();
      await expect(
        page.getByText("project physical a reply", { exact: true }),
      ).toBeVisible();
      if (sourceId) expect(snapshot.active!.sessionId).not.toBe(sourceId);
      else {
        sourceId = snapshot.active!.sessionId;
        const source: ActiveSnapshot = await (
          await hostRequest(page).get(`/api/snapshot?detail=${sourceId}`)
        ).json();
        expect(source.extensionStatuses?.["project-mode"]).toBe(
          JSON.stringify({ mode: "quick" }),
        );
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a new mixed draft sends the original canonical project file and image", async ({
  page,
}) => {
  const root = await mkdtemp(join(tmpdir(), "inspire-welcome-input-"));
  const original = join(root, "original"),
    replacement = join(root, "replacement");
  const link = join(root, "selected");
  const file = "workspace-notes.txt";
  try {
    for (const cwd of [original, replacement]) {
      await mkdir(cwd);
      await writeFile(join(cwd, file), cwd);
    }
    await symlink(original, link, "junction");
    await pairedPage(page);
    const directory = page.getByRole("textbox", { name: "Project directory" });
    await directory.fill(replacement);
    const files = page.getByRole("button", { name: "Add project files" });
    const choose = async () => {
      await files.click();
      const search = page.getByRole("combobox", {
        name: "Search project files",
      });
      await search.fill(file);
      await page.getByRole("option", { name: new RegExp(file) }).click();
      await search.press("Escape");
    };
    await choose();
    const references = page.getByRole("list", {
      name: "Referenced project files",
    });
    await expect(references).toContainText(file);
    await directory.fill(link);
    await expect(references).toHaveCount(0);
    await choose();

    const image = await imageFile(page, {
      name: "first-input.png",
      width: 32,
      height: 24,
    });
    await page.locator(".composer__file-input").setInputFiles(image);
    await expect(
      page.getByRole("button", { name: "Preview first-input.png" }),
    ).toBeVisible();
    await firstInput(page).fill("Review the first image and project file");
    await expect(startButton(page)).toBeEnabled();
    await rm(link);
    await symlink(replacement, link, "junction");
    const started = creation(page);
    const prompted = page.waitForResponse(
      (response) => response.url().endsWith("/api/prompt") && response.ok(),
    );
    await startButton(page).click();
    const { receipt: _receipt, ...options } = (await started).request().postDataJSON();
    expect(options).toEqual({ cwd: await realpath(original) });
    expect((await prompted).request().postDataJSON()).toMatchObject({
      message: "Review the first image and project file",
      projectFiles: [file],
      attachmentIds: [expect.any(String)],
    });
    const savedInput = page
      .getByRole("log")
      .locator(".turn--user")
      .filter({ hasText: "Review the first image" });
    await expect(
      savedInput.getByRole("button", { name: "Fork session from this input" }),
    ).toBeVisible({ timeout: 12_000 });
    await expect(savedInput).toHaveCount(1);
    await expect(
      savedInput
        .getByRole("list", { name: "Referenced files" })
        .getByTitle(join(await realpath(original), file)),
    ).toBeVisible();
    await expect(
      savedInput.getByRole("button", { name: "Preview attached image" }),
    ).toBeVisible();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("late upload keeps a created draft on its owner after opening another session", async ({
  page,
}) => {
  const admitted = Promise.withResolvers<void>();
  const deliver = Promise.withResolvers<void>();
  await page.route(
    "**/api/attachments",
    async (route) => {
      const response = await route.fetch();
      admitted.resolve();
      await deliver.promise;
      await route.fulfill({ response });
    },
    { times: 1 },
  );
  await pairedPage(page);
  await page
    .getByRole("textbox", { name: "Project directory" })
    .fill(browserWorkspace);
  const input = "This first message belongs to the created session";
  await firstInput(page).fill(input);
  await page
    .locator(".composer__file-input")
    .setInputFiles(await imageFile(page, { width: 32, height: 24 }));
  const prompts: unknown[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/api/prompt"))
      prompts.push(request.postDataJSON());
  });
  const started = creation(page);
  const uploaded = page.waitForResponse((response) =>
    response.url().endsWith("/api/attachments"),
  );
  try {
    await startButton(page).click();
    await admitted.promise;
    await openFixtureSession(
      page,
      /Review extension event lifecycle/,
      "fixture-history",
    );
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Separate draft");
  } finally {
    deliver.resolve();
  }
  expect((await uploaded).ok()).toBe(true);
  await expect(
    page.getByRole("textbox", { name: "Message", exact: true }),
  ).toHaveValue("Separate draft");
  const snapshot: ActiveSnapshot = await (await started).json();
  const sessionId = snapshot.active!.sessionId;
  expect(
    await page.evaluate(
      (id) =>
        sessionStorage.getItem(
          `inspire:composer-draft:v1:session:${encodeURIComponent(id)}`,
        ),
      sessionId,
    ),
  ).toBe(input);
  const original: ActiveSnapshot = await (
    await hostRequest(page).get(`/api/snapshot?detail=${sessionId}`)
  ).json();
  expect(original.active?.transcriptPage.messages).toEqual([]);
  expect(prompts).toEqual([]);
});
