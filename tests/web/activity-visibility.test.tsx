// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/components/Transcript";

afterEach(() => vi.useRealTimers());

describe("transcript density preferences", () => {
  it("opens active work, settles completed tools, and keeps explicitly opened details", async () => {
    vi.useFakeTimers();
    const message = {
      role: "assistant",
      timestamp: 1,
      __inspireLiveId: "live",
      content: [
        { type: "thinking", thinking: "considering the request" },
        {
          type: "toolCall",
          id: "read-1",
          name: "read",
          arguments: { path: "notes.md" },
        },
        {
          type: "toolCall",
          id: "bash-1",
          name: "bash",
          arguments: { command: "pwd" },
        },
      ],
    };
    const view = (live: boolean) => (
      <Transcript
        messages={[message]}
        streaming={live}
        activeAssistantMessageKey={live ? "live:live" : null}
        thinkingVisibility="dynamic"
        toolVisibility="dynamic"
        activityFoldVisibility="expanded"
        toolActivity={{
          "read-1": {
            id: "read-1",
            name: "read",
            phase: live ? "running" : "done",
          },
          "bash-1": {
            id: "bash-1",
            name: "bash",
            phase: live ? "running" : "error",
          },
        }}
      />
    );
    const { rerender } = render(view(true));
    expect(
      screen.getByRole("button", { name: "Collapse Thinking" }),
    ).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Collapse read tool" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand read tool" }));
    rerender(view(false));
    await act(() => vi.advanceTimersByTimeAsync(2500));
    expect(
      screen.getByRole("button", { name: "Expand Thinking" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Collapse read tool" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Expand bash tool" }),
    ).toBeVisible();
    expect(screen.getByLabelText("failed")).toBeVisible();
  });

  it("renders the collapsed thinking summary as inline Markdown and keeps full markdown expanded", async () => {
    const text = "First line with **strong** and $E = mc^2$\nSecond line";
    const view = (thinkingVisibility: "collapsed" | "hidden") => (
      <Transcript
        messages={[
          {
            role: "assistant",
            content: [{ type: "thinking", thinking: text }],
          },
        ]}
        streaming={false}
        thinkingVisibility={thinkingVisibility}
        toolVisibility="collapsed"
      />
    );
    const { rerender } = render(view("collapsed"));
    const thinkingCard = document.querySelector(
      ".card--thinking",
    ) as HTMLElement;
    const collapsed = thinkingCard.querySelector(
      ".card__disclosure",
    ) as HTMLElement;
    const summary = thinkingCard.querySelector(
      ".card__summary--prose",
    ) as HTMLElement;
    expect((await within(summary).findByText("strong")).tagName).toBe("STRONG");
    expect(summary.querySelector(".katex")).not.toBeNull();
    expect(screen.queryByText("Second line")).not.toBeInTheDocument();

    fireEvent.click(collapsed);
    const expanded = screen.getByText(/Second line/, {
      selector: ".rich-text--thinking p",
    });
    expect(
      within(expanded.parentElement as HTMLElement).getByText("strong").tagName,
    ).toBe("STRONG");

    rerender(view("hidden"));
    expect(
      screen.queryByRole("button", { name: /Thinking/i }),
    ).not.toBeInTheDocument();
  });
});
