// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import hljs from "highlight.js/lib/common";
import katex from "katex";
import { describe, expect, it, vi } from "vitest";
import { RichText } from "../../src/components/RichText";

function freshMarkup(text: string): string {
  const fresh = render(<RichText text={text} />);
  const html = fresh.container.innerHTML;
  fresh.unmount();
  return html;
}

const richPrefix = [
  "Inline $x+1$ and $y+2$.",
  "$$\\frac{1}{2}$$",
  "```js\nconst first = 1;\n```",
  "```python\nprint(2)\n```",
].join("\n\n");

describe("whole-document streaming semantics", () => {
  it.each([
    [
      "heading and table reclassification",
      [
        "Heading",
        "\n===",
        "\n\n| A | B |",
        "\n| - | - |",
        "\n| $x$ | `file.ts` |",
      ],
    ],
    [
      "fences in a nested list",
      [
        "- First\n\n  ```js\n  const x = 1;",
        "\n\n  const y = 2;",
        "\n  ```",
        "\n\n- Second\n  - Nested",
      ],
    ],
    [
      "literal dollars beside math that arrives later",
      [
        "Read $HOME and $PATH.",
        " Math: $",
        String.raw`\text{Cost: \$5}`,
        "$",
        "\n\n$$x",
        "+1$$",
      ],
    ],
  ] as const)("matches a fresh render across %s", (_name, chunks) => {
    const { container, rerender } = render(<RichText text="" />);
    let text = "";
    for (const chunk of chunks) {
      text += chunk;
      rerender(<RichText text={text} />);
      expect(container.innerHTML).toBe(freshMarkup(text));
    }
  });

  it("updates earlier unresolved references and footnotes when definitions arrive", () => {
    const prefix = "[late][target] and [^note].\n\n$x$\n\n";
    const { container, rerender } = render(<RichText text={prefix} />);
    expect(container.querySelector("a")).toBeNull();
    rerender(
      <RichText text={prefix + "[target]: ./file.ts\n\n[^note]: Note $z$"} />,
    );
    expect(
      container.querySelector('[data-file-path="./file.ts"]')?.textContent,
    ).toBe("late");
    expect(container.querySelector("sup a")?.getAttribute("href")).toContain(
      "fn-note",
    );
    expect(
      container.querySelector("section[data-footnotes]")?.textContent,
    ).toContain("Note");
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
  });
});

describe("bounded expensive-leaf reuse", () => {
  it("recomputes changed formulas and growing code, not settled siblings", () => {
    const math = vi.spyOn(katex, "renderToString");
    const highlight = vi.spyOn(hljs, "highlight");
    const { rerender } = render(
      <RichText text={richPrefix + "\n\n```js\nlet tail"} />,
    );
    math.mockClear();
    highlight.mockClear();
    rerender(
      <RichText
        text={richPrefix.replace("$x+1$", "$x+3$") + "\n\n```js\nlet tail = 1;"}
      />,
    );
    expect(math).toHaveBeenCalledTimes(1);
    expect(highlight).toHaveBeenCalledTimes(1);
    expect(highlight.mock.calls[0]?.[0]).toBe("let tail = 1;");
  });

  it("reuses unchanged math and code across streamed prose and copy feedback", async ({
    onTestFinished,
  }) => {
    const math = vi.spyOn(katex, "renderToString");
    const highlight = vi.spyOn(hljs, "highlight");
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const { container, rerender } = render(<RichText text={richPrefix} />);
    const firstMath = container.querySelector(".katex");
    const firstCode = container.querySelector("pre code");
    math.mockClear();
    highlight.mockClear();
    rerender(
      <RichText
        text={richPrefix.replace("and $y+2$.", "and $y+2$. More prose.")}
      />,
    );
    rerender(
      <RichText
        text={
          richPrefix.replace("and $y+2$.", "and $y+2$. More prose.") +
          "\n\nNew paragraph."
        }
      />,
    );
    expect(container.querySelector(".katex")).toBe(firstMath);
    expect(container.querySelector("pre code")).toBe(firstCode);
    fireEvent.click(
      container.querySelector<HTMLButtonElement>(".code-block__copy")!,
    );
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Copied"]')).toBeTruthy(),
    );
    expect(writeText).toHaveBeenCalledWith("const first = 1;");
    expect(math).not.toHaveBeenCalled();
    expect(highlight).not.toHaveBeenCalled();
  });
});
