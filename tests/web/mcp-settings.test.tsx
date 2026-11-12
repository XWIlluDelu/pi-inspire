// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { RunState, SessionRuntimeStatus } from "../../shared/contracts";
import type { McpConfigSnapshot } from "../../shared/mcp";
import { McpServerForm } from "../../src/components/McpServerForm";
import { McpSettings } from "../../src/components/McpSettings";
import { deferred } from "./helpers";

const fixture = vi.hoisted(() => ({
  state: {
    sessionId: "one",
    cwd: "/one",
    transportGeneration: 1,
    runState: "idle" as RunState,
    readOnlyReason: null as string | null,
    sessionStatuses: {} as Record<string, SessionRuntimeStatus>,
  },
  host: {
    readMcpConfig: vi.fn(),
    readMcpConnection: vi.fn(),
    editMcpConfig: vi.fn(),
    runPaletteNativeCommand: vi.fn(),
    getState: vi.fn(),
  },
}));
vi.mock("../../src/store", () => ({
  store: fixture.host,
  useAppState: (selector: (state: typeof fixture.state) => unknown) =>
    selector(fixture.state),
  shallowEqual: () => false,
}));
function snapshot(name = "docs"): McpConfigSnapshot {
  return {
    cwd: fixture.state.cwd,
    files: [
      {
        scope: "user",
        path: "/agent/mcp.json",
        revision: "a".repeat(64),
        entries: [
          {
            name,
            transport: "http",
            policyOnly: false,
            enabled: true,
            exposure: "codemode",
            urlConfigured: true,
            argumentCount: 0,
            envKeys: [],
            headerKeys: ["Authorization"],
            oauthFields: ["clientSecret"],
            toolExposure: {},
            extraFieldCount: 0,
          },
        ],
      },
      {
        scope: "project",
        path: "/one/.pi/mcp.json",
        revision: "b".repeat(64),
        entries: [],
      },
    ],
  };
}
beforeEach(() => {
  for (const mock of Object.values(fixture.host)) mock.mockReset();
  fixture.state = {
    sessionId: "one",
    cwd: "/one",
    transportGeneration: 1,
    runState: "idle",
    readOnlyReason: null,
    sessionStatuses: {},
  };
  fixture.host.getState.mockImplementation(() => fixture.state);
  fixture.host.readMcpConfig.mockResolvedValue(snapshot());
  fixture.host.editMcpConfig.mockResolvedValue({
    saved: true,
    snapshot: snapshot("new-server"),
  });
});
async function savedPanel() {
  const view = render(
    <McpSettings active owner={{ sessionId: fixture.state.sessionId }} />,
  );
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit user server docs" }),
  );
  fireEvent.change(screen.getByLabelText("Server URL"), {
    target: { value: "https://new.example.invalid/mcp" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/Saved to file/);
  return view;
}

it("rechecks the worker before reloading and reports a declined dispatch", async () => {
  const view = await savedPanel();
  fireEvent.click(
    screen.getByRole("button", { name: "Reload selected session…" }),
  );
  const reload = screen.getByRole("button", { name: "Reload Pi resources" });

  fixture.state.runState = "running";
  view.rerender(<McpSettings active owner={{ sessionId: "one" }} />);
  expect(reload).toBeDisabled();
  expect(screen.getByText(/Wait for Pi to finish/)).toBeVisible();
  expect(fixture.host.runPaletteNativeCommand).not.toHaveBeenCalled();

  fixture.state.runState = "idle";
  view.rerender(<McpSettings active owner={{ sessionId: "one" }} />);
  fixture.host.runPaletteNativeCommand.mockReturnValue(false);
  fireEvent.click(reload);
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Reload could not be started",
  );
  expect(screen.queryByText(/Reload requested/)).toBeNull();
});

it("keeps MCP file editing available for an external owner and directs reload to its terminal", async () => {
  fixture.state.sessionStatuses = {
    one: { runState: "running", external: true },
  };
  fixture.state.runState = "running";
  await savedPanel();
  expect(
    screen.queryByRole("button", { name: "Reload selected session…" }),
  ).toBeNull();
  expect(
    screen.getByText("Run /reload in the original Pi terminal."),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Add server" })).toBeEnabled();
  expect(fixture.host.runPaletteNativeCommand).not.toHaveBeenCalled();
});

it("retires old session reads and connection reveals and previous Host saves", async () => {
  const read = deferred<McpConfigSnapshot>();
  const save = deferred<unknown>();
  const reveal = deferred<{ url: string }>();
  fixture.host.readMcpConfig.mockReturnValueOnce(read.promise);
  fixture.host.editMcpConfig.mockReturnValueOnce(save.promise);
  fixture.host.readMcpConnection.mockReturnValueOnce(reveal.promise);
  const panel = () => (
    <McpSettings active owner={{ sessionId: fixture.state.sessionId }} />
  );
  const view = render(panel());
  fixture.state = { ...fixture.state, sessionId: "two", cwd: "/two" };
  view.rerender(panel());

  const edit = () =>
    screen.findByRole("button", { name: "Edit user server docs" });
  await edit();
  await act(async () => read.resolve(snapshot("stale")));
  expect(
    screen.queryByRole("button", { name: "Edit user server stale" }),
  ).toBeNull();
  expect(fixture.host.readMcpConfig).toHaveBeenLastCalledWith({
    sessionId: "two",
  });

  fireEvent.click(await edit());
  const url = () => screen.getByLabelText("Server URL");
  fireEvent.click(screen.getByRole("button", { name: "Show saved URL" }));
  expect(fixture.host.readMcpConnection).toHaveBeenCalledOnce();
  fixture.state = { ...fixture.state, sessionId: "three", cwd: "/three" };
  view.rerender(panel());
  fireEvent.click(await edit());
  await act(async () =>
    reveal.resolve({ url: "https://old-owner.example/mcp" }),
  );
  expect(url()).toHaveValue("");

  fireEvent.change(url(), {
    target: { value: "https://new.example.invalid/mcp" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(fixture.host.editMcpConfig).toHaveBeenCalledOnce();
  fixture.state = { ...fixture.state, transportGeneration: 2 };
  view.rerender(panel());
  await edit();
  await act(async () =>
    save.resolve({ saved: true, snapshot: snapshot("old-host-save") }),
  );
  expect(
    screen.queryByRole("button", { name: "Edit user server old-host-save" }),
  ).toBeNull();
  expect(screen.queryByText(/Saved to file/)).toBeNull();
});

it("can save the user file while the project file is unavailable", async () => {
  const config = snapshot();
  Object.assign(config.files[1]!, {
    revision: "",
    error: "Project path does not exist",
  });
  fixture.host.readMcpConfig.mockResolvedValue(config);
  render(<McpSettings active owner={{ cwd: "/one" }} />);
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Project path does not exist",
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Edit user server docs" }),
  );
  fireEvent.change(screen.getByLabelText("Server URL"), {
    target: { value: "https://example.invalid/mcp" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByText(/Saved to file/);
  expect(fixture.host.editMcpConfig).toHaveBeenCalledWith(
    { cwd: "/one" },
    expect.objectContaining({
      scope: "user",
      name: "docs",
      values: { url: "https://example.invalid/mcp" },
    }),
  );
  expect(
    screen.queryByRole("button", { name: "Reload selected session…" }),
  ).toBeNull();
});

it("preserves secret drafts across transport changes and saves only the selected transport", () => {
  const save = vi.fn();
  render(
    <McpServerForm
      entry={null}
      initialScope="user"
      snapshot={snapshot()}
      busy={false}
      error={null}
      onSave={save}
      onReadConnection={fixture.host.readMcpConnection}
      onCancel={() => {}}
    />,
  );
  fireEvent.change(screen.getByLabelText("Server name"), {
    target: { value: "new-server" },
  });
  fireEvent.change(screen.getByLabelText("Server URL"), {
    target: { value: "https://example.invalid/mcp" },
  });
  fireEvent.click(screen.getByText("Advanced configuration"));
  fireEvent.click(screen.getByRole("button", { name: "Add header" }));
  fireEvent.change(screen.getByLabelText("Header name"), {
    target: { value: "Authorization" },
  });
  fireEvent.change(screen.getByLabelText("Header value for Authorization"), {
    target: { value: "header-secret" },
  });
  fireEvent.click(screen.getByRole("combobox", { name: "Transport" }));
  fireEvent.click(screen.getByRole("option", { name: "Stdio" }));
  fireEvent.change(screen.getByLabelText("Program"), {
    target: { value: "mcp-server" },
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Add environment variable" }),
  );
  fireEvent.change(screen.getByLabelText("Environment variable name"), {
    target: { value: "API_KEY" },
  });
  fireEvent.change(
    screen.getByLabelText("Environment variable value for API_KEY"),
    {
      target: { value: "env-secret" },
    },
  );

  fireEvent.click(screen.getByRole("combobox", { name: "Transport" }));
  fireEvent.click(screen.getByRole("option", { name: "Streamable HTTP" }));
  expect(screen.getByLabelText("Header value for Authorization")).toHaveValue(
    "header-secret",
  );
  const form = screen.getByRole("button", { name: "Save" }).closest("form")!;
  fireEvent.submit(form);
  expect(save).toHaveBeenLastCalledWith("user", "new-server", {
    url: "https://example.invalid/mcp",
    headers: { Authorization: "header-secret" },
  });
  fireEvent.click(screen.getByRole("combobox", { name: "Transport" }));
  fireEvent.click(screen.getByRole("option", { name: "Stdio" }));
  expect(
    screen.getByLabelText("Environment variable value for API_KEY"),
  ).toHaveValue("env-secret");
  fireEvent.submit(form);
  expect(save).toHaveBeenLastCalledWith("user", "new-server", {
    command: "mcp-server",
    env: { API_KEY: "env-secret" },
  });
});
