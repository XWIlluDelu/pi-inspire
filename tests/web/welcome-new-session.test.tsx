// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpConfigSnapshot } from "../../shared/mcp";
import type { ModelCatalogResponse } from "../../shared/model-settings";
import type { StatusControlDeclaration } from "../../shared/tool-presentation-config";
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
let beforeUpload: (() => Promise<void>) | null = null;
const welcomeModels = [
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
];
let defaultModelAvailable: boolean;
let projectFileSearch: { cwd: string | null; hidden: boolean } | null;
let directoryFailure: "missing" | "file" | null = null;
let sourceWriterActive = false;

beforeEach(async () => {
  newSessionBody = null;
  promptBody = null;
  defaultModelAvailable = true;
  projectFileSearch = null;
  installFakeWebSocket();
  mockModelMenuLayout();
  installFetch(async (url, init) => {
    if (url.startsWith("/api/bootstrap"))
      return {
        body: bootstrapPayload({
          availableModels: welcomeModels,
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
      if (sourceWriterActive && parsed.searchParams.has("sessionId"))
        return {
          status: 409,
          body: {
            error:
              "This session is open in another Pi. Take over to continue it here.",
            code: "EXTERNAL_PI_WRITER_ACTIVE",
          },
        };
      if (directoryFailure && parsed.searchParams.has("sessionId"))
        return {
          status: 409,
          body: {
            error:
              "This session is read-only because its project folder is unavailable",
            code: "SESSION_WORKSPACE_UNAVAILABLE",
          },
        };
      if (directoryFailure && parsed.searchParams.has("cwd"))
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
      return {
        body: {
          models: welcomeModels,
          defaults: {
            cwd: parsed.searchParams.get("cwd"),
            model: defaultModelAvailable ? welcomeModels[1] : null,
            thinkingLevel: "high",
          },
        },
      };
    }
    if (url.startsWith("/api/new-session/files")) {
      const params = new URL(url, "http://local").searchParams;
      const cwd = params.get("cwd");
      projectFileSearch = { cwd, hidden: params.get("showHidden") === "1" };
      const name = cwd === "/one" ? "index.ts" : "next.ts";
      return {
        body: {
          cwd: `/canonical${cwd}`,
          files: [{ path: `src/${name}`, name }],
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
          availableModels: welcomeModels,
        }),
      };
    }
    if (url === "/api/attachments") {
      await beforeUpload?.();
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
    }
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
  await store.init();
  FakeWebSocket.instances.at(-1)?.open();
});

afterEach(() => {
  directoryFailure = null;
  sourceWriterActive = false;
  promptGate = null;
  beforeUpload = null;
  setStartDraft("");
});

function SessionSurface() {
  return useAppState((state) => state.sessionId) ? <Composer /> : <Welcome />;
}

describe("new-session start surface", () => {
  it("reads and writes MCP settings for New's prospective directory", async () => {
    // Workspace ownership is independent of the lazy surface's chunk arrival.
    await import("../../src/components/Settings");
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
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    const navigation = await screen.findByRole("navigation", {
      name: "Settings categories",
    });
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
      screen.getByRole("button", { name: "Save" }).closest("form")!,
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

  it("resolves pending choices from the prospective directory when the source changes owner", async () => {
    sourceWriterActive = true;
    render(
      <Welcome
        inherited={{
          sessionId: "source",
          cwd: "/same-project",
          model: null,
          modelDiscovery: "loading",
          thinkingLevel: "off",
          commands: [],
        }}
      />,
    );
    fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
      target: { value: "Independent work" },
    });
    const start = screen.getByRole("button", { name: "Start session" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() =>
      expect(newSessionBody).toMatchObject({
        cwd: "/same-project",
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        thinkingLevel: "high",
      }),
    );
    expect(promptBody?.message).toBe("Independent work");
  });

  it("retains the draft and attachment after a failed create and lets manual effort override Pi's default", async () => {
    directoryFailure = "missing";
    render(<Welcome />);
    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/new-project" },
    });
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
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(
      await screen.findByRole("option", { name: /Claude Sonnet 4/ }),
    );
    const thinking = screen.getByRole("combobox", { name: "Thinking level" });
    await waitFor(() => expect(thinking).toHaveTextContent("Default"));
    const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
    const options = {
      createDirectory: true,
      model: { provider: "anthropic", id: "claude-sonnet-4" },
    };
    fireEvent.click(create);
    await waitFor(() => expect(create).toBeEnabled());
    expect(start).toHaveBeenLastCalledWith("/new-project", options);
    expect(message).toHaveValue("Retain this work");
    expect(
      screen.getByRole("button", { name: "Remove attached image" }),
    ).toBeEnabled();

    fireEvent.click(thinking);
    fireEvent.click(screen.getByRole("option", { name: "High" }));
    fireEvent.click(create);
    await waitFor(() =>
      expect(start).toHaveBeenLastCalledWith("/new-project", {
        ...options,
        thinkingLevel: "high",
      }),
    );
  });

  it("preflights New from read-only history and keeps an invalid path blocked during retry", async () => {
    directoryFailure = "file";
    act(() =>
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({
          sessionId: "archived",
          cwd: "/file/project",
          readOnlyReason: "workspace-unavailable",
          model: welcomeModels[1],
          thinkingLevel: "high",
        }),
      }),
    );
    const view = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "New session" }));
    const message = await screen.findByRole("textbox", {
      name: "First message",
    });
    fireEvent.change(message, {
      target: { value: "Preserve my prompt" },
    });
    const start = screen.getByRole("button", { name: "Start session" });
    const issue = await screen.findByRole("alert");
    expect(issue).toHaveTextContent("Project path is not a directory");
    expect(start).toBeDisabled();
    expect(
      screen.queryByRole("button", { name: "Create folder and start" }),
    ).toBeNull();
    vi.useFakeTimers();
    const gate = deferred<ModelCatalogResponse>();
    const original = store.readNewSessionModels;
    const read = vi
      .spyOn(store, "readNewSessionModels")
      .mockImplementation(() => gate.promise);
    try {
      fireEvent.click(screen.getByRole("button", { name: "Retry" }));
      await act(async () =>
        gate.reject(new Error("Directory service unavailable")),
      );
      expect(issue).toHaveTextContent("Project path is not a directory");
      expect(start).toBeDisabled();
      directoryFailure = null;
      read.mockImplementation(original);
      await act(() => vi.advanceTimersByTimeAsync(1_000));
      expect(start).toBeEnabled();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(message).toHaveValue("Preserve my prompt");
    } finally {
      view.unmount();
      read.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not cancel composition-confirming Enter in the project path", () => {
    render(<Welcome />);
    const directory = screen.getByRole("textbox", {
      name: "Project directory",
    });
    directory.focus();
    expect(
      fireEvent.keyDown(directory, { key: "Enter", isComposing: true }),
    ).toBe(true);
    expect(fireEvent.keyDown(directory, { key: "Enter", keyCode: 229 })).toBe(
      true,
    );
  });

  it("hands off a mixed first message before its receipt and retries unknown delivery unchanged", async () => {
    const receipt = deferred<RouteResponse>();
    promptGate = receipt.promise;
    render(<SessionSurface />);
    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/proj" },
    });
    const message = screen.getByRole("textbox", { name: "First message" });
    fireEvent.change(message, {
      target: { value: "Inspect the attached image" },
    });
    const image = new File(["png"], "image.png", { type: "image/png" });
    fireEvent.paste(message, { clipboardData: { files: [image] } });
    expect(
      screen.getByRole("button", { name: "Preview image.png" }),
    ).toBeVisible();
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

    await act(async () => {
      receipt.reject(new TypeError("Lost receipt"));
    });
    expect(await screen.findByDisplayValue("Inspect the attached image")).toBe(
      screen.getByLabelText("Message"),
    );
    expect(
      screen.getByRole("button", { name: "Preview image.png" }),
    ).toBeInTheDocument();
    promptGate = null;
    promptBody = null;
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Send message" })),
    );
    expect(promptBody).toEqual(original);
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });

  it("does not send the first prompt into a session selected during upload", async () => {
    const upload = deferred<void>();
    const startUpload = vi.fn(() => upload.promise);
    beforeUpload = startUpload;
    const socket = FakeWebSocket.instances.at(-1)!;
    setSessionDraft("session-b", "Belongs to B");
    const select = (sessionId: string) =>
      act(() => {
        socket.emit({ type: "snapshot", data: activeSnapshot({ sessionId }) });
      });

    try {
      render(<SessionSurface />);
      const message = screen.getByLabelText("First message");
      fireEvent.change(message, { target: { value: "Owned by A" } });
      fireEvent.change(screen.getByLabelText("Project directory"), {
        target: { value: "/proj" },
      });
      const image = new File(["png"], "image.png", { type: "image/png" });
      fireEvent.paste(message, { clipboardData: { files: [image] } });
      const startButton = screen.getByRole("button", {
        name: "Start session",
      });
      await waitFor(() => expect(startButton).toBeEnabled());
      fireEvent.click(startButton);
      await waitFor(() => expect(startUpload).toHaveBeenCalled());

      select("session-b");
      await act(async () => upload.resolve());
      expect(screen.getByLabelText("Message")).toHaveValue("Belongs to B");
      expect(
        screen.queryByRole("button", { name: "Preview image.png" }),
      ).toBeNull();
      expect(promptBody).toBeNull();
      select("new-session");
      expect(screen.getByLabelText("Message")).toHaveValue("Owned by A");
      expect(
        screen.getByRole("button", { name: "Preview image.png" }),
      ).toBeVisible();
    } finally {
      upload.resolve();
      setSessionDraft("session-b", "");
      setSessionDraft("new-session", "");
    }
  });

  it("keeps the file filter but sends only references from the new canonical workspace", async () => {
    render(<Welcome />);
    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/one" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add project files" }));
    await screen.findByRole("option", {
      name: /index\.ts.*src\/index\.ts/,
    });
    fireEvent.click(screen.getByRole("button", { name: "Show hidden files" }));
    await waitFor(() =>
      expect(projectFileSearch).toEqual({ cwd: "/one", hidden: true }),
    );
    fireEvent.click(
      await screen.findByRole("option", {
        name: /index\.ts.*src\/index\.ts/,
      }),
    );
    expect(
      screen.getByRole("list", { name: "Referenced project files" }),
    ).toHaveTextContent("src/index.ts");
    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/two" },
    });
    expect(
      screen.queryByRole("list", { name: "Referenced project files" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add project files" }));
    expect(
      screen.getByRole("button", { name: "Show hidden files" }),
    ).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(
      await screen.findByRole("option", { name: /next\.ts.*src\/next\.ts/ }),
    );
    expect(projectFileSearch).toEqual({ cwd: "/two", hidden: true });
    fireEvent.change(screen.getByLabelText("First message"), {
      target: { value: "Use the new project's file" },
    });
    const start = screen.getByRole("button", { name: "Start session" });
    await waitFor(() => expect(start).toBeEnabled());
    fireEvent.click(start);
    await waitFor(() =>
      expect(promptBody).toMatchObject({
        sessionId: "new-session",
        message: "Use the new project's file",
        projectFiles: ["src/next.ts"],
      }),
    );
    expect(newSessionBody).toEqual({ cwd: "/canonical/two" });
  });

  it("never submits an unexplained Pi fallback when no model can be resolved", async () => {
    defaultModelAvailable = false;
    render(<Welcome />);
    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/no-model" },
    });
    fireEvent.change(screen.getByLabelText("First message"), {
      target: { value: "Do not guess" },
    });

    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Models are unavailable",
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
});

describe("Welcome capability controls and command completion", () => {
  const control: StatusControlDeclaration = {
    id: "user.example.mode",
    slot: "thinking",
    label: "Response mode",
    command: "/response-mode",
    state: { key: "mode", value: "mode" },
    options: [
      { value: "normal", label: "Normal" },
      { value: "quick", label: "Quick", indicator: "bolt" },
    ],
  };
  const commands = [
    {
      name: "response-mode",
      source: "extension" as const,
      description: "Choose response mode",
    },
    {
      name: "review",
      source: "prompt" as const,
      description: "Review the project",
    },
    {
      name: "skill:analyze",
      source: "skill" as const,
      description: "Analyze the project",
    },
  ];
  const model = {
    provider: "test",
    id: "test",
    name: "Test model",
    reasoning: false,
  };
  let available = true;
  let rejectCommand = false;
  let requests: string[];
  let created: number;
  function snapshot(mode = "normal", sessionId = "new-session") {
    return {
      ...activeSnapshot({ sessionId, cwd: "/target", model, commands }),
      extensionStatuses: { mode: JSON.stringify({ mode }) },
    };
  }

  beforeEach(async () => {
    available = true;
    rejectCommand = false;
    requests = [];
    created = 0;
    setStartDraft("");
    for (const notice of store.getState().notices)
      store.dismissNotice(notice.id);
    installFakeWebSocket();
    mockModelMenuLayout();
    installFetch((url, init) => {
      if (url.startsWith("/api/bootstrap"))
        return {
          body: bootstrapPayload({
            toolPresentations: {
              version: 1,
              rules: {},
              mappings: {},
              controls: [control],
            },
          }),
        };
      if (url.startsWith("/api/models"))
        return {
          body: {
            models: [model],
            commands: available ? commands : [],
            defaults: { cwd: "/target", model, thinkingLevel: "off" },
          },
        };
      if (url.startsWith("/api/sessions/new")) {
        created++;
        return { body: snapshot() };
      }
      if (url.startsWith("/api/prompt")) {
        const message = String(jsonBody(init).message);
        requests.push(message);
        if (rejectCommand && message.startsWith("/"))
          return { status: 400, body: { error: "Mode unavailable" } };
        return { status: 202, body: { accepted: true } };
      }
      if (url.startsWith("/api/sessions/refresh"))
        return { body: { ok: true } };
      if (url.startsWith("/api/sessions")) return { body: sessionPage([], 0) };
      if (url.startsWith("/api/preferences"))
        return { body: bootstrapPayload().preferences };
      return undefined;
    });
    await store.init();
    FakeWebSocket.instances.at(-1)!.open();
  });

  afterEach(() => {
    setStartDraft("");
    vi.restoreAllMocks();
  });

  async function selectMode() {
    render(<Welcome />);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Project directory" }),
      {
        target: { value: "/target" },
      },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Thinking level" }),
    );
    expect(screen.getByText("Thinking unavailable")).toBeVisible();
    expect(screen.getByRole("slider", { name: "Response mode" })).toBeEnabled();
    fireEvent.click(screen.getByText("Quick"));
    expect(screen.getByRole("slider")).toHaveAttribute(
      "aria-valuetext",
      "Quick",
    );
    expect(created).toBe(0);
    expect(requests).toEqual([]);
    fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
      target: { value: "Review this project" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() => expect(requests).toEqual(["/response-mode quick"]));
  }

  it("discovers target commands without a session and confirms a preselection before first input", async () => {
    await selectMode();
    expect(sessionDraft("new-session")).toBe("Review this project");
    await act(async () => {});
    expect(requests).toHaveLength(1);
    act(() =>
      FakeWebSocket.instances
        .at(-1)!
        .emit({ type: "snapshot", data: snapshot("quick") }),
    );
    await waitFor(() =>
      expect(requests).toEqual(["/response-mode quick", "Review this project"]),
    );
    expect(created).toBe(1);
  });

  it("uses discovered prompts and skills without reviving a removed inherited command", async () => {
    render(
      <Welcome
        inherited={{
          cwd: "/target",
          model,
          thinkingLevel: "off",
          commands: [
            {
              name: "retired",
              source: "prompt",
              description: "Retired prompt",
            },
          ],
        }}
      />,
    );
    const input = screen.getByRole("textbox", { name: "First message" });
    fireEvent.change(input, { target: { value: "/retired" } });
    expect(
      screen.getByRole("option", { name: /Retired prompt/ }),
    ).toBeVisible();
    fireEvent.change(input, { target: { value: "/review" } });
    expect(
      await screen.findByRole("option", { name: /Review the project/ }),
    ).toBeVisible();
    fireEvent.change(input, { target: { value: "/skill:analyze" } });
    expect(
      await screen.findByRole("option", { name: /Analyze the project/ }),
    ).toBeVisible();
    fireEvent.change(input, { target: { value: "/retired" } });
    expect(screen.queryByRole("option", { name: /Retired prompt/ })).toBeNull();
    expect(created).toBe(0);
  });

  it("preserves the new session's draft if the selected control cannot apply", async () => {
    rejectCommand = true;
    await selectMode();
    await waitFor(() =>
      expect(
        store
          .getState()
          .notices.some((notice) =>
            notice.text.includes("Your first message is still in the composer"),
          ),
      ).toBe(true),
    );
    expect(sessionDraft("new-session")).toBe("Review this project");
    expect(requests).toEqual(["/response-mode quick"]);
  });

  it("retires a pending initialization when another session takes ownership", async () => {
    await selectMode();
    act(() =>
      FakeWebSocket.instances
        .at(-1)!
        .emit({ type: "snapshot", data: snapshot("normal", "other") }),
    );
    await act(async () => {});
    expect(requests).toEqual(["/response-mode quick"]);
    expect(sessionDraft("new-session")).toBe("Review this project");
    expect(
      store
        .getState()
        .notices.some((notice) => notice.text.includes("first message")),
    ).toBe(false);
  });

  it("drops capabilities from the old directory for both controls and command completion", async () => {
    render(<Welcome />);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Project directory" }),
      {
        target: { value: "/target" },
      },
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Thinking level" }),
    );
    expect(screen.getByRole("slider", { name: "Response mode" })).toBeEnabled();
    available = false;
    fireEvent.change(
      screen.getByRole("textbox", { name: "Project directory" }),
      {
        target: { value: "/other" },
      },
    );
    expect(screen.queryByRole("slider")).toBeNull();
    fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
      target: { value: "/response" },
    });
    expect(screen.queryByRole("option", { name: /response-mode/ })).toBeNull();
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Thinking level" }),
      ).toBeDisabled(),
    );
    expect(created).toBe(0);
  });
});
