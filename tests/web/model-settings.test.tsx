// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { store } from "../../src/store";
import { mockModelMenuLayout } from "./fixtures/model-menu-layout";
import {
  loginProviders,
  modelSettingsSnapshot,
} from "./fixtures/model-settings";

const fixture = vi.hoisted(() => ({
  state: { sessionId: "one", cwd: "/one", transportGeneration: 1 },
  host: {
    readModelSettings: vi.fn(),
    saveModelPreferences: vi.fn<typeof store.saveModelPreferences>(),
    editModelConfig: vi.fn(),
    providerAuth: vi.fn(),
    refreshModels: vi.fn(),
  },
}));
vi.mock("../../src/store", () => ({
  store: fixture.host,
  useAppState: (selector: (state: typeof fixture.state) => unknown) =>
    selector(fixture.state),
  shallowEqual: () => false,
}));

import { ModelsSettings } from "../../src/components/ModelsSettings";
import { SettingsDialog } from "../../src/components/SettingsDialog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function openDeclarations() {
  const section = await screen.findByRole("region", {
    name: "Custom providers",
  });
  const showButton = within(section).queryByRole("button", { name: "Show" });
  if (showButton) {
    fireEvent.click(showButton);
  }
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
  fixture.host.refreshModels.mockResolvedValue(undefined);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("Models settings configuration and ownership", () => {
  it("round-trips startup defaults and clears native preferences", async () => {
    let snapshot = modelSettingsSnapshot();
    fixture.host.readModelSettings.mockImplementation(async () => snapshot);
    fixture.host.saveModelPreferences.mockImplementation(
      async (_owner, _revision, patch) => {
        snapshot = {
          ...snapshot,
          saved: { ...snapshot.saved, ...patch },
          settingsRevision: "c".repeat(64),
        };
        return { saved: true, snapshot };
      },
    );
    const view = render(<ModelsSettings />);
    const thinking = await screen.findByRole("combobox", {
      name: "Default thinking",
    });
    expect(snapshot.saved.defaultThinkingLevel).toBeNull();
    fireEvent.click(thinking);
    fireEvent.click(screen.getByRole("option", { name: "xhigh" }));
    await waitFor(() => expect(thinking).toHaveTextContent("xhigh"));
    fireEvent.click(
      screen.getByRole("button", { name: "Set Claude Haiku as default" }),
    );
    await screen.findByRole("button", { name: "Clear default model" });
    view.unmount();
    render(<ModelsSettings />);
    const reloadedThinking = await screen.findByRole("combobox", {
      name: "Default thinking",
    });
    expect(reloadedThinking).toHaveTextContent("xhigh");
    expect(
      document.querySelector(".models-default-value__name"),
    ).toHaveTextContent("Claude Haiku");
    const clearDefault = screen.getByRole("button", {
      name: "Clear default model",
    });
    clearDefault.focus();
    fireEvent.click(clearDefault);
    await waitFor(() => expect(snapshot.saved.defaultModel).toBeNull());
    expect(
      screen.queryByRole("button", { name: "Clear default model" }),
    ).not.toBeInTheDocument();
    await waitFor(() => expect(reloadedThinking).toHaveFocus());
    fireEvent.click(reloadedThinking);
    fireEvent.click(screen.getByRole("option", { name: /Model default/ }));
    await waitFor(() => expect(snapshot.saved.defaultThinkingLevel).toBeNull());
    expect(fixture.host.saveModelPreferences).toHaveBeenLastCalledWith(
      { sessionId: "one" },
      "c".repeat(64),
      { defaultThinkingLevel: null },
    );
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
    ).toHaveTextContent("xhigh");
    expect(screen.getByText(/This project uses GPT 5\./)).toBeInTheDocument();
    expect(screen.getByText(/This project uses low\./)).toBeInTheDocument();
  });

  it("never labels unreadable preferences as unset and recovers failed initial reads", async () => {
    fixture.host.readModelSettings.mockRejectedValue(
      new Error("Cannot read model settings"),
    );
    render(<ModelsSettings />);
    await screen.findByRole("button", { name: "Retry loading models" });
    expect(screen.queryByText("None")).not.toBeInTheDocument();
    expect(screen.queryByText("Loading models…")).not.toBeInTheDocument();
    fixture.host.readModelSettings.mockResolvedValue(
      modelSettingsSnapshot({ settingsError: "Invalid Pi settings" }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Retry loading models" }),
    );
    const thinking = await screen.findByRole("combobox", {
      name: "Default thinking",
    });
    expect(thinking).toHaveTextContent("Unavailable");
    expect(thinking).toBeDisabled();
    expect(document.querySelector(".models-default-result")).toHaveTextContent(
      "Unavailable",
    );
    expect(screen.queryByText("None")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Set Claude Haiku as default" }),
    ).toBeDisabled();
  });

  it("starts empty with provider creation, no duplicate selection controls or common placeholders", async () => {
    fixture.host.providerAuth.mockResolvedValue([]);
    fixture.host.readModelSettings.mockResolvedValue(
      modelSettingsSnapshot({
        providers: [],
        models: [],
        commonModels: [],
        savedCommonEntries: [],
        saved: {
          defaultModel: null,
          defaultThinkingLevel: null,
          enabledModels: [],
        },
      }),
    );
    render(<ModelsSettings />);
    await screen.findByText("No models available yet.");
    expect(screen.getByRole("button", { name: "Add provider" })).toBeEnabled();
    expect(
      screen.queryByLabelText("Provider", { exact: true }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add model" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Common order and rules/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Default model" }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("grid", { name: "Available models" })).toHaveClass(
      "model-picker__list--empty",
    );
  });
  it("uses an explicit prospective owner for reads and edits without borrowing the selected session", async () => {
    fixture.host.saveModelPreferences.mockResolvedValue({
      saved: true,
      snapshot: modelSettingsSnapshot(),
    });
    render(
      <ModelsSettings
        destination={{ owner: { cwd: "/prospective-project" } }}
      />,
    );
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Set Claude Haiku as default",
      }),
    );
    expect(fixture.host.readModelSettings).toHaveBeenCalledWith({
      cwd: "/prospective-project",
    });
    await waitFor(() =>
      expect(fixture.host.saveModelPreferences).toHaveBeenCalledWith(
        { cwd: "/prospective-project" },
        "a".repeat(64),
        { defaultModel: { provider: "anthropic", id: "claude-haiku" } },
      ),
    );
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
    const list = await screen.findByRole("grid", { name: "Available models" });
    expect(
      document.querySelector(".models-default-value__name"),
    ).toHaveTextContent("Local model");
    expect(document.querySelector("datalist")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Default model" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Add to common" }),
    ).not.toBeInTheDocument();
    expect(within(list).queryByText("Local model")).not.toBeInTheDocument();
    fireEvent.click(
      within(list).getByRole("button", { name: "Add GPT 5 to common" }),
    );
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
    const patternRow = within(list)
      .getByText("Claude Haiku")
      .closest("[role=row]")! as HTMLElement;
    expect(within(patternRow).getByText("Common")).toBeInTheDocument();
    expect(
      within(patternRow).queryByText(/Common via/),
    ).not.toBeInTheDocument();
    expect(
      within(patternRow).queryByRole("button", { name: /Remove.*from common/ }),
    ).not.toBeInTheDocument();
    fireEvent.click(
      within(patternRow).getByRole("button", {
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
    const remove = await screen.findByRole("button", {
      name: "Remove Local model from common",
    });
    expect(remove).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.queryByRole("button", {
        name: "Edit common pattern for Local model",
      }),
    ).not.toBeInTheDocument();
    fireEvent.click(remove);
    await waitFor(() =>
      expect(fixture.host.saveModelPreferences).toHaveBeenCalledWith(
        { sessionId: "one" },
        "a".repeat(64),
        { enabledModels: ["*gpt*:high"] },
      ),
    );
    expect(
      screen.queryByRole("textbox", { name: "Model pattern" }),
    ).not.toBeInTheDocument();
    expect(fixture.host.editModelConfig).not.toHaveBeenCalled();
  });

  it("resets provider drafts across Edit ↔ Add and submits the displayed target", async () => {
    const snapshot = modelSettingsSnapshot();
    const provider = snapshot.providers[0]!;
    provider.id = "new";
    fixture.host.readModelSettings.mockResolvedValue(snapshot);
    fixture.host.editModelConfig.mockResolvedValue({ saved: true, snapshot });
    render(<ModelsSettings />);
    await openDeclarations();
    fireEvent.click(screen.getByRole("button", { name: "Edit provider new" }));
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://unsaved-existing.test" },
    });
    fireEvent.click(screen.getByLabelText("Remove API key"));
    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    expect(screen.getByLabelText("Provider ID")).toHaveValue("");
    expect(screen.getByLabelText("Provider ID")).not.toBeDisabled();
    expect(screen.getByLabelText("Base URL")).toHaveValue("");
    expect(screen.getByLabelText("API key")).toHaveAttribute(
      "placeholder",
      "Optional",
    );
    fireEvent.change(screen.getByLabelText("Provider ID"), {
      target: { value: "different-provider" },
    });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://other-draft.test" },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "unsaved-secret" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Edit provider new" }));
    expect(screen.getByLabelText("Provider ID")).toHaveValue("new");
    expect(screen.getByLabelText("Provider ID")).toBeDisabled();
    expect(screen.getByLabelText("Base URL")).toHaveValue(
      provider.baseUrl ?? "",
    );
    expect(screen.getByLabelText("API key")).toHaveValue("");
    expect(screen.getByLabelText("Remove API key")).not.toBeChecked();
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://new-target.test/v1" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() =>
      expect(fixture.host.editModelConfig).toHaveBeenCalledWith(
        { sessionId: "one" },
        "b".repeat(64),
        {
          kind: "provider",
          id: "new",
          values: { baseUrl: "https://new-target.test/v1" },
        },
      ),
    );
  });

  it("prioritizes startup defaults and keeps custom connection fields behind their disclosure", async () => {
    render(<ModelsSettings />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Add provider" }),
    );
    expect(
      screen
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent),
    ).toEqual(["Models", "Login & API keys", "Custom providers"]);
    expect(
      screen.getByRole("region", { name: "Models" }).nextElementSibling,
    ).toBe(screen.getByRole("region", { name: "Login & API keys" }));
    expect(
      screen.getByRole("region", { name: "Login & API keys" })
        .nextElementSibling,
    ).toBe(screen.getByRole("region", { name: "Custom providers" }));
    const inputs = [...document.querySelectorAll(".models-form input")];
    for (const [index, name] of [
      "Provider ID",
      "Base URL",
      "API type",
      "API key",
    ].entries())
      expect(inputs[index]).toHaveAccessibleName(name);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Add model to custom" }),
    );
    expect(
      [...document.querySelectorAll(".models-form input")]
        .map((input) => input.closest("label")?.textContent?.trim())
        .slice(0, 7),
    ).toEqual([
      "Model ID",
      "Display name",
      "Thinking supported",
      "Text input",
      "Image input",
      "Context window",
      "Maximum output tokens",
    ]);
    expect(
      screen.getByText("Connection overrides").closest("details"),
    ).not.toHaveAttribute("open");
    expect(screen.queryByText("New session defaults")).not.toBeInTheDocument();
  });

  it("saves a row default and native common order independently", async () => {
    let snapshot = modelSettingsSnapshot();
    fixture.host.readModelSettings.mockImplementation(async () => snapshot);
    fixture.host.saveModelPreferences.mockImplementation(
      async (_owner, _revision, patch) => {
        snapshot = {
          ...snapshot,
          saved: { ...snapshot.saved, ...patch },
          settingsRevision: "c".repeat(64),
        };
        return { saved: true, snapshot };
      },
    );
    render(<ModelsSettings />);
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Set Claude Haiku as default",
      }),
    );
    await waitFor(() =>
      expect(fixture.host.saveModelPreferences).toHaveBeenCalledWith(
        { sessionId: "one" },
        "a".repeat(64),
        { defaultModel: { provider: "anthropic", id: "claude-haiku" } },
      ),
    );
    fireEvent.click(screen.getByText(/Common order and rules/));
    fireEvent.click(
      screen.getByRole("button", { name: "Move custom/local:high down" }),
    );
    await waitFor(() =>
      expect(fixture.host.saveModelPreferences).toHaveBeenLastCalledWith(
        { sessionId: "one" },
        "c".repeat(64),
        { enabledModels: ["openai/gpt-5", "custom/local:high"] },
      ),
    );
    expect(snapshot.saved.defaultModel).toEqual({
      provider: "anthropic",
      id: "claude-haiku",
    });
  });

  it("preserves an untouched configured key and refreshes providers after the committed config save", async () => {
    const snapshot = modelSettingsSnapshot();
    fixture.host.editModelConfig.mockResolvedValue({ saved: true, snapshot });
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
    fireEvent.click(
      screen.getByRole("button", { name: "Edit provider custom" }),
    );
    expect(screen.getByLabelText("API key")).toHaveValue("");
    fireEvent.click(screen.getByRole("button", { name: "Save provider" }));
    await waitFor(() =>
      expect(fixture.host.editModelConfig).toHaveBeenCalledWith(
        { sessionId: "one" },
        "b".repeat(64),
        { kind: "provider", id: "custom", values: {} },
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect provider" }));
    await screen.findByText("Configured custom provider");
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Save provider" }),
    ).not.toBeInTheDocument();
  });

  it("continues provider → available model → row actions and cancellation without stealing a later focus move", async () => {
    let current = modelSettingsSnapshot();
    const configured = structuredClone(current);
    configured.providers.push({
      id: "new-provider",
      baseUrl: "https://fixture.test/v1",
      api: "custom-api",
      apiKeyConfigured: true,
      models: [],
      advancedFields: [],
    });
    const declared = structuredClone(configured);
    declared.providers
      .at(-1)!
      .models.push({ id: "new-model", name: "New model", advancedFields: [] });
    declared.models.push({
      ...declared.models[0]!,
      provider: "new-provider",
      id: "new-model",
      name: "New model",
    });
    fixture.host.readModelSettings.mockResolvedValue(current);
    fixture.host.editModelConfig
      .mockResolvedValueOnce({ saved: true, snapshot: configured })
      .mockResolvedValueOnce({ saved: true, snapshot: declared });
    let finishSave: (() => void) | undefined;
    fixture.host.saveModelPreferences.mockImplementation(
      (_owner, _revision, patch) =>
        new Promise((resolve) => {
          finishSave = () => {
            current = {
              ...current,
              saved: { ...current.saved, ...patch },
              savedCommonEntries: patch.enabledModels
                ? patch.enabledModels.map((pattern) =>
                    pattern === "new-provider/new-model"
                      ? {
                          pattern,
                          models: [
                            { provider: "new-provider", id: "new-model" },
                          ],
                        }
                      : current.savedCommonEntries.find(
                          (entry) => entry.pattern === pattern,
                        )!,
                  )
                : current.savedCommonEntries,
            };
            resolve({ saved: true, snapshot: current });
          };
        }),
    );
    render(
      <SettingsDialog onClose={vi.fn()}>
        <ModelsSettings />
      </SettingsDialog>,
    );
    fireEvent.click(
      await screen.findByRole("button", { name: "Add provider" }),
    );
    fireEvent.change(screen.getByLabelText("Provider ID"), {
      target: { value: "new-provider" },
    });
    fireEvent.change(screen.getByLabelText("Base URL"), {
      target: { value: "https://fixture.test/v1" },
    });
    fireEvent.change(screen.getByLabelText("API type"), {
      target: { value: "custom-api" },
    });
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "synthetic-key" },
    });
    const saveProvider = screen.getByRole("button", { name: "Save provider" });
    saveProvider.focus();
    fireEvent.click(saveProvider);
    const addModel = await screen.findByRole("button", {
      name: "Add model to new-provider",
    });
    await waitFor(() => expect(addModel).toHaveFocus());
    const search = screen.getByRole("combobox", {
      name: "Search available models",
    });
    fireEvent.change(search, {
      target: { value: "no previous matching model" },
    });
    fireEvent.click(addModel);
    fireEvent.change(screen.getByLabelText("Model ID"), {
      target: { value: "new-model" },
    });
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "New model" },
    });
    const saveModel = screen.getByRole("button", { name: "Save model" });
    saveModel.focus();
    fireEvent.click(saveModel);
    const common = await screen.findByRole("button", {
      name: "Add New model to common",
    });
    await waitFor(() => expect(common).toHaveFocus());
    expect(search).toHaveValue("");
    current = declared;
    fireEvent.change(search, { target: { value: "New model" } });
    expect(screen.getByRole("grid", { name: "Available models" })).toHaveStyle({
      height: "76px",
    });
    common.focus();
    fireEvent.click(common);
    await waitFor(() => expect(common).toBeDisabled());
    common.blur();
    finishSave!();
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Remove New model from common" }),
      ).toHaveFocus(),
    );
    const setDefault = screen.getByRole("button", {
      name: "Set New model as default",
    });
    setDefault.focus();
    fireEvent.click(setDefault);
    await waitFor(() => expect(setDefault).toBeDisabled());
    setDefault.blur();
    finishSave!();
    await waitFor(() => expect(setDefault).toHaveFocus());
    const remove = screen.getByRole("button", {
      name: "Remove New model from common",
    });
    remove.focus();
    fireEvent.click(remove);
    await waitFor(() => expect(remove).toBeDisabled());
    search.focus();
    finishSave!();
    await waitFor(() => expect(remove).not.toBeDisabled());
    expect(search).toHaveFocus();
    const editModel = screen.getByRole("button", {
      name: "Edit model new-provider/new-model",
    });
    editModel.focus();
    fireEvent.click(editModel);
    const cancel = screen.getByRole("button", { name: "Cancel" });
    cancel.focus();
    fireEvent.click(cancel);
    await waitFor(() => expect(editModel).toHaveFocus());
  });

  it("requires unresolved model API fields and shows submission errors in the current form while allowing native inheritance", async () => {
    const snapshot = modelSettingsSnapshot();
    delete snapshot.providers[0]!.api;
    snapshot.providers[0]!.models = [];
    fixture.host.readModelSettings.mockResolvedValue(snapshot);
    fixture.host.editModelConfig.mockRejectedValue(
      new Error("Pi rejected this declaration"),
    );
    const view = render(<ModelsSettings />);
    await openDeclarations();
    fireEvent.click(
      screen.getByRole("button", { name: "Add model to custom" }),
    );
    fireEvent.change(screen.getByLabelText("Model ID"), {
      target: { value: "new-model" },
    });
    const api = screen.getByLabelText("API type");
    expect(api).toBeRequired();
    expect((api as HTMLInputElement).validity.valueMissing).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
    expect(fixture.host.editModelConfig).not.toHaveBeenCalled();
    fireEvent.change(api, { target: { value: "custom-stream-api" } });
    const submit = screen.getByRole("button", { name: "Save model" });
    submit.focus();
    fireEvent.click(submit);
    const error = await screen.findByRole("alert");
    expect(error.closest("form")).toBe(submit.closest("form"));
    await waitFor(() => expect(error).toHaveFocus());
    expect(fixture.host.editModelConfig).toHaveBeenCalledWith(
      { sessionId: "one" },
      "b".repeat(64),
      expect.objectContaining({
        values: expect.objectContaining({ api: "custom-stream-api" }),
      }),
    );
    view.unmount();
    fixture.host.editModelConfig
      .mockClear()
      .mockResolvedValue({ saved: true, snapshot });
    snapshot.providers[0]!.id = "openai";
    snapshot.nativeApiProviders = ["openai"];
    snapshot.models = [];
    render(<ModelsSettings />);
    await openDeclarations();
    fireEvent.click(
      screen.getByRole("button", { name: "Add model to openai" }),
    );
    expect(screen.getByLabelText("API override")).toHaveAttribute(
      "placeholder",
      "Use default",
    );
    expect(screen.queryByLabelText("API type")).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Model ID"), {
      target: { value: "inherited-api-model" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
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
    expect(
      screen.getByRole("grid", { name: "Available models" }),
    ).toHaveAttribute("aria-rowcount", "0");
  });

  it("keeps the inline grid and its active row actions in Settings focus ownership", async () => {
    render(
      <SettingsDialog onClose={vi.fn()}>
        <ModelsSettings />
      </SettingsDialog>,
    );
    const search = await screen.findByRole("combobox", {
      name: "Search available models",
    });
    search.focus();
    expect(search).not.toHaveAttribute("aria-activedescendant");
    expect(document.querySelector(".dropdown__option--active")).toBeNull();
    fireEvent.change(search, { target: { value: "gpt" } });
    expect(search).not.toHaveAttribute("aria-activedescendant");
    expect(document.querySelector(".dropdown__option--active")).toBeNull();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(fixture.host.saveModelPreferences).not.toHaveBeenCalled();
    fireEvent.keyDown(search, { key: "ArrowDown" });
    expect(
      document.getElementById(search.getAttribute("aria-activedescendant")!),
    ).toHaveClass("dropdown__option--active");
    fireEvent.blur(search);
    expect(search).not.toHaveAttribute("aria-activedescendant");
    fireEvent.change(search, { target: { value: "" } });
    search.focus();
    fireEvent.keyDown(search, { key: "End" });
    const active = document.getElementById(
      search.getAttribute("aria-activedescendant")!,
    )!;
    expect(active).toHaveTextContent("GPT 5");
    expect(
      within(active).getByRole("button", { name: "Remove GPT 5 from common" }),
    ).toHaveAttribute("tabindex", "0");
    expect(
      screen.getByRole("button", { name: "Set Claude Haiku as default" }),
    ).toHaveAttribute("tabindex", "-1");
  });

  it("owns typed declaration fields by the full model identity", async () => {
    const snapshot = modelSettingsSnapshot();
    snapshot.providers[0]!.models = [
      {
        id: "same ",
        type: "embedding",
        name: "Embedding model",
        advancedFields: [],
      },
      {
        id: "same ",
        type: "chat",
        name: "Chat model",
        contextWindow: 0,
        maxTokens: 0.5,
        advancedFields: [],
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
    fireEvent.click(screen.getByRole("button", { name: "Save model" }));
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

  it("does not publish an old refresh warning after its settings read crosses an owner change", async () => {
    const readback = deferred<ReturnType<typeof modelSettingsSnapshot>>();
    fixture.host.readModelSettings
      .mockResolvedValueOnce(modelSettingsSnapshot())
      .mockReturnValueOnce(readback.promise);
    fixture.host.refreshModels
      .mockResolvedValueOnce("Old worker warning")
      .mockResolvedValue(undefined);
    const view = render(<ModelsSettings />);
    await waitFor(() =>
      expect(fixture.host.readModelSettings).toHaveBeenCalledTimes(2),
    );

    fixture.state = { sessionId: "two", cwd: "/two", transportGeneration: 2 };
    view.rerender(<ModelsSettings />);
    await waitFor(() =>
      expect(fixture.host.readModelSettings).toHaveBeenCalledTimes(4),
    );
    await act(async () => readback.resolve(modelSettingsSnapshot()));
    expect(screen.queryByText("Old worker warning")).not.toBeInTheDocument();
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
    const before = fixture.host.refreshModels.mock.calls.length;
    fixture.state = { sessionId: "two", cwd: "/two", transportGeneration: 2 };
    view.rerender(<ModelsSettings />);
    fireEvent.click(screen.getByRole("button", { name: "Connect provider" }));
    await screen.findByText("New owner provider");
    const afterChange = fixture.host.refreshModels.mock.calls.length;
    expect(afterChange).toBeGreaterThan(before);
    await act(async () => logout.resolve(null));
    expect(screen.queryByText("Anthropic")).not.toBeInTheDocument();
    expect(
      fixture.host.providerAuth.mock.calls.filter(
        ([owner, operation]) =>
          owner.sessionId === "one" && operation.operation === "providers",
      ),
    ).toHaveLength(1);
    expect(fixture.host.refreshModels).toHaveBeenCalledTimes(afterChange);
  });

  it("opens provider discovery and its matching native methods for an explicit credentials destination", async () => {
    render(
      <ModelsSettings
        destination={{ focus: "credentials", query: "copilot" }}
      />,
    );
    expect(
      await screen.findByRole("button", { name: "GitHub authorization" }),
    ).toBeEnabled();
    expect(screen.queryByLabelText("Search providers")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to providers" }));
    expect(screen.getByLabelText("Search providers")).toHaveValue("copilot");
    expect(screen.getByLabelText("Search providers")).toHaveFocus();
  });
});
