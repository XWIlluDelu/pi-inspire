// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ModelSelector } from "../../src/components/ModelSelector";
import { supportedThinkingLevels } from "../../src/model-options";
import { mockModelMenuLayout } from "./fixtures/model-menu-layout";
import { mockTouchFirstDevice } from "./fixtures/touch-device";

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
  it("focuses the list on touch devices while retaining explicit search and keyboard selection", async () => {
    const touch = mockTouchFirstDevice();
    try {
      const change = vi.fn();
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
      const list = screen.getByRole("listbox", { name: "Available models" });
      const search = screen.getByRole("combobox", { name: "Search models" });
      expect(list).toHaveFocus();
      search.focus();
      fireEvent.change(search, { target: { value: "GPT" } });
      expect(search).toHaveFocus();
      expect(
        screen.queryByRole("option", { name: /Claude Sonnet/ }),
      ).toBeNull();
      list.focus();
      fireEvent.keyDown(list, { key: "End" });
      fireEvent.keyDown(list, { key: "Enter" });
      expect(change).toHaveBeenCalledWith("openai", "gpt-5");
      await waitFor(() => expect(trigger).toHaveFocus());
    } finally {
      touch.mockRestore();
    }
  });

  it("retains full model identity captions and projects literal, cross-identity and fuzzy matches into visible fields", () => {
    const choices = [
      { provider: "openai", id: "alpha", name: "alpha" },
      { provider: "openai", id: "beta" },
      { provider: "other", id: "folder/chat", name: "Nested chat" },
    ];
    render(
      <ModelSelector
        value={choices[1]!}
        models={choices}
        common={[choices[0]!]}
        recent={[]}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const common = screen.getByRole("option", { name: /alpha/ });
    expect(common.querySelector(".model-picker__id")).toHaveTextContent(
      /^openai\/alpha$/,
    );
    expect(common).toHaveAttribute("title", "alpha — openai/alpha");
    expect(
      screen
        .getByRole("option", { name: /beta/ })
        .querySelector(".model-picker__id"),
    ).toHaveTextContent(/^beta$/);
    const search = screen.getByRole("combobox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "OPENAI" } });
    expect(
      document.querySelector(".model-picker__heading .search-match"),
    ).toHaveTextContent(/^openai$/);
    expect(
      screen
        .getByRole("option", { name: /beta/ })
        .querySelector(".search-match"),
    ).toBeNull();
    fireEvent.change(search, { target: { value: "other/folder/chat" } });
    const nested = screen.getByRole("option", { name: /Nested chat/ });
    expect(nested.querySelector(".model-picker__id")).toHaveTextContent(
      /^folder\/chat$/,
    );
    expect(
      nested.querySelector(".model-picker__id .search-match"),
    ).toHaveTextContent(/^folder\/chat$/);
    expect(
      document.querySelector(".model-picker__heading .search-match"),
    ).toHaveTextContent(/^other$/);
    fireEvent.change(search, { target: { value: "nedct" } });
    expect(
      Array.from(
        screen
          .getByRole("option", { name: /Nested chat/ })
          .querySelectorAll(".model-picker__name-text .search-match"),
        (node) => node.textContent,
      ),
    ).toEqual(["Ne", "d", "c", "t"]);
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
    expect(document.querySelector(".dropdown__option--active")).toBeNull();
    expect(search).not.toHaveAttribute("aria-activedescendant");
    expect(
      screen.getByRole("option", { name: /Claude Sonnet/ }),
    ).toHaveAttribute("aria-selected", "true");
    expect(change).not.toHaveBeenCalled();

    fireEvent.keyDown(search, { key: "End" });
    expect(
      document.getElementById(search.getAttribute("aria-activedescendant")!),
    ).toHaveClass("dropdown__option--active");
    fireEvent.keyDown(search, { key: "Enter" });
    expect(change).toHaveBeenCalledWith("openai", "gpt-5");
  });

  it("bounds mounted rows while search and keyboard navigation reach the end of a large available set", () => {
    const available = Array.from({ length: 2400 }, (_, index) => ({
      provider: "fixture",
      id: `model-${String(index).padStart(4, "0")}`,
      name: `Available model ${index}`,
    }));
    const change = vi.fn();
    render(
      <ModelSelector
        value={available[0]!}
        models={available}
        recent={[]}
        onChange={change}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const search = screen.getByRole("combobox", { name: "Search models" });
    expect(screen.getAllByRole("option").length).toBeLessThan(25);
    fireEvent.keyDown(search, { key: "End" });
    const last = document.getElementById(
      search.getAttribute("aria-activedescendant")!,
    )!;
    expect(last).toHaveAttribute("aria-posinset", "2400");
    expect(last).toHaveTextContent("Available model 2399");
    fireEvent.keyDown(search, { key: "ArrowUp" });
    expect(
      document.getElementById(search.getAttribute("aria-activedescendant")!),
    ).toHaveTextContent("Available model 2398");
    expect(screen.getAllByRole("option").length).toBeLessThan(25);
    fireEvent.change(search, { target: { value: "model-2399" } });
    expect(screen.getAllByRole("option")[0]).toHaveTextContent(
      "Available model 2399",
    );
    expect(screen.getAllByRole("option").length).toBeLessThan(25);
    fireEvent.keyDown(search, { key: "Enter" });
    expect(change).toHaveBeenCalledWith("fixture", "model-2399");
  });
  it("searches displayed provider/model identities in common and ordinary groups, including slashes inside the model ID", () => {
    const choices = [
      {
        provider: "review-final",
        id: "review-final-chat",
        name: "Review final",
      },
      { provider: "custom", id: "folder/chat", name: "Nested chat" },
      { provider: "other", id: "unrelated", name: "Unrelated" },
    ];
    const change = vi.fn();
    render(
      <ModelSelector
        value={choices[2]!}
        models={choices}
        recent={[]}
        common={[choices[0]!]}
        onChange={change}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    const search = screen.getByRole("combobox", { name: "Search models" });
    for (const [query, name] of [
      ["review-final/review-final-chat", "Review final"],
      ["custom/folder/chat", "Nested chat"],
      ["folder/chat", "Nested chat"],
      ["Nested chat", "Nested chat"],
    ]) {
      fireEvent.change(search, { target: { value: query } });
      const matches = screen.getAllByRole("option");
      expect(matches).toHaveLength(1);
      expect(matches[0]).toHaveTextContent(name!);
    }
    fireEvent.keyDown(search, { key: "Enter" });
    expect(change).toHaveBeenCalledWith("custom", "folder/chat");
  });

  it("keeps configured common order above recency and offers one keyboard-reachable management destination, with no unconfigured common group", () => {
    const manage = vi.fn();
    const view = render(
      <ModelSelector
        value={models[0]!}
        models={models}
        recent={[models[0]!]}
        common={[models[2]!, models[1]!]}
        onChange={vi.fn()}
        onManageModels={manage}
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
    expect(
      screen.getAllByRole("button", { name: "Manage models" }),
    ).toHaveLength(1);
    const search = screen.getByRole("combobox", { name: "Search models" });
    fireEvent.keyDown(search, { key: "Tab" });
    expect(
      screen.getByRole("listbox", { name: "Available models" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage models" }));
    expect(manage).toHaveBeenCalledOnce();
    view.rerender(
      <ModelSelector
        value={models[0]!}
        models={models}
        recent={[]}
        onChange={vi.fn()}
        onManageModels={manage}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(screen.queryByText("Common models")).not.toBeInTheDocument();
  });
  it.each(["insertion", "recent reorder"])(
    "keeps the highlighted model through catalog %s so Enter chooses the same identity",
    (changeKind) => {
      const choices = [
        { provider: "fixture", id: "a", name: "Alpha" },
        { provider: "fixture", id: "b", name: "Beta" },
        { provider: "fixture", id: "c", name: "Gamma" },
      ];
      const change = vi.fn();
      const view = render(
        <ModelSelector
          value={choices[0]!}
          models={choices}
          recent={[]}
          onChange={change}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Model" }));
      const search = screen.getByRole("combobox", { name: "Search models" });
      fireEvent.keyDown(search, { key: "ArrowDown" });
      const updated =
        changeKind === "insertion"
          ? [...choices, { provider: "fixture", id: "0", name: "Inserted" }]
          : choices;
      const recent = changeKind === "recent reorder" ? [choices[2]!] : [];
      view.rerender(
        <ModelSelector
          value={choices[0]!}
          models={updated}
          recent={recent}
          onChange={change}
        />,
      );
      expect(
        document.getElementById(search.getAttribute("aria-activedescendant")!)
          ?.textContent,
      ).toContain("Beta");
      expect(document.activeElement).toBe(search);
      fireEvent.keyDown(search, { key: "Enter" });
      expect(change).toHaveBeenCalledWith("fixture", "b");
    },
  );
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
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(
        "Could not refresh models",
      ),
    );
    expect(screen.getByRole("status")).not.toHaveTextContent("cached choices");
    expect(screen.queryAllByRole("option")).toEqual([]);
  });

  it("opens cached choices immediately, updates the same menu, and keeps cache usable after refresh failure", async () => {
    let complete!: () => void;
    const pending = new Promise<void>((resolve) => {
      complete = resolve;
    });
    const refresh = vi.fn(async () => {
      await pending;
      return undefined;
    });
    const change = vi.fn();
    const view = render(
      <ModelSelector
        value={models[0]!}
        models={models}
        recent={[]}
        onChange={change}
        refreshModels={refresh}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Model" }));
    expect(
      screen.getByRole("option", { name: /Claude Sonnet/, selected: true }),
    ).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Refreshing models");
    const search = screen.getByRole("combobox", { name: "Search models" });
    fireEvent.change(search, { target: { value: "fresh" } });
    complete();
    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument(),
    );
    const fresh = { provider: "fixture", id: "fresh", name: "Fresh" };
    const failing = vi.fn(async () => {
      throw new Error("offline");
    });
    view.rerender(
      <ModelSelector
        value={models[0]!}
        models={[...models, fresh]}
        recent={[]}
        onChange={change}
        refreshModels={failing}
      />,
    );
    expect(screen.getByRole("combobox", { name: "Search models" })).toBe(
      search,
    );
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Could not refresh"),
    );
    expect(screen.getByRole("option", { name: /Fresh/ })).toBeVisible();
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "Claude Sonnet",
    );
    fireEvent.click(screen.getByRole("option", { name: /Fresh/ }));
    expect(change).toHaveBeenCalledWith("fixture", "fresh");
  });
  it("keeps provider headings outside option navigation and exposes selection, recent use and capabilities", () => {
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
      within(list).getByRole("option", {
        name: /Claude Sonnet/,
        selected: true,
      }),
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
