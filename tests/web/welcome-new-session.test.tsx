// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Welcome } from "../../src/components/Welcome";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
} from "./helpers";

let newSessionBody: Record<string, unknown> | null;
let promptBody: Record<string, unknown> | null;
const canonicalProjectCwd = "/canonical/proj";
let defaultModelCwd: string | null;
let defaultModelAvailable: boolean;
let projectFileCwd: string | null;

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
    if (url.startsWith("/api/new-session/defaults")) {
      const parsed = new URL(url, "http://local");
      defaultModelCwd = parsed.searchParams.get("cwd");
      return {
        body: {
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
      return { status: 202, body: { accepted: true } };
    }
    if (url.startsWith("/api/sessions/refresh")) return { body: { ok: true } };
    if (url.startsWith("/api/sessions"))
      return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
    if (url.startsWith("/api/preferences"))
      return { body: { ...bootstrapPayload().preferences, ...jsonBody(init) } };
    return undefined;
  });
  await store.init("token");
  FakeWebSocket.instances.at(-1)?.open();
});

afterEach(() => {
  defaultModelAvailable = true;
});

describe("new-session start surface", () => {
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
    ).toHaveTextContent("thinking unavailable");

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
      screen.getByRole("button", { name: "Preview attached image" }),
    ).toBeInTheDocument();
    expect(screen.queryByText("image.png")).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/proj" },
    });
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

    const { container } = render(<Welcome />);
    const directory = screen.getByLabelText("Project directory");
    fireEvent.change(directory, { target: { value: "/proj" } });

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
        "Claude Sonnet 4",
      ),
    );
    expect(defaultModelCwd).toBe("/proj");

    const meta = container.querySelector(".composer__meta")!;
    const controls = Array.from(meta.querySelectorAll("button"));
    expect([
      controls.indexOf(screen.getByRole("button", { name: "Model" })),
      controls.indexOf(
        screen.getByRole("combobox", { name: "Thinking level" }),
      ),
      controls.indexOf(
        screen.getByRole("button", { name: "Add project files" }),
      ),
      controls.indexOf(screen.getByRole("button", { name: "Attach files" })),
    ]).toEqual([0, 1, 2, 3]);
    const browse = screen.getByRole("button", {
      name: "Browse host directories",
    });
    expect(browse.parentElement).toBe(directory.parentElement);
    expect(meta.nextElementSibling).toBe(directory.parentElement);
    expect(directory.parentElement?.firstElementChild).toBe(browse);

    fireEvent.click(screen.getByRole("button", { name: "Add project files" }));
    const projectFile = await screen.findByRole("option", {
      name: /index\.ts.*src\/index\.ts/,
    });
    expect(projectFileCwd).toBe("/proj");
    fireEvent.click(projectFile);
    expect(
      within(
        screen.getByRole("list", { name: "Referenced project files" }),
      ).getByText("src/index.ts"),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText("First message"), {
      target: { value: "Use this file" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(newSessionBody).toEqual({
        cwd: canonicalProjectCwd,
        model: { provider: "anthropic", id: "claude-sonnet-4" },
        thinkingLevel: "high",
      }),
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

  it("explains disabled start readiness before a project, input, and model are available", () => {
    render(<Welcome />);
    expect(screen.getByRole("status")).toHaveTextContent("Choose a project");
    fireEvent.change(screen.getByLabelText("Project directory"), {
      target: { value: "/proj" },
    });
    expect(screen.getByRole("status")).toHaveTextContent(
      "Enter an instruction or add a file",
    );
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
