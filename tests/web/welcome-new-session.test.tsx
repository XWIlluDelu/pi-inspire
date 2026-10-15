// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { McpConfigSnapshot } from "../../shared/mcp";
import type { ModelCatalogResponse } from "../../shared/model-settings";
import { ApiError } from "../../src/api";
import { App } from "../../src/App";
import { Composer } from "../../src/components/Composer";
import { Welcome } from "../../src/components/Welcome";
import {
  sessionDraft,
  setSessionDraft,
  setStartDraft,
} from "../../src/session-drafts";
import { store, useAppState } from "../../src/store";
import { mockModelMenuLayout } from "./fixtures/model-menu-layout";
import { modelSettingsSnapshot } from "./fixtures/model-settings";
import { sessionPage } from "./fixtures/session-catalog";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
} from "./helpers";

let newSessionBody: Record<string, unknown> | null;
let promptBody: Record<string, unknown> | null;
let promptGate: Promise<RouteResponse> | null = null;
const canonicalProjectCwd = "/canonical/proj";
let defaultModelCwd: string | null;
let defaultModelAvailable: boolean;
let projectFileCwd: string | null;
let directoryFailure: "missing" | "file" | null = null;

beforeAll(async () => {
  newSessionBody = null;
  promptBody = null;
  defaultModelCwd = null;
  defaultModelAvailable = true;
  projectFileCwd = null;
  installFakeWebSocket();
  Object.defineProperty(URL, "createObjectURL", {
    configurable: true,
    value: vi.fn(() => "blob:welcome-image"),
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    configurable: true,
    value: vi.fn(),
  });
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          availableModels: [
            {
              provider: "plain",
              id: "text-only",
              name: "Text only",
              reasoning: false,
            },
            {
              provider: "anthropic",
              id: "claude-sonnet-4",
              name: "Claude Sonnet 4",
              reasoning: true,
            },
          ],
        }),
      };
    if (url.startsWith("/api/new-session/thinking")) {
      if (directoryFailure === "missing")
        return {
          status: 400,
          body: {
            error: "Project path does not exist",
            code: "PROJECT_DIRECTORY_MISSING",
          },
        };
      const query = new URL(url, "http://local").searchParams;
      return { body: { level: query.get("current") ?? "high" } };
    }
    if (url.startsWith("/api/models")) {
      const parsed = new URL(url, "http://local");
      if (directoryFailure && parsed.searchParams.has("sessionId"))
        return {
          status: 409,
          body: {
            error:
              "This session is read-only because its project folder is unavailable",
            code: "SESSION_WORKSPACE_UNAVAILABLE",
          },
        };
      if (directoryFailure)
        return {
          status: 400,
          body:
            directoryFailure === "missing"
              ? {
                  error: "Project path does not exist",
                  code: "PROJECT_DIRECTORY_MISSING",
                }
              : { error: "Project path is not a directory" },
        };
      defaultModelCwd = parsed.searchParams.get("cwd");
      return {
        body: {
          models: store.getState().availableModels,
          defaults: {
            cwd: defaultModelCwd,
            model: defaultModelAvailable
              ? {
                  provider: "anthropic",
                  id: "claude-sonnet-4",
                  name: "Claude Sonnet 4",
                  reasoning: true,
                }
              : null,
            thinkingLevel: "high",
          },
        },
      };
    }
    if (url.startsWith("/api/new-session/files")) {
      const parsed = new URL(url, "http://local");
      projectFileCwd = parsed.searchParams.get("cwd");
      return {
        body: {
          cwd: canonicalProjectCwd,
          files: [{ path: "src/index.ts", name: "index.ts" }],
        },
      };
    }
    if (url.startsWith("/api/sessions/deselect"))
      return { body: { active: null, runState: "idle", sessionStatuses: {} } };
    if (url.startsWith("/api/sessions/new")) {
      newSessionBody = jsonBody(init);
      return {
        body: activeSnapshot({
          sessionId: "new-session",
          model: {
            provider: "anthropic",
            id: "claude-sonnet-4",
            reasoning: true,
          },
          thinkingLevel: "high",
          availableModels: [
            {
              provider: "plain",
              id: "text-only",
              name: "Text only",
              reasoning: false,
            },
            {
              provider: "anthropic",
              id: "claude-sonnet-4",
              name: "Claude Sonnet 4",
              reasoning: true,
            },
          ],
        }),
      };
    }
    if (url.startsWith("/api/attachments"))
      return {
        body: {
          attachments: [
            {
              id: "3a5f1d6c-420d-48ef-a9df-8ae77db183ca",
              fileName: "image.png",
              mimeType: "image/png",
              size: 3,
              kind: "image",
            },
          ],
        },
      };
    if (url.startsWith("/api/prompt")) {
      promptBody = jsonBody(init);
      return promptGate ?? { status: 202, body: { accepted: true } };
    }
    if (url.startsWith("/api/sessions/refresh")) return { body: { ok: true } };
    if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
    if (url.startsWith("/api/preferences"))
      return { body: { ...bootstrapPayload().preferences, ...jsonBody(init) } };
    return undefined;
  });
  await store.init("token");
  FakeWebSocket.instances.at(-1)?.open();
});

beforeEach(mockModelMenuLayout);

afterEach(() => {
  directoryFailure = null;
  defaultModelAvailable = true;
  promptGate = null;
  setStartDraft("");
});

describe("new-session start surface", () => {
  it("addresses Models and MCP settings with New's selected directory before creating a session", async () => {
    act(() =>
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({ sessionId: "source", cwd: "/source" }),
      }),
    );
    const config: McpConfigSnapshot = {
      cwd: "/prospective",
      files: [
        {
          scope: "user",
          path: "/agent/mcp.json",
          revision: "a".repeat(64),
          entries: [],
        },
        {
          scope: "project",
          path: "/prospective/.pi/mcp.json",
          revision: "b".repeat(64),
          entries: [],
        },
      ],
    };
    const models = vi
      .spyOn(store, "readModelSettings")
      .mockResolvedValue(modelSettingsSnapshot());
    vi.spyOn(store, "providerAuth").mockResolvedValue([]);
    const read = vi.spyOn(store, "readMcpConfig").mockResolvedValue(config);
    const save = vi.spyOn(store, "editMcpConfig").mockResolvedValue({
      saved: true,
      snapshot: config,
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    fireEvent.change(
      await screen.findByRole("textbox", { name: "Project directory" }),
      { target: { value: " /prospective " } },
    );
    await waitFor(() => expect(defaultModelCwd).toBe("/prospective"));
    expect(store.getState().sessionId).toBeNull();
    expect(store.getState().cwd).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const navigation = await screen.findByRole("navigation", {
      name: "Settings categories",
    });
    fireEvent.click(within(navigation).getByRole("button", { name: "Models" }));
    await waitFor(() =>
      expect(models).toHaveBeenLastCalledWith({ cwd: "/prospective" }),
    );
    fireEvent.click(within(navigation).getByRole("button", { name: "MCP" }));
    fireEvent.click(await screen.findByRole("button", { name: "Add server" }));
    expect(read).toHaveBeenLastCalledWith({ cwd: "/prospective" });
    fireEvent.change(screen.getByLabelText("Server name"), {
      target: { value: "project-tools" },
    });
    fireEvent.change(screen.getByLabelText("Server URL"), {
      target: { value: "https://example.invalid/mcp" },
    });
    fireEvent.click(
      screen.getByRole("combobox", { name: "Configuration target" }),
    );
    fireEvent.click(screen.getByRole("option", { name: "This project" }));
    fireEvent.submit(
      screen
        .getByRole("button", { name: "Save configuration" })
        .closest("form")!,
    );
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith(
        { cwd: "/prospective" },
        {
          operation: "add",
          scope: "project",
          revision: "b".repeat(64),
          name: "project-tools",
          values: { url: "https://example.invalid/mcp" },
        },
      ),
    );
  });

  it("offers explicit directory creation without a model preview and sends the preserved first message", async () => {
    directoryFailure = "missing";
    newSessionBody = null;
    promptBody = null;
    act(() =>
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      }),
    );
    render(<Welcome />);
    const message = screen.getByRole("textbox", { name: "First message" });
    fireEvent.change(
      screen.getByRole("textbox", { name: "Project directory" }),
      {
        target: { value: "/projects/new/nested" },
      },
    );
    fireEvent.change(message, { target: { value: "Keep this first message" } });
    const create = await screen.findByRole("button", {
      name: "Create folder and start",
    });
    expect(create).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Start session" }),
    ).toBeDisabled();
    fireEvent.keyDown(message, {
      key: "Enter",
      ctrlKey: store.getState().prefs.desktopSendKey === "mod-enter",
    });
    expect(newSessionBody).toBeNull();
    fireEvent.click(create);
    await waitFor(() =>
      expect(newSessionBody).toEqual({
        cwd: "/projects/new/nested",
        createDirectory: true,
      }),
    );
    await waitFor(() =>
      expect(promptBody?.message).toBe("Keep this first message"),
    );
  });

  it.each(["missing", "file"] as const)(
    "preflights New independently of its read-only history source when the folder is %s",
    async (kind) => {
      directoryFailure = kind;
      act(() =>
        FakeWebSocket.instances.at(-1)!.emit({
          type: "snapshot",
          data: activeSnapshot({
            sessionId: "archived",
            cwd: "/archived/project",
            readOnlyReason: "workspace-unavailable",
            model: {
              provider: "anthropic",
              id: "claude-sonnet-4",
              reasoning: true,
            },
            thinkingLevel: "high",
          }),
        }),
      );
      const read = vi.spyOn(store, "readNewSessionModels");
      const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
      render(<App />);
      fireEvent.click(screen.getByRole("button", { name: "New session" }));
      fireEvent.change(
        await screen.findByRole("textbox", { name: "First message" }),
        { target: { value: "Start independent work" } },
      );
      await waitFor(() =>
        expect(read).toHaveBeenCalledWith(undefined, "/archived/project"),
      );
      expect(read).not.toHaveBeenCalledWith("archived", "/archived/project");
      expect(
        screen.getByRole("combobox", { name: "Thinking level" }),
      ).toHaveTextContent("high");
      if (kind === "missing") {
        const create = await screen.findByRole("button", {
          name: "Create folder and start",
        });
        expect(create).toBeEnabled();
        expect(
          screen.getByRole("button", { name: "Start session" }),
        ).toBeDisabled();
        fireEvent.click(create);
        await waitFor(() =>
          expect(start).toHaveBeenCalledWith("/archived/project", {
            createDirectory: true,
            model: { provider: "anthropic", id: "claude-sonnet-4" },
            thinkingLevel: "high",
          }),
        );
      } else {
        expect(
          screen.queryByRole("button", { name: "Create folder and start" }),
        ).toBeNull();
        expect(start).not.toHaveBeenCalled();
      }
    },
  );

  it("preserves inherited model, effort, draft and attachment on failed directory creation", async () => {
    directoryFailure = "missing";
    act(() =>
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      }),
    );
    render(
      <Welcome
        inherited={{
          cwd: "/existing",
          model: {
            provider: "anthropic",
            id: "claude-sonnet-4",
            reasoning: true,
          },
          thinkingLevel: "high",
          commands: [],
        }}
      />,
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Project directory" }),
      {
        target: { value: "/projects/missing" },
      },
    );
    const message = screen.getByRole("textbox", { name: "First message" });
    fireEvent.change(message, { target: { value: "Retain this work" } });
    fireEvent.change(
      screen.getByLabelText("Attach files", { selector: "input" }),
      {
        target: {
          files: [new File(["image"], "retained.png", { type: "image/png" })],
        },
      },
    );
    const create = await screen.findByRole("button", {
      name: "Create folder and start",
    });
    const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
    try {
      fireEvent.click(create);
      await waitFor(() =>
        expect(start).toHaveBeenCalledWith("/projects/missing", {
          createDirectory: true,
          model: { provider: "anthropic", id: "claude-sonnet-4" },
          thinkingLevel: "high",
        }),
      );
      await waitFor(() => expect(create).toBeEnabled());
      expect(message).toHaveValue("Retain this work");
      expect(
        screen.getByRole("button", { name: "Remove attached image" }),
      ).toBeEnabled();
    } finally {
      start.mockRestore();
    }
  });

  it.each([false, true])(
    "starts with an explicitly selected model and manual effort=%s without guessing unresolved defaults",
    async (manualEffort) => {
      directoryFailure = "missing";
      act(() =>
        FakeWebSocket.instances.at(-1)!.emit({
          type: "snapshot",
          data: { active: null, runState: "idle", sessionStatuses: {} },
        }),
      );
      render(<Welcome />);
      fireEvent.change(
        screen.getByRole("textbox", { name: "Project directory" }),
        { target: { value: "/new-project" } },
      );
      fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
        target: { value: "Use this model" },
      });
      const create = await screen.findByRole("button", {
        name: "Create folder and start",
      });
      fireEvent.click(screen.getByRole("button", { name: "Model" }));
      fireEvent.click(
        within(
          screen.getByRole("listbox", { name: "Available models" }),
        ).getByRole("option", { name: /Claude Sonnet 4/ }),
      );
      await waitFor(() =>
        expect(
          screen.getByRole("combobox", { name: "Thinking level" }),
        ).toHaveTextContent("default"),
      );
      if (manualEffort) {
        fireEvent.click(
          screen.getByRole("combobox", { name: "Thinking level" }),
        );
        fireEvent.click(screen.getByRole("option", { name: "high" }));
      }
      const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
      try {
        fireEvent.click(create);
        await waitFor(() =>
          expect(start).toHaveBeenCalledWith("/new-project", {
            createDirectory: true,
            model: { provider: "anthropic", id: "claude-sonnet-4" },
            ...(manualEffort ? { thinkingLevel: "high" } : {}),
          }),
        );
      } finally {
        start.mockRestore();
      }
    },
  );

  it("does not offer creation for a path blocked by a regular file", async () => {
    directoryFailure = "file";
    act(() =>
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      }),
    );
    render(<Welcome />);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Project directory" }),
      {
        target: { value: "/file/project" },
      },
    );
    fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
      target: { value: "Do not replace this file" },
    });
    await screen.findByText("Project path is not a directory");
    expect(
      screen.queryByRole("button", { name: "Create folder and start" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Start session" }),
    ).toBeDisabled();
  });

  it("retires a late missing-directory observation after the user chooses another path", async () => {
    act(() =>
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      }),
    );
    const gate = deferred<ModelCatalogResponse>();
    const readModels = store.readNewSessionModels;
    const read = vi
      .spyOn(store, "readNewSessionModels")
      .mockImplementation((id, cwd, inherit) =>
        cwd === "/stale-project" ? gate.promise : readModels(id, cwd, inherit),
      );
    try {
      render(<Welcome />);
      const directory = screen.getByRole("textbox", {
        name: "Project directory",
      });
      fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
        target: { value: "Keep this draft" },
      });
      fireEvent.change(directory, { target: { value: "/stale-project" } });
      await waitFor(() =>
        expect(read).toHaveBeenCalledWith(undefined, "/stale-project"),
      );
      fireEvent.change(directory, { target: { value: "/valid-project" } });
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Start session" }),
        ).toBeEnabled(),
      );
      await act(async () => {
        gate.reject(
          new ApiError(
            400,
            "Project path does not exist",
            undefined,
            "PROJECT_DIRECTORY_MISSING",
          ),
        );
      });
      expect(
        screen.queryByRole("button", { name: "Create folder and start" }),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Start session" }),
      ).toBeEnabled();
    } finally {
      read.mockRestore();
    }
  });

  it("keeps directory Enter from creating a session without taking message autofocus or submission", async () => {
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      });
    });
    render(<Welcome />);
    const browse = screen.getByRole("button", {
      name: "Browse host directories",
    });
    const directory = screen.getByRole("textbox", {
      name: "Project directory",
    });
    const message = screen.getByRole("textbox", { name: "First message" });
    expect(message).toHaveFocus();
    expect(browse).toHaveAttribute("type", "button");

    fireEvent.change(directory, { target: { value: "/proj" } });
    fireEvent.change(message, { target: { value: "Review calibration" } });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start session" }),
      ).toBeEnabled(),
    );

    const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
    try {
      directory.focus();
      expect(fireEvent.keyDown(directory, { key: "Enter" })).toBe(false);
      expect(start).not.toHaveBeenCalled();
      expect(message).toHaveValue("Review calibration");
      expect(
        fireEvent.keyDown(directory, { key: "Enter", isComposing: true }),
      ).toBe(true);
      expect(fireEvent.keyDown(directory, { key: "Enter", keyCode: 229 })).toBe(
        true,
      );
      message.focus();
      fireEvent.keyDown(message, {
        key: "Enter",
        ctrlKey: store.getState().prefs.desktopSendKey === "mod-enter",
      });
      await waitFor(() => expect(start).toHaveBeenCalledWith("/proj", {}));
    } finally {
      start.mockRestore();
    }
  });

  it("expands with the first message and sends explicit model/effort startup choices", async () => {
    render(<Welcome />);
    const message = screen.getByLabelText(
      "First message",
    ) as HTMLTextAreaElement;
    Object.defineProperty(message, "scrollHeight", {
      configurable: true,
      value: 180,
    });
    fireEvent.change(message, { target: { value: "Investigate the runtime" } });
    await waitFor(() => expect(message.style.height).toBe("180px"));

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    let models = screen.getByRole("listbox", { name: "Available models" });
    fireEvent.click(
      within(models).getByRole("option", { name: /Text only.*No thinking/ }),
    );
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toHaveTextContent("unavailable");

    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    models = screen.getByRole("listbox", { name: "Available models" });
    fireEvent.click(
      within(models).getByRole("option", { name: /Claude Sonnet 4/ }),
    );
    fireEvent.click(screen.getByRole("combobox", { name: "Thinking level" }));
    fireEvent.click(
      within(screen.getByRole("listbox", { name: "Thinking level" })).getByRole(
        "option",
        { name: "high" },
      ),
    );

    const pasted = new File(["png"], "image.png", { type: "image/png" });
    fireEvent.paste(message, {
      clipboardData: {
        files: [pasted],
        items: [{ kind: "file", getAsFile: () => pasted }],
      },
    });
    expect(
      screen.getByRole("button", { name: "Preview image.png" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("image.png")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/proj" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start session" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));

    await waitFor(() =>
      expect(newSessionBody).toEqual({
        cwd: "/proj",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        thinkingLevel: "high",
      }),
    );
    await waitFor(() =>
      expect(promptBody).toMatchObject({
        sessionId: "new-session",
        message: "Investigate the runtime",
        attachmentIds: ["3a5f1d6c-420d-48ef-a9df-8ae77db183ca"],
      }),
    );
    // Welcome -> store -> selection does not pin the project. Storage
    // continuity belongs to Host discovery, not navigation curation.
    expect(store.getState().prefs.pinnedProjectCwds).not.toContain("/proj");
  });

  it("hands off a mixed first message before its receipt and retries unknown delivery unchanged", async () => {
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      });
    });
    const receipt = deferred<RouteResponse>();
    promptGate = receipt.promise;
    promptBody = null;
    function Surface() {
      return useAppState((state) => state.sessionId) ? (
        <Composer />
      ) : (
        <Welcome />
      );
    }
    render(<Surface />);
    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/proj" },
    });
    fireEvent.change(screen.getByLabelText("First message"), {
      target: { value: "Inspect the attached image" },
    });
    fireEvent.change(
      screen.getByLabelText("Attach files", { selector: "input" }),
      {
        target: {
          files: [new File(["png"], "image.png", { type: "image/png" })],
        },
      },
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start session" }),
      ).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(promptBody).not.toBeNull());
    const original = promptBody;
    expect(original).toMatchObject({
      message: "Inspect the attached image",
      attachmentIds: ["3a5f1d6c-420d-48ef-a9df-8ae77db183ca"],
    });
    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Send message" })).toBeDisabled();
    expect(store.getState().sending).toBe(true);

    await act(async () => {
      receipt.reject(new TypeError("Lost receipt"));
    });
    await waitFor(() => expect(store.getState().sending).toBe(false));
    expect(screen.getByLabelText("Message")).toHaveValue(
      "Inspect the attached image",
    );
    expect(
      screen.getByRole("button", { name: "Preview image.png" }),
    ).toBeInTheDocument();
    expect(store.getState().failedDeliveryCount).toBe(0);
    promptGate = null;
    promptBody = null;
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(promptBody).toEqual(original));
    await waitFor(() => expect(store.getState().sending).toBe(false));
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });

  it("does not send the first prompt into a session selected during upload", async () => {
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      });
    });
    let releaseUpload!: () => void;
    const upload = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const socket = FakeWebSocket.instances.at(-1)!;
    const newSession = vi
      .spyOn(store, "newSession")
      .mockImplementation(async () => {
        act(() => {
          socket.emit({
            type: "snapshot",
            data: activeSnapshot({ sessionId: "new-session" }),
          });
        });
        return "new-session";
      });
    const addFiles = vi
      .spyOn(store, "addFiles")
      .mockImplementation(() => upload);
    const sendPrompt = vi.spyOn(store, "sendPrompt");
    const replaceComposerText = vi.spyOn(store, "replaceComposerText");

    try {
      render(<Welcome />);
      const message = screen.getByLabelText("First message");
      fireEvent.change(message, { target: { value: "Owned by A" } });
      fireEvent.change(screen.getByLabelText("Project directory"), {
        target: { value: "/proj" },
      });
      const image = new File(["png"], "image.png", { type: "image/png" });
      fireEvent.paste(message, {
        clipboardData: {
          files: [image],
          items: [{ kind: "file", getAsFile: () => image }],
        },
      });
      const startButton = screen.getByRole("button", {
        name: "Start session",
      });
      await waitFor(() => expect(startButton).toBeEnabled());
      fireEvent.click(startButton);
      await waitFor(() => expect(addFiles).toHaveBeenCalledWith([image]));

      act(() => {
        socket.emit({
          type: "snapshot",
          data: activeSnapshot({ sessionId: "session-b" }),
        });
      });
      await act(async () => {
        releaseUpload();
        await upload;
      });
      await waitFor(() => expect(store.getState().sessionId).toBe("session-b"));

      expect(sendPrompt).not.toHaveBeenCalled();
      expect(sessionDraft("new-session")).toBe("Owned by A");
      expect(replaceComposerText).not.toHaveBeenCalledWith("");
    } finally {
      releaseUpload();
      newSession.mockRestore();
      addFiles.mockRestore();
      sendPrompt.mockRestore();
      replaceComposerText.mockRestore();
      setSessionDraft("new-session", "");
    }
  });

  it("uses touch-first Return for a multiline first message instead of starting", async () => {
    newSessionBody = null;
    promptBody = null;
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      });
    });
    const originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: (query: string) => ({
        matches: query === "(hover: none) and (pointer: coarse)",
        media: query,
        onchange: null,
        addListener: () => {},
        removeListener: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
        dispatchEvent: () => false,
      }),
    });

    try {
      render(<Welcome />);
      fireEvent.change(screen.getByLabelText("Project directory"), {
        target: { value: "/proj" },
      });
      const message = screen.getByLabelText("First message");
      fireEvent.change(message, { target: { value: "first line" } });
      await waitFor(() =>
        expect(
          screen.getByRole("button", { name: "Start session" }),
        ).toBeEnabled(),
      );

      expect(fireEvent.keyDown(message, { key: "Enter" })).toBe(true);
      await act(async () => Promise.resolve());
      expect(newSessionBody).toBeNull();

      fireEvent.change(message, {
        target: { value: "first line\nsecond line" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Start session" }));
      await waitFor(() =>
        expect(promptBody).toMatchObject({
          message: "first line\nsecond line",
        }),
      );
    } finally {
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: originalMatchMedia,
      });
    }
  });

  it("resolves Pi's default model and searches project files from the typed workspace", async () => {
    newSessionBody = null;
    promptBody = null;
    defaultModelCwd = null;
    projectFileCwd = null;
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      });
    });

    render(<Welcome />);
    const directory = screen.getByLabelText("Project directory");
    fireEvent.change(directory, { target: { value: "/proj" } });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
        "Claude Sonnet 4",
      ),
    );
    expect(defaultModelCwd).toBe("/proj");

    fireEvent.click(screen.getByRole("button", { name: "Add project files" }));
    const projectFile = await screen.findByRole("option", {
      name: /index\.ts.*src\/index\.ts/,
    });
    expect(projectFileCwd).toBe("/proj");
    fireEvent.click(projectFile);
    expect(
      screen.getByRole("list", { name: "Referenced project files" }),
    ).toHaveTextContent("src/index.ts");

    fireEvent.change(screen.getByLabelText("First message"), {
      target: { value: "Use this file" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(newSessionBody).toEqual({ cwd: canonicalProjectCwd }),
    );
    await waitFor(() =>
      expect(promptBody).toMatchObject({
        sessionId: "new-session",
        message: "Use this file",
        projectFiles: ["src/index.ts"],
      }),
    );
  });

  it("never submits an unexplained Pi fallback when no model can be resolved", async () => {
    defaultModelAvailable = false;
    defaultModelCwd = null;
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      });
    });
    render(<Welcome />);
    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/no-model" },
    });
    fireEvent.change(screen.getByLabelText("First message"), {
      target: { value: "Do not guess" },
    });

    await waitFor(() => expect(defaultModelCwd).toBe("/no-model"));
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Model resolution failed",
      ),
    );
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "Model unavailable",
    );
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Start session" }),
    ).toBeDisabled();
  });

  it("omits redundant readiness copy while awaiting a project or input", () => {
    render(<Welcome />);
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/proj" },
    });
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("hides readiness copy once the selected project, message, and model are ready", async () => {
    render(<Welcome />);
    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/proj" },
    });
    fireEvent.change(screen.getByLabelText("First message"), {
      target: { value: "Start quietly" },
    });

    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start session" }),
      ).toBeEnabled(),
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("adopts a session model that arrives after the start surface mounts", async () => {
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: { active: null, runState: "idle", sessionStatuses: {} },
      });
    });
    render(<Welcome />);
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "Select model",
    );

    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({
          model: { provider: "anthropic", id: "claude-sonnet-4" },
        }),
      });
    });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
        "Claude Sonnet 4",
      ),
    );
  });

  it("reuses the session command completion control without leaking commands across projects", async () => {
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({
          cwd: "/proj",
          commands: [
            {
              name: "pi-tools",
              description: "Inspect Pi tools",
              source: "extension",
            },
            {
              name: "review",
              description: "Run review prompt",
              source: "prompt",
            },
          ],
        }),
      });
    });

    render(<Welcome />);
    const message = screen.getByLabelText(
      "First message",
    ) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "/pi", selectionStart: 3 } });
    message.setSelectionRange(3, 3);
    fireEvent.select(message);

    const list = await screen.findByRole("listbox", {
      name: "Slash command completions",
    });
    const option = within(list).getByRole("option", {
      name: /\/pi-tools.*Inspect Pi tools/,
    });
    expect(message.closest("[role='combobox']")).toHaveAttribute(
      "aria-owns",
      list.id,
    );
    expect(message).toHaveAttribute("aria-activedescendant", option.id);
    fireEvent.keyDown(message, { key: "Tab" });
    expect(message).toHaveValue("/pi-tools ");

    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/other-project" },
    });
    fireEvent.change(message, { target: { value: "/", selectionStart: 1 } });
    message.setSelectionRange(1, 1);
    fireEvent.select(message);

    const otherProjectList = await screen.findByRole("listbox", {
      name: "Slash command completions",
    });
    expect(
      within(otherProjectList).getByRole("option", {
        name: /\/compact.*Compact the current context/,
      }),
    ).toBeInTheDocument();
    expect(
      within(otherProjectList).queryByRole("option", { name: /\/pi-tools/ }),
    ).not.toBeInTheDocument();
  });
});
