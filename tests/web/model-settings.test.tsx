// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelsSettings } from "../../src/components/ModelsSettings";
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
  },
}));
vi.mock("../../src/store", () => ({
  store: fixture.host,
  useAppState: (selector: (state: typeof fixture.state) => unknown) =>
    selector(fixture.state),
  shallowEqual: () => false,
}));

async function selectDeclaration(label: string) {
  const section = await screen.findByRole("region", {
    name: "Custom providers",
  });
  const disclosure = within(section).getByLabelText(
    "Custom provider declarations",
  );
  if (!(disclosure.parentElement as HTMLDetailsElement).open)
    fireEvent.click(disclosure);
  const selection = await within(section).findByRole("combobox", {
    name: "Custom declaration",
  });
  const option = Array.from((selection as HTMLSelectElement).options).find(
    (option) => option.label === label,
  );
  expect(option).toBeDefined();
  fireEvent.change(selection, {
    target: { value: option!.value },
  });
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

  it("opens the native wildcard rule from an available model and edits the original pattern", async () => {
    const snapshot = modelSettingsSnapshot();
    const haiku = { provider: "anthropic", id: "claude-haiku" };
    const patterns = [
      "custom/local:high",
      "*haiku*:high",
      "anthropic/claude-haiku",
    ];
    snapshot.saved.enabledModels = patterns;
    snapshot.savedCommonEntries = patterns.map((pattern, index) => ({
      pattern,
      models: index ? [haiku] : [],
    }));
    fixture.host.readModelSettings.mockResolvedValue(snapshot);
    render(<ModelsSettings />);
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
    fireEvent.change(screen.getByRole("textbox", { name: "Model pattern" }), {
      target: { value: "*haiku*:medium" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() =>
      expect(fixture.host.saveModelPreferences).toHaveBeenCalledWith(
        { sessionId: "one" },
        snapshot.settingsRevision,
        {
          enabledModels: [
            "custom/local:high",
            "*haiku*:medium",
            "anthropic/claude-haiku",
          ],
        },
      ),
    );
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
    await selectDeclaration("custom/same (embedding)");
    fireEvent.click(
      screen.getByRole("button", {
        name: "Edit declared model custom/same (embedding)",
      }),
    );
    fireEvent.change(screen.getByLabelText("Display name"), {
      target: { value: "Unsaved embedding edit" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Back to models" }));
    await selectDeclaration("custom/same");
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
});
