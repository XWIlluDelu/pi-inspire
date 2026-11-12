import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { McpConfigService } from "../../server/mcp-config";
import type { McpConfigEdit, McpConnectionRead } from "../../shared/mcp";
import { expectConfigurationField } from "./support/configuration-form";
import { openSettings, pairAndOpen } from "./support/navigation";

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
    oauth: {
      clientId: "stored-client",
      clientName: "Stored client",
      clientSecret: "stored-oauth-secret",
    },
    toolExposure: { "read_*": "direct", "*": "hidden" },
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
          toolExposure: { "read_*": "direct" },
        },
      },
    }),
  );
  const service = new McpConfigService(agent),
    reveals: McpConnectionRead[] = [];
  let authority = "",
    writes = 0,
    reloads = 0;
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.route("**/api/bootstrap**", async (route) => {
    const response = await route.fetch();
    authority = response.headers()["x-inspire-authority"] ?? "";
    await route.fulfill({ response });
  });
  await page.route("**/api/mcp-config**", async (route) => {
    try {
      let payload: unknown;
      if (
        new URL(route.request().url()).pathname === "/api/mcp-config/connection"
      ) {
        const read = route.request().postDataJSON() as McpConnectionRead;
        reveals.push(read);
        payload = await service.readConnection(cwd, read);
      } else if (route.request().method() === "PATCH") {
        writes++;
        const edit = route.request().postDataJSON() as McpConfigEdit;
        await service.save(cwd, edit);
        payload = { saved: true, snapshot: await service.read(cwd) };
      } else payload = await service.read(cwd);
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
  await openSettings(page);
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
    reveals,
    writes: () => writes,
    reloads: () => reloads,
    json: async (path: string) => JSON.parse(await readFile(path, "utf8")),
  };
}
test("MCP reveals saved connection values on request, keeps edits scoped, and reloads only on confirmation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fixture = await scenario(page);
  const { settings } = fixture;
  try {
    await settings
      .getByRole("button", { name: "Edit user server docs" })
      .click();
    const url = settings.getByLabel("Server URL", { exact: true });
    await expectConfigurationField(url);
    await expect(url).toHaveValue("");
    expect(fixture.reveals).toEqual([]);
    await settings.getByRole("button", { name: "Show saved URL" }).click();
    await expect(
      settings.getByLabel("Server URL", { exact: true }),
    ).toHaveValue(/stored-url-secret/);
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
    await settings.getByRole("button", { name: "Add header" }).click();
    const newHeader = settings
      .getByLabel("Header name", { exact: true })
      .last();
    await newHeader.fill("Authorization");
    await expect
      .poll(() =>
        newHeader.evaluate(
          (input: HTMLInputElement) => input.validationMessage,
        ),
      )
      .toMatch(/unique/);
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    expect(fixture.writes()).toBe(0);
    await newHeader.fill("X-Workspace");
    await settings.getByLabel("Header value for X-Workspace").fill("workspace");
    await settings
      .getByRole("button", { name: "Remove header X-Tenant" })
      .click();
    await settings
      .getByText("OAuth client configuration", { exact: true })
      .click();
    await expect(
      settings.getByLabel("Client secret", { exact: true }),
    ).toHaveValue("");
    const registration = settings.getByRole("combobox", {
      name: "Client registration",
    });
    await expect(registration).toHaveText("Automatic (Pi default)");
    await registration.click();
    await page
      .getByRole("option", { name: "Pi metadata document (CIMD)" })
      .click();
    const save = settings.getByRole("button", { name: "Save", exact: true });
    await expect(settings.getByRole("alert")).toContainText(
      "cannot use a client ID or client name",
    );
    await expect(save).toBeDisabled();
    await settings.getByRole("checkbox", { name: "Remove client id" }).check();
    await settings
      .getByRole("checkbox", { name: "Remove client name" })
      .check();
    await settings.getByRole("button", { name: "Remove tool rule 1" }).click();
    await settings.getByRole("button", { name: "Add tool rule" }).click();
    await settings.getByLabel("Tool name or pattern").last().fill("read_*");
    await save.click();
    await expect(
      settings.getByText(
        "Saved to file. Running sessions have not been reloaded.",
      ),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "Edit user server docs" }),
    ).toBeFocused();
    expect(fixture.reloads()).toBe(0);
    expect(fixture.writes()).toBe(1);
    const saved = (await fixture.json(fixture.userFile)).mcpServers.docs;
    expect(saved.description).toBe("Updated documentation");
    expect(saved.url).toContain("stored-url-secret");
    expect(saved.headers).toEqual({
      Authorization: "Bearer stored-header-secret",
      "X-Workspace": "workspace",
    });
    expect(saved.oauth).toEqual({
      clientRegistration: "cimd",
      clientSecret: "stored-oauth-secret",
    });
    expect(Object.entries(saved.toolExposure)).toEqual([
      ["*", "hidden"],
      ["read_*", "codemode"],
    ]);
    await settings
      .getByRole("button", { name: "Reload selected session…" })
      .click();
    await expect(
      settings.getByRole("button", {
        name: "Reload Pi resources",
        exact: true,
      }),
    ).toBeVisible();
    expect(fixture.reloads()).toBe(0);
    await settings
      .getByRole("button", { name: "Reload Pi resources", exact: true })
      .click();
    await expect.poll(fixture.reloads).toBe(1);
    // An edit conflict preserves the draft and makes no claim of saving it.
    await settings
      .getByRole("button", { name: "Edit project server docs" })
      .click();
    await expect(
      settings.getByLabel("Argument 1", { exact: true }),
    ).toHaveCount(0);
    await settings
      .getByRole("button", { name: "Show saved arguments" })
      .click();
    const programArg = settings.getByLabel("Argument 1", { exact: true });
    await expect(programArg).toBeFocused();
    await expect(programArg).toHaveValue("server.js");
    await programArg.fill("updated server.js");
    await settings.getByText("Advanced configuration", { exact: true }).click();
    await settings.getByRole("button", { name: "Remove tool rule 1" }).click();
    const external = await fixture.json(fixture.projectFile);
    external.mcpServers.docs.timeout = 99;
    await writeFile(fixture.projectFile, JSON.stringify(external));
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(settings.getByRole("alert")).toContainText(
      "changed elsewhere",
    );
    await expect(programArg).toHaveValue("updated server.js");
    await settings
      .getByRole("button", { name: "Refresh MCP files", exact: true })
      .click();
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await settings.getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      settings.getByRole("button", { name: "Edit project server docs" }),
    ).toBeVisible();
    const project = (await fixture.json(fixture.projectFile)).mcpServers.docs;
    expect(project).toMatchObject({
      timeout: 99,
      args: ["updated server.js", "--secret=stored-argument"],
      env: { TOKEN: "stored-env-secret" },
    });
    expect(project.toolExposure).toEqual({});
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
test.describe("touch MCP editor", () => {
  test.use({ hasTouch: true });

  test("narrow MCP form adds and removes scoped stdio definitions and focuses inherited policy editing", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await scenario(page);
    const { settings } = fixture;
    const editProject = (name: string) =>
      settings.getByRole("button", {
        name: `Edit project server ${name}`,
        exact: true,
      });
    const removeProject = async (name: string) => {
      await settings
        .getByRole("button", {
          name: `Remove project server ${name}`,
          exact: true,
        })
        .click();
      await settings
        .getByRole("button", { name: "Remove configuration", exact: true })
        .click();
    };
    const choose = async (name: string, option: string) => {
      await settings.getByRole("combobox", { name, exact: true }).click();
      await page.getByRole("option", { name: option, exact: true }).click();
    };
    try {
      const userBefore = await fixture.json(fixture.userFile);
      await settings
        .getByRole("button", { name: "Add server", exact: true })
        .click();
      const name = settings.getByLabel("Server name", { exact: true });
      await expectConfigurationField(name);
      await name.fill("project-tools");
      await choose("Configuration target", "This project");
      await choose("Transport", "Stdio");
      await settings.getByLabel("Program", { exact: true }).fill("node");
      await settings
        .getByRole("button", { name: "Add argument", exact: true })
        .click();
      await settings
        .getByLabel("Argument 1", { exact: true })
        .fill("server with spaces.js");
      await settings
        .getByText("Advanced configuration", { exact: true })
        .click();
      await settings
        .getByRole("button", { name: "Add environment variable" })
        .click();
      await settings.getByLabel("Environment variable name").fill("API_TOKEN");
      await settings
        .getByLabel("Environment variable value for API_TOKEN")
        .fill("${PROJECT_TOKEN}");
      await choose("Tool exposure", "Deferred");
      await settings
        .getByRole("switch", { name: "Enabled in file" })
        .locator("..")
        .click();
      const save = settings.getByRole("button", {
        name: "Save",
        exact: true,
      });
      await save.scrollIntoViewIfNeeded();
      await expect(save).toBeInViewport();
      await save.click();
      await expect(editProject("project-tools")).toBeVisible();
      expect(
        (await fixture.json(fixture.projectFile)).mcpServers["project-tools"],
      ).toEqual({
        command: "node",
        args: ["server with spaces.js"],
        env: { API_TOKEN: "${PROJECT_TOKEN}" },
        exposure: "deferred",
        enabled: false,
      });
      await removeProject("project-tools");
      await expect(editProject("project-tools")).toHaveCount(0);
      // Start without a project entry, then create a policy from the user server.
      await removeProject("docs");
      await settings
        .getByRole("button", { name: "Customize for this project: docs" })
        .click();
      await expect(
        settings.getByRole("combobox", { name: "Tool exposure" }),
      ).toBeFocused();
      await expect(
        settings.getByRole("combobox", { name: "Tool exposure" }),
      ).toHaveText("Inherit from user");
      await expect(
        settings.getByRole("combobox", { name: "Enabled in this project" }),
      ).toHaveText("Inherit from user");
      await expect(save).toBeDisabled();
      await settings.getByRole("button", { name: "Add tool rule" }).click();
      await settings.getByLabel("Tool name or pattern").fill("read_*");
      await expect(save).toBeEnabled();
      await settings
        .getByRole("button", { name: "Remove tool rule 1" })
        .click();
      await expect(save).toBeDisabled();
      await choose("Enabled in this project", "Disabled");
      await save.click();
      const policyEdit = editProject("docs");
      await expect(policyEdit).toBeVisible();
      expect((await fixture.json(fixture.projectFile)).mcpServers.docs).toEqual(
        {
          enabled: false,
        },
      );
      await page.setViewportSize({ width: 568, height: 320 });
      await policyEdit.press("Enter");
      await expectConfigurationField(
        settings.getByRole("combobox", { name: "Tool exposure", exact: true }),
      );
      await choose("Enabled in this project", "Inherit from user");
      await choose("Tool exposure", "Hidden");
      await save.click();
      await expect(policyEdit).toBeVisible();
      expect((await fixture.json(fixture.projectFile)).mcpServers.docs).toEqual(
        {
          exposure: "hidden",
        },
      );
      await removeProject("docs");
      await expect(
        settings.getByRole("button", {
          name: "Customize for this project: docs",
        }),
      ).toBeVisible();
      expect((await fixture.json(fixture.projectFile)).mcpServers).toEqual({});
      expect(await fixture.json(fixture.userFile)).toEqual(userBefore);
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  });
});
