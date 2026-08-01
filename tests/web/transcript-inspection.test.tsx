// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript, findLiteralMatches } from "../../src/components/Transcript";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("settled transcript search", () => {
  it("keeps the compact floating search and filters all, user, or model text", () => {
    render(
      <Transcript
        sessionId="scoped"
        messages={[
          { role: "user", content: "shared phrase from user", timestamp: 1 },
          { role: "assistant", content: "shared phrase from model", timestamp: 2 },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );

    const search = screen.getByRole("search", { name: "Search settled transcript" });
    const input = screen.getByRole("searchbox", { name: "Search conversation" });
    const log = screen.getByRole("log");
    expect(search.parentElement).toHaveClass("transcript-wrap");
    expect(search.nextElementSibling).toBe(log);
    expect(search).not.toHaveClass("transcript-search--active");

    fireEvent.change(input, { target: { value: "shared" } });
    expect(search).toHaveClass("transcript-search--active");
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("2 matches");

    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "User" }));
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("1 match");

    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "Model" }));
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("1 match");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search conversation" }), { target: { value: "user" } });
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("No matches");

    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "All" }));
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("1 match");

    fireEvent.change(input, { target: { value: "" } });
    expect(search).not.toHaveClass("transcript-search--active");
  });

  it("finds case-insensitive literal occurrences only in settled user and assistant text", () => {
    expect(findLiteralMatches("Alpha alpha alphabet", "ALPHA", 3)).toEqual([
      { rowIndex: 3, offset: 0 },
      { rowIndex: 3, offset: 6 },
      { rowIndex: 3, offset: 12 },
    ]);

    const messages = [
      { role: "user", content: "Alpha alpha", timestamp: 1 },
      {
        role: "assistant",
        timestamp: 2,
        content: [
          { type: "text", text: "BETA beta" },
          { type: "thinking", thinking: "hidden needle" },
          { type: "toolCall", id: "tool-1", name: "search", arguments: { query: "needle" } },
        ],
      },
      { role: "assistant", timestamp: 3, content: [{ type: "text", text: "live beta" }], __inspireLiveId: "assistant-live" },
      { role: "user", content: "unsettled beta", timestamp: 4, __inspireLiveId: "user-live" },
    ];
    const { rerender } = render(
      <Transcript
        sessionId="s1"
        messages={messages}
        streaming
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const input = screen.getByRole("searchbox", { name: "Search conversation" });

    fireEvent.change(input, { target: { value: "beta" } });
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("2 matches");
    fireEvent.click(screen.getByRole("button", { name: "Next transcript match" }));
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Previous transcript match" }));
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("2 of 2");
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "needle" } });
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("No matches");

    fireEvent.change(input, { target: { value: "beta" } });
    rerender(
      <Transcript
        sessionId="s1"
        messages={[
          { role: "user", content: "older beta", timestamp: 0 },
          ...messages.map((message) => message.timestamp === 3 ? { ...message, __inspireSettled: true } : message),
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("4 matches");

    rerender(
      <Transcript
        sessionId="s2"
        messages={[{ role: "user", content: "beta in another session", timestamp: 10 }]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(screen.getByRole("searchbox", { name: "Search conversation" })).toHaveValue("");
  });
});

describe("transient conversation projections", () => {
  it("renders separate ordered pending queues without cancellation or cross-queue chronology", () => {
    render(
      <Transcript
        messages={[{ role: "user", content: "persisted", timestamp: 1 }]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        queue={{ steering: ["steer first", "steer second"], followUp: ["follow first", "follow second"] }}
      />,
    );
    const steering = screen.getByRole("region", { name: "Pending steering" });
    const followUp = screen.getByRole("region", { name: "Pending follow-up" });
    expect(within(steering).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["steer first", "steer second"]);
    expect(within(followUp).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["follow first", "follow second"]);
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });

  it("renders one attributable inspectable generic extension surface", () => {
    render(
      <Transcript
        messages={[]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="hidden"
        extensionDisplays={[
          { id: "setWidget:plan", method: "setWidget", attribution: "extensions/plan.ts · plan", payload: { widgetLines: ["one"] } },
          { id: "showPanel:build", method: "showPanel", attribution: "extensions/build.ts · build", payload: { status: "passing" } },
        ]}
      />,
    );
    const surface = screen.getByRole("region", { name: "Extension display content" });
    expect(within(surface).getByText("extensions/plan.ts · plan")).toBeInTheDocument();
    expect(within(surface).getByText("extensions/build.ts · build")).toBeInTheDocument();
    fireEvent.click(within(surface).getByText("extensions/plan.ts · plan"));
    expect(within(surface).getByText(/widgetLines/)).toBeInTheDocument();
  });
});
