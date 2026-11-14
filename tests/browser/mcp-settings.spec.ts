import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { browserFixtureHome } from "./fixtures/workspace.mjs";
import { expectConfigurationField } from "./support/configuration-form";
import { openSettings, pairedPage } from "./support/navigation";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });

const selectServer = (
  settings: Locator,
  name: string,
  scope: "user" | "project",
) =>
  settings
    .getByRole("combobox", { name: "MCP server" })
    .selectOption({ label: `${name} · ${scope}` });

async function scenario(page: Page, session: "live" | "new") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-browser-mcp-")),
  );
  const cwd = join(root, "project");
  const userFile = join(browserFixtureHome, "agent/mcp.json");
  const projectFile = join(cwd, ".pi/mcp.json");
  const previous = await readFile(userFile).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  const close = async () => {
    if (previous) await writeFile(userFile, previous);
    else await rm(userFile, { force: true });
    await rm(root, { recursive: true, force: true });
  };
  try {
    await mkdir(join(cwd, ".pi"), { recursive: true });
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
      enabled: false,
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
            command: process.execPath,
            args: ["-e", "process.exit(0)", "--", "--secret=stored-argument"],
            env: { TOKEN: "stored-env-secret" },
            description: "Project documentation",
            enabled: false,
            toolExposure: { "read_*": "direct" },
          },
        },
      }),
    );
    let reveals = 0,
      writes = 0,
      reloads = 0;
    if (session === "live")
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path === "/api/mcp-config/connection") reveals++;
        if (path === "/api/mcp-config" && request.method() === "PATCH")
          writes++;
        if (
          path === "/api/control/native-command" &&
          request.postDataJSON()?.command === "reload"
        )
          reloads++;
      });
    await pairedPage(page);
    await page.getByRole("textbox", { name: "Project directory" }).fill(cwd);
    if (session === "live") {
      await page
        .getByRole("textbox", { name: "First message", exact: true })
        .fill("Materialize this session for MCP reload.");
      await page.getByRole("button", { name: "Start session" }).click();
      await expect(
        page.getByText(/The offline provider supplies inline math/),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Abort running task" }),
      ).toHaveCount(0);
    }
    await openSettings(page);
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    await settings.getByRole("button", { name: "MCP", exact: true }).click();
    return {
      close,
      userFile,
      projectFile,
      settings,
      reveals: () => reveals,
      writes: () => writes,
      reloads: () => reloads,
      json: async (path: string) => JSON.parse(await readFile(path, "utf8")),
    };
  } catch (error) {
    await close();
    throw error;
  }
}
test("MCP reveals saved connection values on request, keeps edits scoped, and reloads only on confirmation", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fixture = await scenario(page, "live");
  const { settings } = fixture;
  const edit = (scope: "user" | "project") =>
    settings.getByRole("button", { name: `Edit ${scope} server docs` });
  const save = settings.getByRole("button", { name: "Save", exact: true });
  const advanced = settings.getByText("Advanced configuration", {
    exact: true,
  });
  const description = settings.getByLabel("Description", { exact: true });
  try {
    await selectServer(settings, "docs", "user");
    await edit("user").click();
    const url = settings.getByLabel("Server URL", { exact: true });
    await expect(url).toBeFocused();
    await expect(url).toHaveValue("");
    expect(fixture.reveals()).toBe(0);
    await settings.getByRole("button", { name: "Show saved URL" }).click();
    await expect(url).toHaveValue(/stored-url-secret/);
    await advanced.click();
    await description.fill("Updated documentation");
    await settings
      .getByRole("button", { name: "Conversation", exact: true })
      .click();
    await expect(description).not.toBeVisible();
    await settings.getByRole("button", { name: "MCP", exact: true }).click();
    await expect(description).toHaveValue("Updated documentation");
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
    await save.click();
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
    await expect(registration).toHaveValue("auto");
    await registration.selectOption("cimd");
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
    await expect(edit("user")).toBeFocused();
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
    const confirm = settings.getByRole("button", {
      name: "Reload Pi resources",
      exact: true,
    });
    await expect(confirm).toBeVisible();
    expect(fixture.reloads()).toBe(0);
    const reloaded = page.waitForResponse((response) =>
      response.url().endsWith("/api/control/native-command"),
    );
    await confirm.click();
    const reloadResult = await reloaded;
    expect(reloadResult.ok(), await reloadResult.text()).toBe(true);
    expect(fixture.reloads()).toBe(1);
    // An edit conflict preserves the draft and makes no claim of saving it.
    await selectServer(settings, "docs", "project");
    await edit("project").click();
    const firstArg = settings.getByLabel("Argument 1", { exact: true });
    await expect(firstArg).toHaveCount(0);
    await settings
      .getByRole("button", { name: "Show saved arguments" })
      .click();
    await expect(firstArg).toBeFocused();
    const programArg = settings.getByLabel("Argument 2", { exact: true });
    await expect(programArg).toHaveValue("process.exit(0)");
    await programArg.fill("process.exitCode = 0");
    await advanced.click();
    await settings.getByRole("button", { name: "Remove tool rule 1" }).click();
    const external = await fixture.json(fixture.projectFile);
    external.mcpServers.docs.timeout = 99;
    await writeFile(fixture.projectFile, JSON.stringify(external));
    await save.click();
    await expect(settings.getByRole("alert")).toContainText(
      "changed elsewhere",
    );
    await expect(programArg).toHaveValue("process.exitCode = 0");
    await settings
      .getByRole("button", { name: "Refresh MCP files", exact: true })
      .click();
    await expect(settings.getByRole("alert")).toHaveCount(0);
    await save.click();
    await expect(edit("project")).toBeVisible();
    const project = (await fixture.json(fixture.projectFile)).mcpServers.docs;
    expect(project).toMatchObject({
      timeout: 99,
      args: ["-e", "process.exitCode = 0", "--", "--secret=stored-argument"],
      env: { TOKEN: "stored-env-secret" },
    });
    expect(project.toolExposure).toEqual({});
  } finally {
    await fixture.close();
  }
});
test.describe("touch MCP editor", () => {
  test.use({ hasTouch: true });

  test("New saves and removes project MCP definitions and inherited policy in narrow Settings", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const fixture = await scenario(page, "new");
    const { settings } = fixture;
    const editProject = (name: string) =>
      settings.getByRole("button", {
        name: `Edit project server ${name}`,
        exact: true,
      });
    const removeProject = async (name: string) => {
      await selectServer(settings, name, "project");
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
      await settings
        .getByRole("combobox", { name, exact: true })
        .selectOption({ label: option });
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
      const addArgument = settings.getByRole("button", {
        name: "Add argument",
        exact: true,
      });
      await addArgument.click();
      await settings
        .getByLabel("Argument 1", { exact: true })
        .fill("server with spaces.js");
      await addArgument.click();
      await settings.getByRole("button", { name: "Remove argument 2" }).click();
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
      await selectServer(settings, "docs", "user");
      await settings
        .getByRole("button", { name: "Customize for this project: docs" })
        .click();
      await expect(
        settings.getByRole("combobox", { name: "Tool exposure" }),
      ).toBeFocused();
      await expect(
        settings.getByRole("combobox", { name: "Tool exposure" }),
      ).toHaveValue("inherit");
      await expect(
        settings.getByRole("combobox", { name: "Enabled in this project" }),
      ).toHaveValue("inherit");
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
      await selectServer(settings, "docs", "user");
      await expect(
        settings.getByRole("button", {
          name: "Customize for this project: docs",
        }),
      ).toBeVisible();
      expect((await fixture.json(fixture.projectFile)).mcpServers).toEqual({});
      expect(await fixture.json(fixture.userFile)).toEqual(userBefore);
    } finally {
      await fixture.close();
    }
  });
});
