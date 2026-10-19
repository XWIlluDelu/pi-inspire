// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import type { RunState } from "../../shared/contracts";
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
  },
  host: {
    readMcpConfig: vi.fn(),
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
    screen.getByRole("button", { name: "Save configuration" }).closest("form")!,
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
    screen.getByRole("button", { name: "Save configuration" }).closest("form")!,
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
    screen.getByRole("button", { name: "Save configuration" }).closest("form")!,
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
    expect(
      screen.getByRole("button", { name: "Save configuration" }),
    ).toBeEnabled();
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Save configuration" })
        .closest("form")!,
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
  const form = screen
    .getByRole("button", { name: "Save configuration" })
    .closest("form")!;
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
      onCancel={() => {}}
    />,
  );
  fireEvent.click(screen.getByText("Advanced configuration"));
  fireEvent.click(screen.getByRole("button", { name: "Remove tool rule 1" }));
  fireEvent.click(screen.getByRole("button", { name: "Add tool rule" }));
  fireEvent.change(screen.getAllByLabelText("Tool name or pattern")[1]!, {
    target: { value: "read_*" },
  });
  const form = screen
    .getByRole("button", { name: "Save configuration" })
    .closest("form")!;
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
    screen.getByRole("button", { name: "Save configuration" }).closest("form")!,
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
