// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
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
  fireEvent.submit(
    screen.getByRole("button", { name: "Save" }).closest("form")!,
  );
  await screen.findByText(/Saved to file/);
  return view;
}

it("keeps reload unavailable while the selected session owns a running operation", async () => {
  const view = await savedPanel();
  fireEvent.click(
    screen.getByRole("button", { name: "Reload selected session…" }),
  );
  fixture.state.runState = "running";
  view.rerender(
    <McpSettings active owner={{ sessionId: fixture.state.sessionId }} />,
  );
  expect(
    screen.getByRole("button", { name: "Reload selected session…" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("button", { name: "Reload Pi resources" }),
  ).toBeDisabled();
  expect(screen.getByText(/Wait for the current Pi operation/)).toBeVisible();
  expect(fixture.host.runPaletteNativeCommand).not.toHaveBeenCalled();
  expect(screen.queryByText(/Reload requested/)).toBeNull();
});

it("keeps MCP file editing available for an external owner and directs reload to its terminal", async () => {
  fixture.state.sessionStatuses = {
    one: { runState: "running", external: true, nativeModelControls: true },
  };
  fixture.state.runState = "running";
  await savedPanel();
  expect(
    screen.queryByRole("button", { name: "Reload selected session…" }),
  ).toBeNull();
  expect(
    screen.getByText(
      "Run /reload in the original Pi terminal to apply the saved configuration.",
    ),
  ).toBeVisible();
  expect(screen.getByRole("button", { name: "Add server" })).toBeEnabled();
  expect(fixture.host.runPaletteNativeCommand).not.toHaveBeenCalled();
});

it("reports reload rejection locally instead of claiming it was requested", async () => {
  await savedPanel();
  fireEvent.click(
    screen.getByRole("button", { name: "Reload selected session…" }),
  );
  fixture.host.runPaletteNativeCommand.mockReturnValue(false);
  fireEvent.click(screen.getByRole("button", { name: "Reload Pi resources" }));
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Reload could not be started",
  );
  expect(screen.queryByText(/Reload requested/)).toBeNull();
  fixture.host.runPaletteNativeCommand.mockReturnValue({ accepted: true });
  fireEvent.click(screen.getByRole("button", { name: "Reload Pi resources" }));
  expect(screen.getByText(/Reload requested/)).toBeVisible();
  expect(screen.queryByRole("alert")).toBeNull();
});

it("withdraws reads from the previous session and saves from the previous Host connection", async () => {
  const read = deferred<McpConfigSnapshot>();
  fixture.host.readMcpConfig.mockReturnValueOnce(read.promise);
  const view = render(
    <McpSettings active owner={{ sessionId: fixture.state.sessionId }} />,
  );
  fixture.state = {
    ...fixture.state,
    sessionId: "two",
    cwd: "/two",
    transportGeneration: 1,
  };
  view.rerender(
    <McpSettings active owner={{ sessionId: fixture.state.sessionId }} />,
  );
  await screen.findByRole("button", { name: "Edit user server docs" });
  await act(async () => read.resolve(snapshot("stale")));
  expect(
    screen.queryByRole("button", { name: "Edit user server stale" }),
  ).not.toBeInTheDocument();
  expect(fixture.host.readMcpConfig).toHaveBeenLastCalledWith({
    sessionId: "two",
  });
  fireEvent.click(
    screen.getByRole("button", { name: "Edit user server docs" }),
  );
  fireEvent.change(screen.getByLabelText("Server URL"), {
    target: { value: "https://new.example.invalid/mcp" },
  });
  const save = deferred<unknown>();
  fixture.host.editMcpConfig.mockReturnValueOnce(save.promise);
  fireEvent.submit(
    screen.getByRole("button", { name: "Save" }).closest("form")!,
  );
  fixture.state = { ...fixture.state, transportGeneration: 2 };
  view.rerender(
    <McpSettings active owner={{ sessionId: fixture.state.sessionId }} />,
  );
  await screen.findByRole("button", { name: "Edit user server docs" });
  await act(async () =>
    save.resolve({ saved: true, snapshot: snapshot("old-host-save") }),
  );
  expect(
    screen.queryByRole("button", { name: "Edit user server old-host-save" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByText(/Saved to file/)).not.toBeInTheDocument();
});
it("adds HTTP configuration without copying write-only fields from other entries", async () => {
  render(<McpSettings active owner={{ sessionId: fixture.state.sessionId }} />);
  await screen.findByRole("button", { name: "Edit user server docs" });
  fireEvent.click(screen.getByRole("button", { name: "Add server" }));
  fireEvent.change(screen.getByLabelText("Server name"), {
    target: { value: "new-server" },
  });
  fireEvent.change(screen.getByLabelText("Server URL"), {
    target: { value: "https://new.example.invalid/mcp" },
  });
  fireEvent.submit(
    screen.getByRole("button", { name: "Save" }).closest("form")!,
  );
  await waitFor(() =>
    expect(fixture.host.editMcpConfig).toHaveBeenCalledWith(
      { sessionId: "one" },
      {
        operation: "add",
        scope: "user",
        revision: "a".repeat(64),
        name: "new-server",
        values: { url: "https://new.example.invalid/mcp" },
      },
    ),
  );
});
it.each(["unselected", "unavailable"] as const)(
  "keeps user configuration editable with an %s project",
  async (project) => {
    const config = snapshot();
    if (project === "unselected") {
      config.cwd = null;
      config.files = config.files.filter((file) => file.scope === "user");
    } else {
      Object.assign(config.files[1]!, {
        revision: "",
        error: "Project path does not exist",
      });
    }
    fixture.host.readMcpConfig.mockResolvedValue(config);
    fixture.host.editMcpConfig.mockResolvedValue({
      saved: true,
      snapshot: config,
    });
    render(<McpSettings active owner={{}} />);
    await screen.findByRole("button", { name: "Edit user server docs" });
    if (project === "unselected")
      expect(
        screen.getByText("Select a project to edit project configuration."),
      ).toBeVisible();
    else
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Project path does not exist",
      );
    fireEvent.click(screen.getByRole("button", { name: "Add server" }));
    const target = screen.getByRole("combobox", {
      name: "Configuration target",
    });
    fireEvent.click(target);
    expect(
      screen.getByRole("option", { name: "User · all projects" }),
    ).toBeVisible();
    if (project === "unselected")
      expect(screen.queryByRole("option", { name: "This project" })).toBeNull();
    fireEvent.click(
      screen.getByRole("option", { name: "User · all projects" }),
    );
    fireEvent.change(screen.getByLabelText("Server name"), {
      target: { value: "independent" },
    });
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://example.invalid/mcp" },
    });
    expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
    fireEvent.submit(
      screen.getByRole("button", { name: "Save" }).closest("form")!,
    );
    await waitFor(() =>
      expect(fixture.host.editMcpConfig).toHaveBeenCalledWith(
        {},
        {
          scope: "user",
          name: "independent",
          revision: "a".repeat(64),
          operation: "add",
          values: { url: "https://example.invalid/mcp" },
        },
      ),
    );
    await screen.findByText(/Saved to file/);
    expect(
      screen.queryByRole("button", { name: "Reload selected session…" }),
    ).toBeNull();
  },
);

it("loads a saved URL only on request and keeps it out of untouched edits", async () => {
  fixture.host.readMcpConnection.mockResolvedValue({
    url: "https://docs.example.com/mcp",
  });
  render(<McpSettings active owner={{ sessionId: "one" }} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit user server docs" }),
  );
  expect(screen.getByLabelText("Server URL")).toHaveValue("");
  expect(fixture.host.readMcpConnection).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show saved URL" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Server URL")).toHaveValue(
      "https://docs.example.com/mcp",
    ),
  );
  expect(fixture.host.readMcpConnection).toHaveBeenCalledWith(
    { sessionId: "one" },
    { scope: "user", name: "docs", revision: "a".repeat(64) },
  );
  fireEvent.submit(
    screen.getByRole("button", { name: "Save" }).closest("form")!,
  );
  await waitFor(() =>
    expect(fixture.host.editMcpConfig).toHaveBeenCalledWith(
      { sessionId: "one" },
      expect.objectContaining({ values: {} }),
    ),
  );
});

it("loads saved arguments for a single-item edit without replacing unrelated fields", async () => {
  const config = snapshot();
  Object.assign(config.files[0]!.entries[0]!, {
    transport: "stdio",
    command: "npx",
    urlConfigured: false,
    argumentCount: 4,
  });
  fixture.host.readMcpConfig.mockResolvedValue(config);
  fixture.host.readMcpConnection.mockResolvedValue({
    args: ["-y", "@example/mcp", "--port", "3000"],
  });
  render(<McpSettings active owner={{ sessionId: "one" }} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit user server docs" }),
  );
  expect(screen.queryByLabelText("Argument 1")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Show saved arguments" }));
  await screen.findByLabelText("Argument 4");
  expect(screen.getByLabelText("Argument 1")).toHaveFocus();
  expect(screen.getByLabelText("Argument 2")).toHaveValue("@example/mcp");
  fireEvent.change(screen.getByLabelText("Argument 4"), {
    target: { value: "4000" },
  });
  fireEvent.submit(
    screen.getByRole("button", { name: "Save" }).closest("form")!,
  );
  await waitFor(() =>
    expect(fixture.host.editMcpConfig).toHaveBeenCalledWith(
      { sessionId: "one" },
      expect.objectContaining({
        values: { args: ["-y", "@example/mcp", "--port", "4000"] },
      }),
    ),
  );
});

it("withdraws a pending connection reveal when the Settings owner changes", async () => {
  const pending = deferred<{ url: string }>();
  fixture.host.readMcpConnection.mockReturnValue(pending.promise);
  const view = render(<McpSettings active owner={{ sessionId: "one" }} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit user server docs" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Show saved URL" }));
  fixture.state.sessionId = "two";
  view.rerender(<McpSettings active owner={{ sessionId: "two" }} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit user server docs" }),
  );
  await act(async () => {
    pending.resolve({ url: "https://old-owner.example/mcp" });
  });
  expect(screen.getByLabelText("Server URL")).toHaveValue("");
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
  fireEvent.click(
    screen.getByRole("button", { name: "Remove header Authorization" }),
  );
  fireEvent.submit(form);
  expect(save).toHaveBeenLastCalledWith("user", "new-server", {
    url: "https://example.invalid/mcp",
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

it("shows CIMD registration, keeps incompatible client fields out of valid edits, and requires explicit removal when changing methods", () => {
  const config = snapshot();
  const entry = config.files[0]!.entries[0]!;
  entry.oauthClientRegistration = "cimd";
  entry.oauthFields.push("clientRegistration");
  const save = vi.fn();
  const view = render(
    <McpServerForm
      entry={entry}
      initialScope="user"
      snapshot={config}
      busy={false}
      error={null}
      onSave={save}
      onReadConnection={fixture.host.readMcpConnection}
      onCancel={() => {}}
    />,
  );
  fireEvent.click(screen.getByText("Advanced configuration"));
  fireEvent.click(screen.getByText("OAuth client configuration"));
  expect(
    screen.getByRole("combobox", { name: "Client registration" }),
  ).toHaveTextContent("Pi metadata document (CIMD)");
  expect(screen.queryByLabelText("Client name")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Client ID")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Callback URL"), {
    target: { value: "http://localhost/wrong-path" },
  });
  expect(screen.getByRole("alert")).toHaveTextContent("path /callback");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.change(screen.getByLabelText("Callback URL"), {
    target: { value: "http://localhost/callback" },
  });
  fireEvent.submit(
    screen.getByRole("button", { name: "Save" }).closest("form")!,
  );
  expect(save).toHaveBeenLastCalledWith("user", "docs", {
    oauth: { callbackUrl: "http://localhost/callback" },
  });
  view.unmount();
  entry.oauthClientRegistration = "dcr";
  entry.oauthFields.push("clientId", "clientName");
  render(
    <McpServerForm
      entry={entry}
      initialScope="user"
      snapshot={config}
      busy={false}
      error={null}
      onSave={save}
      onReadConnection={fixture.host.readMcpConnection}
      onCancel={() => {}}
    />,
  );
  fireEvent.click(screen.getByText("Advanced configuration"));
  fireEvent.click(screen.getByText("OAuth client configuration"));
  fireEvent.click(
    screen.getByRole("combobox", { name: "Client registration" }),
  );
  fireEvent.click(
    screen.getByRole("option", { name: "Pi metadata document (CIMD)" }),
  );
  expect(screen.getByRole("alert")).toHaveTextContent(
    "cannot use a client ID or client name",
  );
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  fireEvent.click(screen.getByText("Advanced configuration"));
  expect(screen.getByRole("alert")).toBeVisible();
  fireEvent.click(screen.getByText("Advanced configuration"));
  fireEvent.click(screen.getByLabelText("Remove client id"));
  fireEvent.click(screen.getByLabelText("Remove client name"));
  expect(screen.getByRole("button", { name: "Save" })).toBeEnabled();
  fireEvent.submit(
    screen.getByRole("button", { name: "Save" }).closest("form")!,
  );
  expect(save).toHaveBeenLastCalledWith("user", "docs", {
    oauth: { clientRegistration: "cimd", clientId: null, clientName: null },
  });
});

it("saves tool rules in displayed order and removes deleted rules", () => {
  const config = snapshot();
  const entry = config.files[0]!.entries[0]!;
  entry.toolExposure = { "read_*": "direct", "*": "hidden" };
  const save = vi.fn();
  render(
    <McpServerForm
      entry={entry}
      initialScope="user"
      snapshot={config}
      busy={false}
      error={null}
      onSave={save}
      onReadConnection={fixture.host.readMcpConnection}
      onCancel={() => {}}
    />,
  );
  fireEvent.click(screen.getByText("Advanced configuration"));
  fireEvent.click(screen.getByRole("button", { name: "Remove tool rule 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add tool rule" }));
  fireEvent.change(screen.getAllByLabelText("Tool name or pattern")[1]!, {
    target: { value: "read_*" },
  });
  const form = screen.getByRole("button", { name: "Save" }).closest("form")!;
  fireEvent.submit(form);
  expect(save).toHaveBeenLastCalledWith("user", "docs", {
    toolExposure: { "*": "hidden", "read_*": "codemode" },
  });
  expect(Object.keys(save.mock.calls[0]![2].toolExposure)).toEqual([
    "*",
    "read_*",
  ]);
  fireEvent.click(screen.getByRole("button", { name: "Remove tool rule 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove tool rule 1" }));
  fireEvent.submit(form);
  expect(save).toHaveBeenLastCalledWith("user", "docs", { toolExposure: {} });
});

it("starts a project customization with inherited policy and saves only the chosen override", async () => {
  const config = snapshot();
  fixture.host.editMcpConfig.mockResolvedValue({
    saved: true,
    snapshot: {
      ...config,
      files: [
        config.files[0],
        {
          ...config.files[1],
          entries: [
            {
              ...config.files[0]!.entries[0]!,
              transport: null,
              policyOnly: true,
              enabled: false,
              exposure: null,
              urlConfigured: false,
              headerKeys: [],
              oauthFields: [],
            },
          ],
        },
      ],
    },
  });
  render(<McpSettings active owner={{ sessionId: "one" }} />);
  fireEvent.click(
    await screen.findByRole("button", {
      name: "Customize for this project: docs",
    }),
  );
  const exposure = screen.getByRole("combobox", { name: "Tool exposure" });
  const enabled = screen.getByRole("combobox", {
    name: "Enabled in this project",
  });
  expect(exposure).toHaveFocus();
  expect(exposure).toHaveTextContent("Inherit from user");
  expect(enabled).toHaveTextContent("Inherit from user");
  expect(screen.queryByLabelText("Server name")).not.toBeInTheDocument();
  expect(
    screen.queryByRole("combobox", { name: "Configuration target" }),
  ).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Server URL")).not.toBeInTheDocument();
  const save = screen.getByRole("button", { name: "Save" });
  expect(save).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Add tool rule" }));
  fireEvent.change(screen.getByLabelText("Tool name or pattern"), {
    target: { value: "read_*" },
  });
  expect(save).toBeEnabled();
  fireEvent.click(screen.getByRole("button", { name: "Remove tool rule 1" }));
  expect(save).toBeDisabled();
  fireEvent.submit(save.closest("form")!);
  expect(fixture.host.editMcpConfig).not.toHaveBeenCalled();
  fireEvent.click(enabled);
  fireEvent.click(screen.getByRole("option", { name: "Disabled" }));
  fireEvent.submit(
    screen.getByRole("button", { name: "Save" }).closest("form")!,
  );
  await screen.findByRole("button", { name: "Edit project server docs" });
  expect(fixture.host.editMcpConfig).toHaveBeenCalledWith(
    { sessionId: "one" },
    {
      scope: "project",
      name: "docs",
      revision: config.files[1]!.revision,
      operation: "add",
      values: { enabled: false },
    },
  );
  expect(
    screen.queryByRole("button", { name: "Customize for this project: docs" }),
  ).not.toBeInTheDocument();
  expect(fixture.host.runPaletteNativeCommand).not.toHaveBeenCalled();
});

it("focuses and edits project policy overrides without introducing connection settings", async () => {
  const config = snapshot();
  config.files[1]!.entries = [
    {
      name: "docs",
      transport: null,
      policyOnly: true,
      enabled: false,
      exposure: null,
      urlConfigured: false,
      argumentCount: 0,
      envKeys: [],
      headerKeys: [],
      oauthFields: [],
      toolExposure: {},
      extraFieldCount: 0,
    },
  ];
  fixture.host.readMcpConfig.mockResolvedValue(config);
  render(<McpSettings active owner={{ sessionId: fixture.state.sessionId }} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit project server docs" }),
  );
  expect(screen.getByRole("combobox", { name: "Tool exposure" })).toHaveFocus();
  expect(screen.queryByLabelText("Server URL")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Program")).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Timeout (seconds)")).not.toBeInTheDocument();
  expect(
    screen.getByRole("combobox", { name: "Tool exposure" }),
  ).toHaveTextContent("Inherit from user");
  fireEvent.click(
    screen.getByRole("combobox", { name: "Enabled in this project" }),
  );
  fireEvent.click(screen.getByRole("option", { name: "Inherit from user" }));
  fireEvent.click(screen.getByRole("combobox", { name: "Tool exposure" }));
  fireEvent.click(screen.getByRole("option", { name: "Hidden" }));
  fireEvent.submit(
    screen.getByRole("button", { name: "Save" }).closest("form")!,
  );
  await waitFor(() =>
    expect(fixture.host.editMcpConfig).toHaveBeenCalledWith(
      { sessionId: "one" },
      {
        operation: "update",
        scope: "project",
        name: "docs",
        revision: "b".repeat(64),
        values: { enabled: null, exposure: "hidden" },
      },
    ),
  );
});

it("rejects duplicate header names rather than silently discarding one value", async () => {
  render(<McpSettings active owner={{ sessionId: fixture.state.sessionId }} />);
  fireEvent.click(
    await screen.findByRole("button", { name: "Edit user server docs" }),
  );
  fireEvent.click(screen.getByText("Advanced configuration"));
  fireEvent.click(screen.getByRole("button", { name: "Add header" }));
  const names = screen.getAllByLabelText("Header name");
  fireEvent.change(names[1]!, { target: { value: "Authorization" } });
  expect((names[1] as HTMLInputElement).validationMessage).toMatch(/unique/);
  fireEvent.change(names[1]!, { target: { value: "X-Custom" } });
  expect((names[1] as HTMLInputElement).checkValidity()).toBe(true);
  expect((names[0] as HTMLInputElement).checkValidity()).toBe(true);
});
