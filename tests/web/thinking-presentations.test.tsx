// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => configureToolPresentationRegistry());

describe("custom Thinking presentations", () => {
  it("replaces only the summary and expanded body inside the native shell", () => {
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

    const { container } = render(
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
      within(card).getByText("Plan", { selector: "h1" }),
    ).toBeInTheDocument();
    expect(
      within(card).getByRole("button", { name: "Copy thinking block" }),
    ).toBeInTheDocument();
    expect(card.textContent).not.toContain("\u001b");
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
