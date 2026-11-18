// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import hljs from "highlight.js/lib/common";
import katex from "katex";
import { describe, expect, it, vi } from "vitest";
import { RichText } from "../../src/components/RichText";

const richPrefix = [
  "Inline $x+1$ and $y+2$.",
  "$$\\frac{1}{2}$$",
  "```js\nconst first = 1;\n```",
  "```python\nprint(2)\n```",
].join("\n\n");

it("reclassifies a paragraph as a table when the streamed separator arrives", () => {
  const header = "| Formula | Source |";
  const { container, rerender } = render(<RichText text={header} />);
  expect(container.querySelector("p")?.textContent).toBe(header);
  rerender(<RichText text={header + "\n| - | - |\n| $x$ | `file.ts` |"} />);
  expect(container.querySelector("td annotation")).toHaveTextContent("x");
  expect(container.querySelector("td [data-file-path]")).toHaveTextContent(
    "file.ts",
  );
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
      container.querySelector<HTMLButtonElement>('[aria-label="Copy code"]')!,
    );
    await waitFor(() =>
      expect(container.querySelector('[aria-label="Copied"]')).toBeTruthy(),
    );
    expect(writeText).toHaveBeenCalledWith("const first = 1;");
    expect(math).not.toHaveBeenCalled();
    expect(highlight).not.toHaveBeenCalled();
  });
});
