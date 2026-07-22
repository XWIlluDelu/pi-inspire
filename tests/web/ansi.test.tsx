// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { stripTerminalSequences } from "../../src/ansi";
import { Transcript } from "../../src/components/Transcript";

const ESC = "\u001b";

describe("stripTerminalSequences", () => {
  it("strips SGR truecolor and reset sequences", () => {
    expect(stripTerminalSequences(`${ESC}[38;2;90;128;128mteal thought${ESC}[0m done`)).toBe("teal thought done");
  });

  it("strips compound and cursor CSI sequences", () => {
    expect(stripTerminalSequences(`${ESC}[1;31mbold red${ESC}[m${ESC}[2K${ESC}[1Gplain`)).toBe("bold redplain");
  });

  it("strips OSC hyperlinks terminated by ST", () => {
    expect(stripTerminalSequences(`${ESC}]8;;https://example.com${ESC}\\link${ESC}]8;;${ESC}\\ end`)).toBe("link end");
  });

  it("strips OSC sequences terminated by BEL", () => {
    expect(stripTerminalSequences(`${ESC}]0;window title\u0007visible`)).toBe("visible");
  });

  it("leaves ordinary text and Markdown untouched", () => {
    const markdown = "**bold** and [a link](https://pi.dev) plus `code` — 38;2;90 stays when not a sequence";
    expect(stripTerminalSequences(markdown)).toBe(markdown);
  });
});

describe("thinking display boundary", () => {
  const message = {
    role: "assistant",
    content: [{ type: "thinking", thinking: `${ESC}[38;2;90;128;128mcolored thought${ESC}[0m\nsecond line` }],
    timestamp: 1,
  };

  it("cleans the expanded thinking body without mutating the stored message", () => {
    const { container } = render(
      <Transcript messages={[message]} streaming={false} thinkingVisibility="expanded" toolVisibility="collapsed" />,
    );
    expect(container.textContent).toContain("colored thought");
    expect(container.textContent).toContain("second line");
    expect(container.textContent).not.toContain(ESC);
    expect(container.textContent).not.toContain("38;2;90;128;128");
    // the message model itself is untouched
    expect(message.content[0]!.thinking).toContain(`${ESC}[38;2;90;128;128m`);
  });

  it("cleans the collapsed summary line", () => {
    const { container } = render(
      <Transcript messages={[message]} streaming={false} thinkingVisibility="collapsed" toolVisibility="collapsed" />,
    );
    expect(container.querySelector(".card__summary")?.textContent).toBe("colored thought");
  });
});
