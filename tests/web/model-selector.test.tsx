// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ModelSelector } from "../../src/components/ModelSelector";
import { supportedThinkingLevels } from "../../src/model-options";

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
  it("keeps provider headings outside option navigation and exposes active/recent/capability labels", () => {
    const change = vi.fn();
    render(
      <ModelSelector
        value={models[0]!}
        models={models}
        recent={[{ provider: "anthropic", id: "claude-haiku" }]}
        onChange={change}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const list = screen.getByRole("listbox", { name: "Available models" });
    expect(within(list).getAllByRole("group")).toHaveLength(2);
    expect(
      within(list)
        .getAllByRole("option")
        .map(
          (option) =>
            option.textContent?.match(/Claude Haiku|Claude Sonnet|GPT 5/u)?.[0],
        ),
    ).toEqual(["Claude Haiku", "Claude Sonnet", "GPT 5"]);
    expect(
      within(list).getByRole("option", { name: /Claude Sonnet.*Active/ }),
    ).toBeInTheDocument();
    expect(
      within(list).getByRole("option", {
        name: /Claude Haiku.*Recent.*No thinking/,
      }),
    ).toBeInTheDocument();
  });

  it("keeps NUL-containing provider/id tuples structurally distinct", () => {
    const collisionModels = [
      { provider: "a\u0000b", id: "c", name: "First" },
      { provider: "a", id: "b\u0000c", name: "Second" },
    ];
    const change = vi.fn();
    render(
      <ModelSelector
        value={collisionModels[0]!}
        models={collisionModels}
        recent={[collisionModels[1]!]}
        onChange={change}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    fireEvent.click(screen.getByRole("option", { name: /Second.*Recent/ }));
    expect(change).toHaveBeenCalledWith("a", "b\u0000c");
  });

  it("filters locally and selects through keyboard without conflating display names with identity", () => {
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
    const trigger = screen.getByRole("button", { name: "Model" });
    const search = screen.getByRole("combobox", { name: "Search models" });
    expect(document.activeElement).toBe(search);
    fireEvent.change(search, { target: { value: "gpt5" } });
    expect(search).toHaveAttribute("aria-activedescendant");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(change).toHaveBeenCalledWith("openai", "gpt-5");
    expect(
      screen.queryByRole("listbox", { name: "Available models" }),
    ).not.toBeInTheDocument();
    return waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("restores trigger focus after pointer selection without awaiting async model ownership", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const change = vi.fn(() => pending);
    render(
      <ModelSelector
        value={models[0]!}
        models={models}
        recent={[]}
        onChange={change}
      />,
    );
    const trigger = screen.getByRole("button", { name: "Model" });
    fireEvent.click(trigger);
    const search = screen.getByRole("combobox", { name: "Search models" });
    expect(document.activeElement).toBe(search);
    fireEvent.click(screen.getByRole("option", { name: /GPT 5/ }));
    expect(change).toHaveBeenCalledWith("openai", "gpt-5");
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    release();
    await pending;
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
