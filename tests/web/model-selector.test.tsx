// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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
  it("closes an open picker when disabled without changing its selection", () => {
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

    view.rerender(<ModelSelector {...props} disabled />);
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

  it("keeps the keyboard selection by model identity when the catalog reorders", () => {
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
