// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/components/Transcript";
import type { ChatMessage } from "../../src/events";

afterEach(() => vi.useRealTimers());

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
  it("keeps the Live turn's fold choice and genuine tool inspection through the native checkpoint", async () => {
    vi.useFakeTimers();
    const message = {
      role: "assistant",
      __inspireLiveId: "assistant",
      __inspireTurnId: "turn",
      content: [call("bash", "call-1")],
    };
    const { rerender } = render(
      transcript([message], {
        streaming: true,
        runState: "running",
        activeAssistantMessageKey: "live:assistant",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse bash tool" }));
    fireEvent.click(screen.getByRole("button", { name: "Expand bash tool" }));
    const toggle = screen.getByRole("button", collapse);
    expect(toggle).toHaveTextContent("1 step");
    expect(
      toggle.querySelector(".activity-fold__matrix")?.children,
    ).toHaveLength(9);
    expect(toggle.querySelector(".activity-fold__kind--live")).not.toBeNull();
    fireEvent.click(toggle);
    rerender(
      transcript(
        [{ ...message, content: [...message.content, call("read")] }],
        {
          streaming: true,
          runState: "running",
          activeAssistantMessageKey: "live:assistant",
        },
      ),
    );
    expect(screen.getByRole("button", expand)).toBe(toggle);
    expect(toggle).toHaveTextContent(/^Activity$/);
    fireEvent.click(toggle);
    rerender(
      transcript([
        {
          role: "assistant",
          __inspireMessageId: "native:0",
          __inspireTurnId: "turn",
          content: [call("bash", "call-1"), call("read")],
        },
      ]),
    );
    await act(() => vi.advanceTimersByTimeAsync(2000));
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
    const { rerender } = render(transcript(messages, { streaming: true }));
    const tool = screen.getByRole("button", { name: "Expand read tool" });
    tool.focus();
    rerender(transcript([...messages, { role: "assistant", content: "Later" }]));
    expect(tool).toHaveFocus();
    expect(screen.getByRole("button", collapse)).toBeVisible();
    rerender(transcript(messages, { projectionIncarnation: "replacement" }));
    expect(screen.getByRole("button", expand)).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Expand read tool" }),
    ).toBeNull();
  });
});
