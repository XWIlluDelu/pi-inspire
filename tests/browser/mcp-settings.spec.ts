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
import { routeSnapshots } from "./support/host-events";
import {
  openFixtureSession,
  openSettings,
  pairedPage,
} from "./support/navigation";

test.use({ serviceWorkers: "block", reducedMotion: "reduce" });

const expectServer = async (
  settings: Locator,
  name: string,
  scope: "user" | "project",
) => {
  await expect(
    settings.getByRole("group", {
      name: `${scope} server ${name}`,
      exact: true,
    }),
  ).toBeVisible();
};

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
      reloads = 0;
    let sessionId = "";
    const transport =
      session === "live"
        ? await routeSnapshots(page, {
            snapshot: ({ active }) => {
              if (active) sessionId = active.sessionId;
            },
          })
        : null;
    if (session === "live")
      page.on("request", (request) => {
        const path = new URL(request.url()).pathname;
        if (path === "/api/mcp-config/connection") reveals++;
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
    const settings = page.getByRole("dialog", {
      name: "Settings",
      exact: true,
    });
    const open = async () => {
      await openSettings(page);
      await settings.getByRole("button", { name: "MCP", exact: true }).click();
    };
    await open();
    return {
      close,
      userFile,
      projectFile,
      settings,
      open,
      worker: (runState: "running" | "idle", external = false) =>
        transport?.send({
          type: "session_status",
          sessionId,
          sessionStatus: { runState, external },
        }),
      reveals: () => reveals,
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
  const fixture = await scenario(page, "live");
  const { settings } = fixture;
  const edit = settings.getByRole("button", { name: "Edit user server docs" });
  const save = settings.getByRole("button", { name: "Save", exact: true });
  const advanced = settings.getByText("Advanced configuration", {
    exact: true,
  });
  const description = settings.getByLabel("Description", { exact: true });
  try {
    await expectServer(settings, "docs", "user");
    await edit.click();
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
    await save.click();
    await expect(
      settings.getByText(
        "MCP settings saved.",
      ),
    ).toBeVisible();
    await expect(edit).toBeFocused();
    expect(fixture.reloads()).toBe(0);
    const saved = (await fixture.json(fixture.userFile)).mcpServers.docs;
    expect(saved.description).toBe("Updated documentation");
    expect(saved.url).toContain("stored-url-secret");
    expect(saved.headers.Authorization).toBe("Bearer stored-header-secret");
    expect(saved.oauth.clientSecret).toBe("stored-oauth-secret");
    await settings
      .getByRole("button", { name: "Reload selected session…" })
      .click();
    const confirm = settings.getByRole("button", {
      name: "Reload Pi resources",
      exact: true,
    });
    fixture.worker("running");
    await expect(confirm).toBeDisabled();
    fixture.worker("idle");
    await expect(confirm).toBeEnabled();
    const reloaded = page.waitForResponse("**/api/control/native-command");
    await confirm.click();
    expect((await reloaded).ok()).toBe(true);
    await expect(confirm).toBeHidden();
    expect(fixture.reloads()).toBe(1);
    fixture.worker("idle", true);
    await expect(
      settings.getByText("Run /reload in the original Pi terminal."),
    ).toBeVisible();
    await expect(
      settings.getByRole("button", { name: "Reload selected session…" }),
    ).toHaveCount(0);

    // Retire the owner with an actual credential reveal in flight.
    const requested = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const delivered = Promise.withResolvers<void>();
    await page.route(
      (url) => url.pathname === "/api/mcp-config/connection",
      async (route) => {
        const response = await route.fetch();
        requested.resolve();
        await release.promise;
        try {
          await route.fulfill({ response });
        } catch {
          /* The old owner's reveal may be canceled at the transport. */
        } finally {
          delivered.resolve();
        }
      },
      { times: 1 },
    );
    await expectServer(settings, "docs", "user");
    await edit.click();
    await settings.getByRole("button", { name: "Show saved URL" }).click();
    try {
      await requested.promise;
      await settings.getByRole("button", { name: "Close settings" }).click();
      await expect(settings).toHaveCount(0);
      await openFixtureSession(
        page,
        /Review extension event lifecycle/,
        "fixture-history",
      );
      await fixture.open();
      await expectServer(settings, "docs", "user");
      await edit.click();
    } finally {
      release.resolve();
    }
    await delivered.promise;
    await expect(
      settings.getByLabel("Server URL", { exact: true }),
    ).toHaveValue("");
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
      await expectServer(settings, name, "project");
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
      await settings
        .getByRole("listbox", { name, exact: true })
        .getByRole("option", { name: option, exact: true })
        .click();
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
      const url = settings.getByLabel("Server URL", { exact: true });
      const privateUrl = "https://user:http-secret@example.invalid/mcp";
      await url.fill(privateUrl);
      await choose("Transport", "Stdio");
      await settings.getByLabel("Program", { exact: true }).fill("node");
      await choose("Transport", "Streamable HTTP");
      await expect(url).toHaveValue(privateUrl);
      await choose("Transport", "Stdio");
      await expect(settings.getByLabel("Program", { exact: true })).toHaveValue(
        "node",
      );
      const save = settings.getByRole("button", {
        name: "Save",
        exact: true,
      });
      await save.click();
      await expect(editProject("project-tools")).toBeVisible();
      expect(
        (await fixture.json(fixture.projectFile)).mcpServers["project-tools"],
      ).toMatchObject({ command: "node" });
      await removeProject("project-tools");
      await expect(editProject("project-tools")).toHaveCount(0);
      // Start without a project entry, then create a policy from the user server.
      await removeProject("docs");
      await expectServer(settings, "docs", "user");
      await settings
        .getByRole("button", { name: "Customize for this project: docs" })
        .click();
      await expect(
        settings.getByRole("combobox", { name: "Tool exposure" }),
      ).toBeFocused();
      await expect(
        settings.getByRole("combobox", { name: "Tool exposure" }),
      ).toContainText("Inherit from user");
      await choose("Enabled in this project", "Disabled");
      await save.click();
      const policyEdit = editProject("docs");
      await expect(policyEdit).toBeVisible();
      expect((await fixture.json(fixture.projectFile)).mcpServers.docs).toEqual(
        {
          enabled: false,
        },
      );
      await removeProject("docs");
      await expectServer(settings, "docs", "user");
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
