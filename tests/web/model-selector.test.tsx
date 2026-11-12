// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "../../src/components/ModelSelector";
import { supportedThinkingLevels } from "../../src/model-options";
import { mockModelMenuLayout } from "./fixtures/model-menu-layout";

beforeEach(mockModelMenuLayout);

const models = [
  {
    provider: "anthropic",
    id: "claude-sonnet",
    name: "Claude Sonnet",
    reasoning: true,
  },
  {
    provider: "anthropic",
    id: "claude-haiku",
    name: "Claude Haiku",
    reasoning: false,
  },
  { provider: "openai", id: "gpt-5", name: "GPT 5", reasoning: true },
];

describe("model picker interaction", () => {
  it.each([
    { state: "disabled", disabled: true, choices: models },
    { state: "unavailable", disabled: false, choices: [] },
  ])(
    "closes an open picker when $state without changing or reopening the selection",
    ({ disabled, choices }) => {
      const change = vi.fn();
      const props = {
        value: models[0]!,
        models,
        recent: [],
        onChange: change,
      };
      const view = render(<ModelSelector {...props} />);
      const trigger = screen.getByRole("button", { name: "Model" });
      fireEvent.click(trigger);
      expect(
        screen.getByRole("listbox", { name: "Available models" }),
      ).toBeInTheDocument();

      view.rerender(
        <ModelSelector {...props} models={choices} disabled={disabled} />,
      );
      expect(trigger).toBeDisabled();
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      expect(
        screen.queryByRole("listbox", { name: "Available models" }),
      ).not.toBeInTheDocument();
      fireEvent.keyDown(trigger, { key: "ArrowDown" });
      expect(
        screen.queryByRole("listbox", { name: "Available models" }),
      ).not.toBeInTheDocument();
      expect(change).not.toHaveBeenCalled();

      view.rerender(<ModelSelector {...props} />);
      expect(trigger).toBeEnabled();
      expect(trigger).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(trigger);
      fireEvent.click(screen.getByRole("option", { name: /Claude Haiku/ }));
      expect(change).toHaveBeenCalledExactlyOnceWith(
        models[1]!.provider,
        models[1]!.id,
      );
    },
  );

  it("highlights model identity matches and selects the matching provider even when names and IDs coincide", async () => {
    const choices = [
      { provider: "openai", id: "alpha", name: "alpha" },
      { provider: "custom", id: "folder/chat", name: "Nested chat" },
      { provider: "local", id: "folder/chat", name: "Nested chat" },
    ];
    const change = vi.fn();
    render(
      <ModelSelector
        value={choices[2]!}
        models={choices}
        common={[choices[0]!]}
        recent={[]}
        onChange={change}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Model" });
    fireEvent.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "OPENAI/ALPHA" } });
    expect(screen.getByRole("option")).toHaveAccessibleName(/openai\/alpha/);

    fireEvent.change(search, { target: { value: "nedct" } });
    const nested = screen.getByTitle("Nested chat — custom/folder/chat");
    expect(
      Array.from(
        nested.querySelectorAll(".search-match"),
        (node) => node.textContent,
      ).join(""),
    ).toBe("Nedct");

    fireEvent.change(search, { target: { value: "custom/folder/chat" } });
    expect(screen.getByRole("option")).toHaveAccessibleName(
      /Nested chat.*folder\/chat/,
    );
    expect(
      screen.getByRole("option").querySelector(".search-match"),
    ).toHaveTextContent(/^folder\/chat$/);
    expect(
      document.querySelector(".model-picker__heading .search-match"),
    ).toHaveTextContent(/^custom$/);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(change).toHaveBeenCalledWith("custom", "folder/chat");
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("keeps the selected model when pointer hover ends and resumes keyboard navigation", () => {
    const change = vi.fn();
    render(
      <ModelSelector
        value={models[0]!}
        models={models}
        recent={[]}
        onChange={change}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const search = screen.getByRole("combobox", { name: "Search models" });
    const hover = screen.getByRole("option", { name: /Claude Haiku/ });
    fireEvent.pointerMove(hover, { pointerType: "mouse" });
    fireEvent.mouseLeave(hover);
    expect(search).not.toHaveAttribute("aria-activedescendant");
    expect(
      screen.getByRole("option", { name: /Claude Sonnet/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(change).not.toHaveBeenCalled();

    fireEvent.keyDown(search, { key: "End" });
    fireEvent.keyDown(search, { key: "Enter" });
    expect(change).toHaveBeenCalledWith("openai", "gpt-5");
  });

  it("keeps configured Common order above recency and removes the group when unconfigured", () => {
    const view = render(
      <ModelSelector
        value={models[2]!}
        models={models}
        recent={[models[0]!]}
        common={[models[2]!, models[1]!]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(
      screen
        .getAllByRole("option")
        .map(
          (option) =>
            option.textContent?.match(/GPT 5|Claude Haiku|Claude Sonnet/)?.[0],
        ),
    ).toEqual(["GPT 5", "Claude Haiku", "Claude Sonnet"]);
    expect(screen.getByText("Common models")).toBeVisible();
    expect(
      screen.getByRole("option", { name: /Claude Haiku.*No thinking/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: /Claude Sonnet.*Recent/ }),
    ).toBeVisible();
    expect(
      screen.getByRole("option", { name: /GPT 5/, selected: true }),
    ).toBeVisible();
    view.rerender(
      <ModelSelector
        value={models[2]!}
        models={models}
        recent={[]}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText("Common models")).not.toBeInTheDocument();
  });

  it("shows an unavailable selection and refresh failure without claiming cached choices when discovery failed", async () => {
    render(
      <ModelSelector
        value={null}
        models={[]}
        recent={[]}
        onChange={vi.fn()}
        refreshModels={async () => {
          throw new Error("broken startup extension");
        }}
      />,
    );
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "Model unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading models");
    expect(screen.queryByText("No models available yet.")).toBeNull();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Could not refresh models",
      ),
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("cached choices");
    expect(screen.queryAllByRole("option")).toEqual([]);
  });

  it("keeps cached choices and the keyboard selection usable as refresh reorders models and then fails", async () => {
    let fail!: (error: Error) => void;
    const refreshModels = () =>
      new Promise<string | undefined>((_resolve, reject) => {
        fail = reject;
      });
    const choices = [
      { provider: "fixture", id: "a", name: "Model Alpha" },
      { provider: "fixture", id: "b", name: "Model Beta" },
      { provider: "fixture", id: "c", name: "Model Gamma" },
    ];
    const onChange = vi.fn();
    const props = {
      value: choices[0]!,
      models: choices,
      recent: [],
      onChange,
      refreshModels,
    };
    const view = render(<ModelSelector {...props} />);
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(
      screen.getByRole("option", { name: /Model Alpha/, selected: true }),
    ).toBeVisible();
    const search = screen.getByRole("combobox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "model" } });
    fireEvent.keyDown(search, { key: "ArrowDown" });
    view.rerender(
      <ModelSelector
        {...props}
        models={[
          ...choices,
          { provider: "fixture", id: "0", name: "Model Added" },
        ]}
        recent={[choices[2]!]}
      />,
    );
    expect(screen.getByRole("option", { name: /Model Added/ })).toBeVisible();
    await act(async () => fail(new Error("offline")));
    expect(screen.getByRole("status")).toHaveTextContent("Could not refresh");
    expect(search).toHaveValue("model");
    expect(search).toHaveFocus();
    fireEvent.keyDown(search, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("fixture", "b");
  });
});

describe("new-session thinking choices", () => {
  it("mirrors Pi's metadata rules for ordinary, extended, and unsupported reasoning", () => {
    expect(supportedThinkingLevels(null)).toEqual([
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(
      supportedThinkingLevels({ provider: "p", id: "plain", reasoning: false }),
    ).toEqual(["off"]);
    expect(
      supportedThinkingLevels({
        provider: "p",
        id: "reasoning",
        reasoning: true,
      }),
    ).toEqual(["off", "minimal", "low", "medium", "high"]);
    expect(
      supportedThinkingLevels({
        provider: "p",
        id: "mapped",
        reasoning: true,
        thinkingLevelMap: { minimal: null, xhigh: "high", max: "high" },
      }),
    ).toEqual(["off", "low", "medium", "high", "xhigh", "max"]);
  });
});
