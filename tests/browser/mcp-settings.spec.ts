import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { McpConfigService } from "../../server/mcp-config";
import type { McpConfigEdit } from "../../shared/mcp";
import { pairAndOpen } from "./support/navigation";

async function scenario(page: Page) {
  const root = await mkdtemp(join(tmpdir(), "inspire-browser-mcp-"));
  const agent = join(root, "agent"),
    cwd = join(root, "project");
  await mkdir(agent);
  await mkdir(join(cwd, ".pi"), { recursive: true });
  const userFile = join(agent, "mcp.json"),
    projectFile = join(cwd, ".pi/mcp.json");
  const docs = {
    url: "https://user:stored-url-secret@docs.example.invalid/mcp?token=stored-query-secret",
    headers: {
      Authorization: "Bearer stored-header-secret",
      "X-Tenant": "stored-tenant",
    },
    oauth: { clientId: "stored-client", clientSecret: "stored-oauth-secret" },
    description: "Documentation",
    custom: { preserved: true },
  };
  await writeFile(
    userFile,
    JSON.stringify({ mcpServers: { docs }, autoEnableCodemode: false }),
  );
  await writeFile(
    projectFile,
    JSON.stringify({
      mcpServers: {
        docs: {
          command: "node",
          args: ["server.js", "--secret=stored-argument"],
          env: { TOKEN: "stored-env-secret" },
          description: "Project documentation",
        },
      },
    }),
  );
  const service = new McpConfigService(agent),
    edits: McpConfigEdit[] = [],
    wire: string[] = [];
  let authority = "",
    reloads = 0;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/bootstrap**", async (route) => {
    const response = await route.fetch();
    authority = response.headers()["x-inspire-authority"] ?? "";
    await route.fulfill({ response });
  });
  await page.route("**/api/mcp-config**", async (route) => {
    try {
      let payload: unknown;
      if (route.request().method() === "PATCH") {
        const edit = route.request().postDataJSON() as McpConfigEdit;
        edits.push(edit);
        await service.save(cwd, edit);
        payload = { saved: true, snapshot: await service.read(cwd) };
      } else payload = await service.read(cwd);
      wire.push(JSON.stringify(payload));
      await route.fulfill({
        headers: { "X-Inspire-Authority": authority },
        json: payload,
      });
    } catch (error) {
      await route.fulfill({
        status: 409,
        headers: { "X-Inspire-Authority": authority },
        json: { error: (error as Error).message },
      });
    }
  });
  await page.route("**/api/control/native-command", async (route) => {
    reloads++;
    await route.fulfill({
      headers: { "X-Inspire-Authority": authority },
      json: { outcome: "completed", message: "Reloaded fixture" },
    });
  });
  await pairAndOpen(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "MCP", exact: true }).click();
  await expect(
    settings.getByRole("button", { name: "Edit user server docs" }),
  ).toBeVisible();
  return {
    root,
    userFile,
    projectFile,
    settings,
    edits,
    wire,
    errors,
    reloads: () => reloads,
    json: async (path: string) => JSON.parse(await readFile(path, "utf8")),
  };
}
test("MCP configuration failures share the existing card inset", async ({ page }) => {
  await page.route("**/api/mcp-config**", (route) =>
    route.fulfill({
      status: 503,
      json: { error: "Could not read the MCP configuration directory." },
    }),
  );
  await pairAndOpen(page);
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  const settings = page.getByRole("dialog", { name: "Settings", exact: true });
  await settings.getByRole("button", { name: "MCP", exact: true }).click();
  const error = settings.locator(".mcp-config > .settings__error");
  await expect(error).toContainText("Could not read");
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const alignment = await error.evaluate((el) => {
      const text = document.createRange();
      text.selectNodeContents(el);
      const heading = el.parentElement!.querySelector(".models-subheading")!;
      return {
        left: text.getClientRects()[0]!.left - heading.getBoundingClientRect().left,
        // The parent already owns the card inset; this is not another form row.
        paddingBlock: getComputedStyle(el).paddingBlock,
      };
    });
    expect(Math.abs(alignment.left)).toBeLessThanOrEqual(1);
    expect(alignment.paddingBlock).toBe("0px");
  }
});

test("MCP edits retain stored secrets and scope, keep drafts across categories, and separate save from Reload", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fixture = await scenario(page);
  const { settings } = fixture;
  try {
    await settings
      .getByRole("button", { name: "Edit user server docs" })
      .click();
    await expect(
      settings.getByLabel("Server URL", { exact: true }),
    ).toHaveValue("");
    await settings.getByText("Advanced configuration", { exact: true }).click();
    await settings
      .getByLabel("Description", { exact: true })
      .fill("Updated documentation");
    await settings
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    await expect(
      settings.getByLabel("Description", { exact: true }),
    ).not.toBeVisible();
    await settings.getByRole("button", { name: "MCP", exact: true }).click();
    await expect(
      settings.getByLabel("Description", { exact: true }),
    ).toHaveValue("Updated documentation");
    await expect(
      settings.getByLabel("Header value for Authorization"),
    ).toHaveValue("");
    await settings
      .getByRole("button", { name: "Remove header X-Tenant" })
      .click();
    await settings
      .getByText("OAuth client configuration", { exact: true })
      .click();
    await expect(
      settings.getByLabel("Client secret", { exact: true }),
    ).toHaveValue("");
    await settings
      .getByLabel("Client name", { exact: true })
      .fill("Inspire fixture");
    await settings
      .getByRole("button", { name: "Save configuration", exact: true })
      .click();
    await expect(
      settings.getByText(
        "Saved to file. Running sessions have not been reloaded.",
      ),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "Edit user server docs" }),
    ).toBeFocused();
    expect(fixture.reloads()).toBe(0);
    const user = await fixture.json(fixture.userFile);
    expect(user.mcpServers.docs).toMatchObject({
      url: expect.stringContaining("stored-url-secret"),
      headers: { Authorization: "Bearer stored-header-secret" },
      oauth: {
        clientId: "stored-client",
        clientSecret: "stored-oauth-secret",
        clientName: "Inspire fixture",
      },
      custom: { preserved: true },
    });
    expect(user.mcpServers.docs.headers).not.toHaveProperty("X-Tenant");
    expect(
      (await fixture.json(fixture.projectFile)).mcpServers.docs.description,
    ).toBe("Project documentation");
    expect(fixture.edits[0]!.values).not.toHaveProperty("url");
    expect(fixture.edits[0]!.values?.headers).toEqual({ "X-Tenant": null });
    expect(fixture.wire.join("")).not.toMatch(
      /stored-(url|query|header|tenant|oauth|argument|env|client)/,
    );
    await settings
      .getByRole("button", { name: "Reload selected session…" })
      .click();
    await expect(
      settings.getByText(/Reload restarts only the selected idle Pi worker/),
    ).toBeVisible();
    expect(fixture.reloads()).toBe(0);
    await settings.getByRole("button", { name: "Cancel reload" }).click();
    await settings
      .getByRole("button", { name: "Reload selected session…" })
      .click();
    await settings
      .getByRole("button", { name: "Reload Pi resources", exact: true })
      .click();
    await expect.poll(fixture.reloads).toBe(1);
    // An edit conflict preserves the draft and makes no claim of saving it.
    await settings
      .getByRole("button", { name: "Edit project server docs" })
      .click();
    await settings.getByText("Advanced configuration", { exact: true }).click();
    await settings.getByLabel("Description", { exact: true }).fill("My draft");
    const external = await fixture.json(fixture.projectFile);
    external.mcpServers.docs.timeout = 99;
    await writeFile(fixture.projectFile, JSON.stringify(external));
    await settings
      .getByRole("button", { name: "Save configuration", exact: true })
      .click();
    await expect(settings.getByRole("alert")).toContainText(
      "changed elsewhere",
    );
    await expect(
      settings.getByLabel("Description", { exact: true }),
    ).toHaveValue("My draft");
    expect(
      (await fixture.json(fixture.projectFile)).mcpServers.docs.description,
    ).toBe("Project documentation");
    await settings
      .getByRole("button", { name: "Refresh MCP files", exact: true })
      .click();
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await settings
      .getByRole("button", { name: "Save configuration", exact: true })
      .click();
    await expect(
      settings.getByRole("button", { name: "Edit project server docs" }),
    ).toBeVisible();
    expect(
      (await fixture.json(fixture.projectFile)).mcpServers.docs,
    ).toMatchObject({
      description: "My draft",
      timeout: 99,
      args: ["server.js", "--secret=stored-argument"],
      env: { TOKEN: "stored-env-secret" },
    });
    expect(fixture.errors).toEqual([]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
test("narrow MCP form adds a scoped stdio server with structured arguments and supports explicit removal", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await scenario(page);
  const { settings } = fixture;
  try {
    await settings
      .getByRole("button", { name: "Add server", exact: true })
      .click();
    await settings
      .getByLabel("Server name", { exact: true })
      .fill("project-tools");
    await settings
      .getByRole("combobox", { name: "Configuration target" })
      .click();
    await page
      .getByRole("option", { name: "This project", exact: true })
      .click();
    await settings
      .getByRole("combobox", { name: "Transport", exact: true })
      .click();
    await page.getByRole("option", { name: "Stdio", exact: true }).click();
    await settings.getByLabel("Program", { exact: true }).fill("node");
    await settings
      .getByRole("button", { name: "Add argument", exact: true })
      .click();
    await settings
      .getByLabel("Argument 1", { exact: true })
      .fill("server with spaces.js");
    await settings.getByText("Advanced configuration", { exact: true }).click();
    await settings
      .getByRole("button", { name: "Add environment variable" })
      .click();
    await settings.getByLabel("Environment variable name").fill("API_TOKEN");
    await settings
      .getByLabel("Environment variable value for API_TOKEN")
      .fill("${PROJECT_TOKEN}");
    await settings
      .getByRole("combobox", { name: "Tool exposure", exact: true })
      .click();
    await page.getByRole("option", { name: "Deferred", exact: true }).click();
    await settings
      .getByRole("switch", { name: "Enabled in file" })
      .locator("..")
      .click();
    await expect(
      settings.getByRole("switch", { name: "Enabled in file" }),
    ).not.toBeChecked();
    await settings
      .getByLabel("Environment variable value for API_TOKEN")
      .scrollIntoViewIfNeeded();
    expect(
      await settings.evaluate(
        (element) => element.scrollWidth <= element.clientWidth,
      ),
    ).toBe(true);
    const save = settings.getByRole("button", {
      name: "Save configuration",
      exact: true,
    });
    await save.click();
    await expect(
      settings.getByRole("button", {
        name: "Edit project server project-tools",
      }),
    ).toBeVisible();
    expect(
      (await fixture.json(fixture.projectFile)).mcpServers["project-tools"],
    ).toEqual({
      command: "node",
      args: ["server with spaces.js"],
      env: { API_TOKEN: "${PROJECT_TOKEN}" },
      exposure: "deferred",
      enabled: false,
    });
    expect(
      (await fixture.json(fixture.userFile)).mcpServers,
    ).not.toHaveProperty("project-tools");
    await settings
      .getByRole("button", { name: "Remove project server project-tools" })
      .click();
    await settings
      .getByRole("button", { name: "Remove configuration", exact: true })
      .click();
    await expect(
      settings.getByRole("button", {
        name: "Edit project server project-tools",
      }),
    ).toHaveCount(0);
    expect(
      (await fixture.json(fixture.projectFile)).mcpServers.docs.env,
    ).toEqual({ TOKEN: "stored-env-secret" });
    // Pi 1.1 can save a project policy without duplicating the user connection.
    const userBefore = await fixture.json(fixture.userFile);
    await writeFile(
      fixture.projectFile,
      JSON.stringify({ mcpServers: { docs: { enabled: false } } }),
    );
    await settings
      .getByRole("button", { name: "Refresh MCP files", exact: true })
      .click();
    await settings
      .getByRole("button", { name: "Edit project server docs" })
      .click();
    await expect(
      settings.getByLabel("Server URL", { exact: true }),
    ).toHaveCount(0);
    await expect(
      settings.getByRole("combobox", { name: "Tool exposure", exact: true }),
    ).toHaveText("Inherit from user");
    await settings
      .getByRole("combobox", { name: "Enabled in this project" })
      .click();
    await page
      .getByRole("option", { name: "Inherit from user", exact: true })
      .click();
    await settings
      .getByRole("combobox", { name: "Tool exposure", exact: true })
      .click();
    await page.getByRole("option", { name: "Hidden", exact: true }).click();
    await save.click();
    await expect(
      settings.getByRole("button", { name: "Edit project server docs" }),
    ).toBeVisible();
    expect((await fixture.json(fixture.projectFile)).mcpServers.docs).toEqual({
      exposure: "hidden",
    });
    expect(await fixture.json(fixture.userFile)).toEqual(userBefore);
    expect(fixture.errors).toEqual([]);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
