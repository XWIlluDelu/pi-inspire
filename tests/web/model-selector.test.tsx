// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  groupModels,
  groupPreparedModels,
  placeModelMenu,
  prepareModelOptions,
} from "../../src/components/ModelSelector";
import { ModelSelector } from "../../src/components/ModelSelector";

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

describe("model grouping", () => {
  it("groups by canonical provider and uses MRU only within that provider", () => {
    const groups = groupModels(models, [
      { provider: "unavailable", id: "gone" },
      { provider: "anthropic", id: "claude-haiku" },
    ]);
    expect(groups.map((group) => group.provider)).toEqual([
      "anthropic",
      "openai",
    ]);
    expect(groups[0]!.models.map((model) => model.id)).toEqual([
      "claude-haiku",
      "claude-sonnet",
    ]);
  });

  it("filters repeated large queries linearly without comparison sorting", () => {
    const large = Array.from({ length: 5_000 }, (_, index) => ({
      provider: `provider-${index % 25}`,
      id: `model-${index}`,
      name: `Model ${index}`,
    }));
    const prepareMetrics = { comparisons: 0, visits: 0 };
    const prepared = prepareModelOptions(large, prepareMetrics);
    expect(prepareMetrics.comparisons).toBeGreaterThan(0);
    const queryMetrics = { comparisons: 0, visits: 0 };
    for (const query of ["model 1", "provider-7", "m4999", "missing"]) {
      groupPreparedModels(prepared, [], query, queryMetrics);
    }
    expect(queryMetrics.comparisons).toBe(0);
    expect(queryMetrics.visits).toBeLessThan(4 * large.length * 80);
  });

  it("fuzzy-searches provider, model id, and display name", () => {
    expect(
      groupModels(models, [], "anth snnt")
        .flatMap((group) => group.models)
        .map((model) => model.id),
    ).toEqual(["claude-sonnet"]);
    expect(
      groupModels(models, [], "gpt5")
        .flatMap((group) => group.models)
        .map((model) => model.id),
    ).toEqual(["gpt-5"]);
  });
});

describe("model picker placement", () => {
  const bounds = { left: 0, top: 64, right: 390, bottom: 430 };

  it("flips below when the mobile keyboard leaves too little room above", () => {
    const placement = placeModelMenu(
      { left: 12, top: 100, right: 140, bottom: 136 },
      bounds,
      430,
    );

    expect(placement).toMatchObject({
      direction: "down",
      left: 16,
      top: 140,
      width: 358,
      maxHeight: 282,
    });
    expect(placement.top! + placement.maxHeight).toBe(422);
  });
});

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
    expect(within(list).getAllByRole("option")).toHaveLength(3);
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
