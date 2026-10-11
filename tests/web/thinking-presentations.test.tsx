// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ToolPresentationConfiguration,
  toolPresentationConfigurationSchema,
} from "../../shared/tool-presentation-config";
import { ThinkingCard } from "../../src/components/transcript-cards";
import { configureToolPresentationRegistry } from "../../src/tool-presentations/registry";

function configureThinking(
  thinking: NonNullable<ToolPresentationConfiguration["thinking"]>,
) {
  configureToolPresentationRegistry({
    version: 1,
    rules: {},
    mappings: {},
    thinking,
  });
}

afterEach(() => {
  configureToolPresentationRegistry();
  vi.useRealTimers();
});

describe("empty Thinking disclosure", () => {
  it.each(["expanded", "dynamic"] as const)(
    "keeps empty %s cards compact while honoring manual disclosure and arriving content",
    (visibility) => {
      const card = (text: string) => (
        <ThinkingCard text={text} visibility={visibility} dynamicActive />
      );
      const { container, rerender } = render(card("\u001b[31m \n\t\u001b[0m"));
      const disclosure = screen.getByRole("button", {
        name: "Expand Thinking",
      });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(container.querySelector(".card__body")).toBeNull();

      rerender(card("First thought"));
      expect(disclosure).toHaveAttribute("aria-expanded", "true");

      fireEvent.click(disclosure);
      rerender(card(""));
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(disclosure);
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      expect(container.querySelector(".card__body")).not.toBeNull();
      rerender(card("Later thought"));
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      fireEvent.click(disclosure);
      rerender(card("Updated thought"));
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
    },
  );

  it("starts adaptive residency when content arrives, not while the body is empty", () => {
    vi.useFakeTimers();
    const card = (text: string, dynamicActive: boolean) => (
      <ThinkingCard
        text={text}
        visibility="dynamic"
        dynamicActive={dynamicActive}
      />
    );
    const { rerender } = render(card("", true));
    act(() => vi.advanceTimersByTime(5_000));
    rerender(card("Visible thought", true));
    const disclosure = screen.getByRole("button", {
      name: "Collapse Thinking",
    });
    rerender(card("Visible thought", false));
    act(() => vi.advanceTimersByTime(1_799));
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    act(() => vi.advanceTimersByTime(1));
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
  });
});

describe("custom Thinking presentations", () => {
  it("replaces only the summary and expanded body inside the native shell", async () => {
    const configuration = toolPresentationConfigurationSchema.parse({
      version: 1,
      rules: {},
      mappings: {},
      thinking: {
        summary: [
          { value: { literal: "Trace" } },
          {
            value: { path: "thinking.text", format: "first-line" },
            subdued: true,
          },
        ],
        blocks: [
          {
            type: "properties",
            items: [
              {
                label: "Characters",
                value: { path: "thinking.text", format: "count" },
              },
            ],
          },
          {
            type: "markdown",
            label: "Reasoning",
            source: { path: "thinking.text" },
          },
        ],
      },
    });
    configureThinking(configuration.thinking!);

    const { container, rerender } = render(
      <ThinkingCard
        text={"\u001b[31m# Plan\u001b[0m\n\n- inspect"}
        visibility="collapsed"
        dynamicActive={false}
      />,
    );

    const card = container.querySelector(".card--thinking") as HTMLElement;
    expect(card).not.toBeNull();
    const disclosure = within(card).getByRole("button", {
      name: "Expand Thinking",
    });
    expect(within(card).getByText("Trace")).toBeInTheDocument();
    expect(card.querySelector(".tool-summary__subdued")).toHaveTextContent(
      "# Plan",
    );

    fireEvent.click(disclosure);
    expect(
      within(card).getByRole("button", { name: "Collapse Thinking" }),
    ).toBeInTheDocument();
    expect(
      card.querySelector('[data-thinking-presentation="configured"]'),
    ).not.toBeNull();
    expect(within(card).getByText("Characters")).toBeInTheDocument();
    expect(
      await within(card).findByText("Plan", { selector: "h1" }),
    ).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: "Copy thinking block" }),
    ).toBeInTheDocument();
    expect(card.textContent).not.toContain("\u001b");

    configureThinking({
      summary: [{ value: { literal: "Trace" } }],
      blocks: [{ type: "text", source: { literal: "Configured context" } }],
    });
    rerender(
      <ThinkingCard
        key="empty"
        text=""
        visibility="expanded"
        dynamicActive={false}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Collapse Thinking" }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Configured context")).toBeInTheDocument();
  });

  it("falls back to native Thinking content when configured blocks are incompatible", () => {
    const configuration = toolPresentationConfigurationSchema.parse({
      version: 1,
      rules: {},
      mappings: {},
      thinking: {
        summary: [{ value: { literal: "Custom summary" } }],
        blocks: [
          {
            type: "search",
            source: { path: "thinking.text" },
            format: "grouped-lines",
          },
        ],
      },
    });
    configureThinking(configuration.thinking!);

    const { container } = render(
      <ThinkingCard
        text="ordinary reasoning"
        visibility="collapsed"
        dynamicActive={false}
      />,
    );

    expect(screen.getByText("Custom summary")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand Thinking" }));
    expect(screen.getByText("ordinary reasoning")).toBeInTheDocument();
    expect(
      container.querySelector('[data-thinking-presentation="configured"]'),
    ).toBeNull();
  });
});
