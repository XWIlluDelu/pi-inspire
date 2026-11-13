// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsSettings } from "../../src/components/ModelsSettings";
import type { store } from "../../src/store";
import { useConfigurationDocument } from "../../src/use-configuration-document";
import { mockModelMenuLayout } from "./fixtures/model-menu-layout";
import {
  loginProviders,
  modelSettingsSnapshot,
} from "./fixtures/model-settings";
import { deferred } from "./helpers";

const fixture = vi.hoisted(() => ({
  state: { sessionId: "one", cwd: "/one", transportGeneration: 1 },
  host: {
    readModelSettings: vi.fn(),
    saveModelPreferences: vi.fn<typeof store.saveModelPreferences>(),
    editModelConfig: vi.fn(),
    providerAuth: vi.fn(),
  },
}));
vi.mock("../../src/store", () => ({
  store: fixture.host,
  useAppState: (selector: (state: typeof fixture.state) => unknown) =>
    selector(fixture.state),
  shallowEqual: () => false,
}));

async function openDeclarations() {
  const section = await screen.findByRole("region", {
    name: "Custom providers",
  });
  const disclosure = within(section).getByLabelText(
    "Custom provider declarations",
  );
  if (!(disclosure.parentElement as HTMLDetailsElement).open) {
    fireEvent.click(disclosure);
    await within(section).findByRole("button", { name: /^Edit provider / });
  }
}
async function inspectModel(name: string) {
  const list = await screen.findByRole("listbox", { name: "Available models" });
  fireEvent.click(within(list).getByRole("option", { name: new RegExp(name) }));
}

beforeEach(() => {
  for (const mock of Object.values(fixture.host)) mock.mockReset();
  mockModelMenuLayout();
  fixture.state = { sessionId: "one", cwd: "/one", transportGeneration: 1 };
  fixture.host.readModelSettings.mockResolvedValue(modelSettingsSnapshot());
  fixture.host.saveModelPreferences.mockResolvedValue({
    saved: true,
    snapshot: modelSettingsSnapshot(),
  });
  fixture.host.editModelConfig.mockResolvedValue({
    saved: true,
    snapshot: modelSettingsSnapshot(),
  });
  fixture.host.providerAuth.mockResolvedValue(loginProviders());
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("Models settings configuration and ownership", () => {
  it("keeps a committed default when an earlier catalog refresh fails", async () => {
    const older = deferred<ReturnType<typeof modelSettingsSnapshot>>();
    fixture.host.readModelSettings
      .mockResolvedValueOnce(modelSettingsSnapshot())
      .mockReturnValueOnce(older.promise);
    const saved = modelSettingsSnapshot();
    saved.saved.defaultModel = saved.effective.defaultModel = {
      provider: "anthropic",
      id: "claude-haiku",
    };
    fixture.host.saveModelPreferences.mockResolvedValue({
      saved: true,
      snapshot: saved,
    });
    render(<ModelsSettings />);
    await inspectModel("Claude Haiku");
    const refresh = screen.getByRole("button", {
      name: "Refresh available models",
    });
    fireEvent.click(refresh);
    expect(fixture.host.readModelSettings).toHaveBeenLastCalledWith(
      { sessionId: "one" },
      true,
    );
    const choice = screen.getByRole("button", { name: "Set as default" });
    fireEvent.click(choice);
    await waitFor(() => expect(choice).toBeDisabled());
    await act(async () => older.reject(new Error("Obsolete catalog failure")));
    expect(choice).toBeDisabled();
    expect(screen.queryByText("Obsolete catalog failure")).toBeNull();
  });

  it("shows catalog failure without disabling saved declarations or preferences", async () => {
    const warning =
      "Model availability could not load. Saved configuration is still editable; refresh models to retry.";
    fixture.host.readModelSettings.mockResolvedValue(
      modelSettingsSnapshot({
        models: [],
        modelsWarning: warning,
      }),
    );
    render(<ModelsSettings />);
    expect(await screen.findByRole("status")).toHaveTextContent(warning);
    expect(
      screen.getByRole("combobox", { name: "Default thinking" }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Add provider" })).toBeEnabled();
  });
  it("shows saved and effective project defaults separately, including a provider-only project override", async () => {
    const snapshot = modelSettingsSnapshot({
      saved: {
        defaultModel: { provider: "missing", id: "gpt-5" },
        defaultThinkingLevel: "xhigh",
        enabledModels: [],
      },
      effective: {
        defaultModel: { provider: "openai", id: "gpt-5" },
        defaultThinkingLevel: "low",
        enabledModels: [],
      },
      projectOverrides: ["defaultProvider", "defaultThinkingLevel"],
    });
    fixture.host.readModelSettings.mockResolvedValue(snapshot);
    render(<ModelsSettings />);
    await screen.findByTitle("missing/gpt-5 · Not currently available");
    expect(
      screen.getByRole("combobox", { name: "Default thinking" }),
    ).toHaveTextContent("Xhigh");
    expect(screen.getByText(/This project uses GPT 5\./)).toBeInTheDocument();
    expect(screen.getByText(/This project uses Low\./)).toBeInTheDocument();
  });

  it("lets a project read fail independently and restores global edits after a failed initial read", async () => {
    fixture.host.readModelSettings.mockRejectedValue(
      new Error("Cannot read model settings"),
    );
    render(<ModelsSettings />);
    const retry = await screen.findByRole("button", {
      name: "Retry loading models",
    });
    fixture.host.readModelSettings.mockResolvedValue(
      modelSettingsSnapshot({
        projectSettingsError: "Project overrides are unavailable",
      }),
    );
    fireEvent.click(retry);
    expect(
      await screen.findByText("Project overrides are unavailable"),
    ).toBeVisible();
    await inspectModel("Claude Haiku");
    const choice = screen.getByRole("button", { name: "Set as default" });
    expect(choice).toBeEnabled();
    fireEvent.click(choice);
    await waitFor(() =>
      expect(fixture.host.saveModelPreferences).toHaveBeenCalledWith(
        { sessionId: "one" },
        expect.any(String),
        { defaultModel: { provider: "anthropic", id: "claude-haiku" } },
      ),
    );
  });

  it("disables global edits and labels unreadable preferences as unavailable", async () => {
    fixture.host.readModelSettings.mockResolvedValue(
      modelSettingsSnapshot({ settingsError: "Invalid Pi settings" }),
    );
    render(<ModelsSettings />);
    const thinking = await screen.findByRole("combobox", {
      name: "Default thinking",
    });
    expect(thinking).toHaveValue("");
    expect(thinking).toBeDisabled();
    await inspectModel("Claude Haiku");
    expect(
      screen.getByRole("button", { name: "Set as default" }),
    ).toBeDisabled();
  });

  it("uses one model list for common/default actions and preserves unavailable identities and native pattern sources", async () => {
    let snapshot = modelSettingsSnapshot({
      models: modelSettingsSnapshot().models.filter(
        (model) => model.provider !== "custom",
      ),
    });
    snapshot.saved.defaultModel = { provider: "custom", id: "local" };
    snapshot.saved.enabledModels = [
      "custom/local:high",
      "*haiku*:high",
      "anthropic/claude-haiku",
    ];
    snapshot.savedCommonEntries = [
      { pattern: "custom/local:high", models: [] },
      {
        pattern: "*haiku*:high",
        models: [
          { provider: "anthropic", id: "claude-haiku", thinkingLevel: "high" },
        ],
      },
      {
        pattern: "anthropic/claude-haiku",
        models: [{ provider: "anthropic", id: "claude-haiku" }],
      },
    ];
    fixture.host.readModelSettings.mockImplementation(async () => snapshot);
    fixture.host.saveModelPreferences.mockImplementation(
      async (_owner, _revision, patch) => {
        snapshot = { ...snapshot, saved: { ...snapshot.saved, ...patch } };
        return { saved: true, snapshot };
      },
    );
    render(<ModelsSettings />);
    const list = await screen.findByRole("listbox", {
      name: "Available models",
    });
    expect(
      document.querySelector(".models-default-value__name"),
    ).toHaveTextContent("Local model");
    expect(within(list).queryByText("Local model")).not.toBeInTheDocument();
    await inspectModel("GPT 5");
    fireEvent.click(screen.getByRole("checkbox", { name: "Common: GPT 5" }));
    await waitFor(() =>
      expect(fixture.host.saveModelPreferences).toHaveBeenCalledWith(
        { sessionId: "one" },
        "a".repeat(64),
        {
          enabledModels: [
            "custom/local:high",
            "*haiku*:high",
            "anthropic/claude-haiku",
            "openai/gpt-5",
          ],
        },
      ),
    );
    expect(fixture.host.editModelConfig).not.toHaveBeenCalled();
    await inspectModel("Claude Haiku");
    expect(
      screen.queryByRole("checkbox", { name: "Common: Claude Haiku" }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit common pattern for Claude Haiku",
      }),
    );
    expect(screen.getByRole("textbox", { name: "Model pattern" })).toHaveValue(
      "*haiku*:high",
    );
    expect(snapshot.saved.enabledModels).toContain("*haiku*:high");
    fireEvent.change(screen.getByRole("textbox", { name: "Model pattern" }), {
      target: { value: "*haiku*:medium" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(snapshot.saved.enabledModels).toContain("*haiku*:medium"),
    );
    expect(snapshot.saved.defaultModel).toEqual({
      provider: "custom",
      id: "local",
    });
  });

  it("removes complete model effort references directly while retaining native wildcard entries", async () => {
    const snapshot = modelSettingsSnapshot();
    const local = snapshot.models.find((model) => model.provider === "custom")!;
    local.id = "local:low";
    snapshot.saved.enabledModels = [
      "custom/local:low:high",
      "custom/local:low",
      "*gpt*:high",
    ];
    snapshot.savedCommonEntries = [
      {
        pattern: "custom/local:low:high",
        models: [
          { provider: "custom", id: "local:low", thinkingLevel: "high" },
        ],
      },
      {
        pattern: "custom/local:low",
        models: [{ provider: "custom", id: "local:low" }],
      },
      {
        pattern: "*gpt*:high",
        models: [{ provider: "openai", id: "gpt-5", thinkingLevel: "high" }],
      },
    ];
    fixture.host.readModelSettings.mockResolvedValue(snapshot);
    render(<ModelsSettings />);
    await inspectModel("Local model");
    const remove = screen.getByRole("checkbox", {
      name: "Common: Local model",
    });
    expect(remove).toBeChecked();
    fireEvent.click(remove);
    await waitFor(() =>
      expect(fixture.host.saveModelPreferences).toHaveBeenCalledWith(
        { sessionId: "one" },
        "a".repeat(64),
        { enabledModels: ["*gpt*:high"] },
      ),
    );
  });

  it("isolates Add and Edit drafts, keeps untouched credentials, and refreshes provider discovery after save", async () => {
    fixture.host.providerAuth
      .mockResolvedValueOnce(loginProviders())
      .mockResolvedValue([
        {
          id: "custom",
          name: "Configured custom provider",
          stored: null,
          methods: [{ type: "api_key", label: "Custom API key" }],
        },
      ]);
    render(<ModelsSettings />);
    await openDeclarations();
    const edit = () =>
      fireEvent.click(
        screen.getByRole("button", { name: "Edit provider custom" }),
      );
    const change = (field: string, value: string) =>
      fireEvent.change(screen.getByLabelText(field), { target: { value } });
    edit();
    change("Base URL", "https://unsaved-existing.test");
    fireEvent.click(screen.getByLabelText("Remove API key"));
    fireEvent.click(screen.getByRole("button", { name: "Back to models" }));
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(screen.getByLabelText("Provider ID")).toHaveValue("");
    expect(screen.getByLabelText("Base URL")).toHaveValue("");
    change("Provider ID", "different-provider");
    change("API key", "unsaved-secret");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    edit();
    expect(screen.getByLabelText("Provider ID")).toHaveValue("custom");
    expect(screen.getByLabelText("Base URL")).toHaveValue(
      "http://localhost:8080/v1",
    );
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByLabelText("Remove API key")).not.toBeChecked();
    change("Base URL", "https://new-target.test/v1");
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fixture.host.editModelConfig).toHaveBeenCalledExactlyOnceWith(
        { sessionId: "one" },
        "b".repeat(64),
        {
          kind: "provider",
          id: "custom",
          values: { baseUrl: "https://new-target.test/v1" },
        },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect provider" }));
    expect(await screen.findByText("Configured custom provider")).toBeVisible();
  });

  it("leaves newer focus in place when a common model save settles", async () => {
    const finishSave = deferred<void>();
    fixture.host.saveModelPreferences.mockImplementationOnce(
      async (_owner, _revision, patch) => {
        await finishSave.promise;
        const snapshot = modelSettingsSnapshot();
        return {
          saved: true,
          snapshot: { ...snapshot, saved: { ...snapshot.saved, ...patch } },
        };
      },
    );
    render(<ModelsSettings />);
    await inspectModel("Claude Haiku");
    const action = screen.getByRole("checkbox", {
      name: "Common: Claude Haiku",
    });
    const search = screen.getByRole("combobox", {
      name: "Search available models",
    });
    action.focus();
    fireEvent.click(action);
    await waitFor(() => expect(action).toBeDisabled());
    search.focus();
    finishSave.resolve();
    await waitFor(() => expect(action).toBeEnabled());
    expect(search).toHaveFocus();
  });

  it("omits an API override when adding a model with native API inheritance", async () => {
    const snapshot = modelSettingsSnapshot();
    snapshot.providers = [{ id: "openai", models: [], apiKeyConfigured: true }];
    snapshot.nativeApiProviders = ["openai"];
    snapshot.models = [];
    fixture.host.readModelSettings.mockResolvedValue(snapshot);
    fixture.host.editModelConfig.mockResolvedValue({ saved: true, snapshot });
    render(<ModelsSettings />);
    await openDeclarations();
    fireEvent.click(
      screen.getByRole("button", { name: "Add model to openai" }),
    );
    fireEvent.change(screen.getByLabelText("Model ID"), {
      target: { value: "inherited-api-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fixture.host.editModelConfig).toHaveBeenCalledWith(
        { sessionId: "one" },
        "b".repeat(64),
        {
          kind: "model",
          provider: "openai",
          values: {
            id: "inherited-api-model",
            reasoning: false,
            input: ["text"],
          },
        },
      ),
    );
  });

  it("owns typed declaration fields by the full model identity", async () => {
    const snapshot = modelSettingsSnapshot();
    snapshot.providers[0]!.models = [
      {
        id: "same ",
        type: "embedding",
        name: "Embedding model",
      },
      {
        id: "same ",
        type: "chat",
        name: "Chat model",
        contextWindow: 0,
        maxTokens: 0.5,
      },
    ];
    fixture.host.readModelSettings.mockResolvedValue(snapshot);
    fixture.host.editModelConfig.mockResolvedValue({ saved: true, snapshot });
    render(<ModelsSettings />);
    await openDeclarations();
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit declared model custom/same (embedding)",
      }),
    );
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Unsaved embedding edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to models" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Edit declared model custom/same" }),
    );
    expect(screen.getByLabelText("Display name")).toHaveValue("Chat model");
    expect(
      (screen.getByLabelText("Context window") as HTMLInputElement).validity
        .valid,
    ).toBe(true);
    expect(
      (screen.getByLabelText("Maximum output tokens") as HTMLInputElement)
        .validity.valid,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fixture.host.editModelConfig).toHaveBeenCalledWith(
        { sessionId: "one" },
        "b".repeat(64),
        {
          kind: "model",
          provider: "custom",
          originalId: "same ",
          originalType: "chat",
          values: { id: "same " },
        },
      ),
    );
  });

  it("keeps config usable without login and acknowledges saved writes without an optional snapshot", async () => {
    fixture.host.providerAuth.mockRejectedValue(
      new Error("Login is unavailable"),
    );
    fixture.host.saveModelPreferences.mockResolvedValue({
      saved: true,
      warning: "Saved to Pi. Reload settings before the next edit.",
    });
    render(<ModelsSettings />);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Login is unavailable",
    );
    expect(screen.getByRole("button", { name: "Add provider" })).toBeEnabled();
    fireEvent.click(screen.getByText(/Common order and rules/));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove custom/local:high from common models",
      }),
    );
    await screen.findByText(
      "Saved to Pi. Reload settings before the next edit.",
    );
    expect(
      screen.getByRole("button", { name: "Refresh available models" }),
    ).toBeEnabled();
  });

  it("reads settings again for a changed session and a replaced Host", async () => {
    const view = render(<ModelsSettings />);
    await screen.findByRole("combobox", { name: "Default thinking" });
    fixture.state = { sessionId: "two", cwd: "/two", transportGeneration: 1 };
    view.rerender(<ModelsSettings />);
    await waitFor(() =>
      expect(fixture.host.readModelSettings).toHaveBeenLastCalledWith(
        { sessionId: "two" },
        true,
      ),
    );

    fixture.host.readModelSettings.mockResolvedValue(
      modelSettingsSnapshot({ modelsWarning: "Replacement Host warning" }),
    );
    fixture.state = { ...fixture.state, transportGeneration: 2 };
    view.rerender(<ModelsSettings />);
    await screen.findByText("Replacement Host warning");
  });

  it("does not invoke old-owner callbacks after logout settles across a session/transport change", async () => {
    const logout = deferred<null>();
    fixture.host.providerAuth.mockImplementation(async (owner, operation) =>
      operation.operation === "logout"
        ? logout.promise
        : owner.sessionId === "one"
          ? loginProviders()
          : [
              {
                id: "new-owner",
                name: "New owner provider",
                stored: null,
                methods: [],
              },
            ],
    );
    const view = render(<ModelsSettings />);
    await screen.findByText("Anthropic");
    fireEvent.click(screen.getByRole("button", { name: "Manage Anthropic" }));
    fireEvent.click(
      screen.getByRole("button", {
        name: "Remove saved credentials for Anthropic",
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Remove saved credentials" }),
    );
    fixture.state = { sessionId: "two", cwd: "/two", transportGeneration: 2 };
    view.rerender(<ModelsSettings />);
    const connect = screen.getByRole("button", { name: "Connect provider" });
    await waitFor(() => expect(connect).toBeEnabled());
    fireEvent.click(connect);
    await screen.findByText("New owner provider");
    const afterChange = fixture.host.readModelSettings.mock.calls.length;
    await act(async () => logout.resolve(null));
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
    expect(
      fixture.host.providerAuth.mock.calls.filter(
        ([owner, operation]) =>
          owner.sessionId === "one" && operation.operation === "providers",
      ),
    ).toHaveLength(1);
    expect(fixture.host.readModelSettings).toHaveBeenCalledTimes(afterChange);
  });
});

it("retires a configuration read and write when their shared document owner changes", async () => {
  const read = deferred<string>();
  const write = deferred<{ snapshot: string; warning: string }>();
  const { result, rerender } = renderHook(
    ({ owner }) => useConfigurationDocument<string>(owner, "Unavailable"),
    { initialProps: { owner: "old" } },
  );
  const startRead = () => void result.current.load(() => read.promise);
  const startWrite = () => void result.current.write(() => write.promise);
  act(startRead);
  rerender({ owner: "replacement" });
  await act(async () => read.resolve("old read"));
  expect(result.current.snapshot).toBeNull();

  act(startWrite);
  expect(result.current.busy).toBe(true);
  rerender({ owner: "latest" });
  await act(async () =>
    write.resolve({ snapshot: "old write", warning: "old warning" }),
  );
  expect(result.current).toMatchObject({
    snapshot: null,
    busy: false,
    error: null,
  });
  await act(async () => {
    await result.current.load(async () => "current");
  });
  expect(result.current).toMatchObject({
    snapshot: "current",
    busy: false,
    error: null,
    readFailed: false,
  });
});
