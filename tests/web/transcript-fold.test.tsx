// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Transcript } from "../../src/components/Transcript";
import type { ChatMessage } from "../../src/events";

type TranscriptProps = React.ComponentProps<typeof Transcript>;
function transcript(
  messages: ChatMessage[],
  props: Partial<TranscriptProps> = {},
) {
  return (
    <Transcript
      messages={messages}
      sessionId="session"
      viewId="view"
      streaming={false}
      thinkingVisibility="expanded"
      toolVisibility="collapsed"
      activityFoldVisibility="expanded"
      {...props}
    />
  );
}

function call(name: string, id = name) {
  return { type: "toolCall", id, name, arguments: { command: name } };
}

const expand = { name: "Expand assistant activity" };
const collapse = { name: "Collapse assistant activity" };

describe("Live assistant activity", () => {
  it("uses one focusable disclosure and reports repeated tools and errors", () => {
    const messages = [
      {
        role: "assistant",
        content: [call("bash", "a"), call("bash", "b"), call("read")],
      },
      { role: "toolResult", toolCallId: "b", isError: true, content: "failed" },
      { role: "assistant", content: "Answer stays readable" },
    ];
    render(transcript(messages, { activityFoldVisibility: "collapsed" }));
    const group = screen.getByRole("region", { name: "Assistant activity" });
    expect(group).toHaveTextContent("3 steps · bash ×2 · read · 1 failed");
    const toggle = within(group).getByRole("button", expand);
    toggle.focus();
    fireEvent.click(toggle);
    expect(within(group).getByRole("button", collapse)).toBe(toggle);
    expect(toggle).toHaveFocus();
    expect(
      within(group).getByRole("button", { name: "Expand read tool" }),
    ).toBeVisible();
    expect(screen.getByText("Answer stays readable")).toBeVisible();
  });

  it("reads every bounded activity page and keeps a real tool's explicit disclosure", () => {
    const messages = [
      {
        role: "assistant",
        content: Array.from({ length: 49 }, (_, i) => call(`tool-${i}`)),
      },
    ];
    const { container } = render(
      transcript(messages, { activityFoldVisibility: "compact" }),
    );
    const group = screen.getByRole("group", { name: "Activity pages" });
    const earlier = within(group).getByRole("button", {
      name: "Earlier activity",
    });
    const later = within(group).getByRole("button", { name: "Later activity" });
    expect(
      screen.getByRole("button", { name: "Expand tool-48 tool" }),
    ).toBeVisible();
    fireEvent.click(earlier);
    expect(container.querySelectorAll(".card--tool")).toHaveLength(24);
    fireEvent.click(earlier);
    fireEvent.click(screen.getByRole("button", { name: "Expand tool-0 tool" }));
    expect(earlier).toBeDisabled();
    fireEvent.click(later);
    expect(
      screen.queryByRole("button", { name: "Collapse tool-0 tool" }),
    ).toBeNull();
    fireEvent.click(earlier);
    expect(
      screen.getByRole("button", { name: "Collapse tool-0 tool" }),
    ).toBeVisible();
  });

  it("keeps the Live turn's fold choice and genuine tool inspection through the native checkpoint", () => {
    const message = {
      role: "assistant",
      __inspireLiveId: "assistant",
      __inspireTurnId: "turn",
      content: [call("bash", "call-1")],
    };
    const prefs = { activityFoldVisibility: "dynamic" } as const;
    const { rerender } = render(
      transcript([message], {
        ...prefs,
        streaming: true,
        runState: "running",
        activeAssistantMessageKey: "live:assistant",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Expand bash tool" }));
    const toggle = screen.getByRole("button", collapse);
    fireEvent.click(toggle);
    rerender(
      transcript(
        [{ ...message, content: [...message.content, call("read")] }],
        {
          ...prefs,
          streaming: true,
          runState: "running",
          activeAssistantMessageKey: "live:assistant",
        },
      ),
    );
    expect(screen.getByRole("button", expand)).toBe(toggle);
    fireEvent.click(toggle);
    rerender(
      transcript(
        [
          {
            role: "assistant",
            __inspireMessageId: "native:0",
            __inspireTurnId: "turn",
            content: [call("bash", "call-1"), call("read")],
          },
        ],
        prefs,
      ),
    );
    expect(screen.getByRole("button", collapse)).toBe(toggle);
    expect(
      screen.getByRole("button", { name: "Collapse bash tool" }),
    ).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Expand read tool" }),
    ).toBeVisible();
  });

  it("holds focused activity during settlement and resets on branch retirement", () => {
    const messages = [
      {
        role: "assistant",
        __inspireLiveId: "work",
        content: [call("read")],
      },
    ];
    const prefs = { activityFoldVisibility: "dynamic" } as const;
    const { rerender } = render(
      transcript(messages, { ...prefs, streaming: true }),
    );
    const tool = screen.getByRole("button", { name: "Expand read tool" });
    tool.focus();
    rerender(
      transcript([...messages, { role: "assistant", content: "Later" }], prefs),
    );
    expect(tool).toHaveFocus();
    expect(screen.getByRole("button", collapse)).toBeVisible();
    rerender(
      transcript(messages, { ...prefs, projectionIncarnation: "replacement" }),
    );
    expect(screen.getByRole("button", expand)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Expand read tool" }),
    ).toBeNull();
  });
});
