// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { stripTerminalSequences } from "../../src/ansi";
import { Transcript } from "../../src/components/Transcript";

const ESC = "\u001b";

describe("stripTerminalSequences", () => {
  it.each([
    ["truecolor SGR", `${ESC}[38;2;90;128;128mteal${ESC}[0m done`, "teal done"],
    ["cursor CSI", `${ESC}[1;31mred${ESC}[m${ESC}[2K${ESC}[1Gplain`, "redplain"],
    [
      "ST-terminated OSC",
      `${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\ end`,
      "link end",
    ],
    ["BEL-terminated OSC", `${ESC}]0;window title\u0007visible`, "visible"],
  ])("strips %s sequences", (_kind, source, visible) => {
    expect(stripTerminalSequences(source)).toBe(visible);
  });

  it("leaves ordinary text and Markdown untouched", () => {
    const markdown =
      "**bold** and [a link](https://pi.dev) plus `code` — 38;2;90 stays when not a sequence";
    expect(stripTerminalSequences(markdown)).toBe(markdown);
  });
});

it("cleans the Thinking summary and expanded body without changing the message", () => {
  const thinking = `${ESC}[38;2;90;128;128mcolored thought${ESC}[0m\nsecond line`;
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking }],
    timestamp: 1,
  };
  const { container } = render(
    <Transcript
      messages={[message]}
      streaming={false}
      thinkingVisibility="collapsed"
      toolVisibility="collapsed"
    />,
  );
  expect(screen.getByText("colored thought", { exact: true })).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Expand Thinking" }));
  expect(container.textContent).toContain("colored thought");
  expect(container.textContent).toContain("second line");
  expect(container.textContent).not.toContain(ESC);
  expect(message.content[0]!.thinking).toBe(thinking);
});
