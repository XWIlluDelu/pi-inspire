// @vitest-environment jsdom
import { fireEvent, render, waitFor } from "@testing-library/react";
import hljs from "highlight.js/lib/common";
import katex from "katex";
import ReactMarkdown from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkMath from "remark-math-extended";
import { describe, expect, it, vi } from "vitest";
import { RichText } from "../../src/components/RichText";
import { ProgressiveRichText } from "../../src/components/ProgressiveRichText";

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

const cases = [
  [
    "references and footnotes defined later",
    '[late][id] and [^note].\n\nOther paragraph.\n\n[id]: https://example.com "Title"\n\n[^note]: Footnote $x$\n\n    continuation',
  ],
  [
    "duplicate definitions and repeated footnotes",
    "[first][id] [^b] [^a] [^b]\n\n[id]: ./first.ts\n\n[id]: javascript:bad\n\n[^a]: A\n\n[^b]: B $y$",
  ],
  [
    "nested loose lists and fences",
    "- First\n\n  Paragraph $x$.\n\n  ```js\n  const x = 1;\n\n  const y = 2;\n  ```\n\n- Second\n  - Nested\n\n    More",
  ],
  [
    "blockquote and indented code",
    "> Quote\n>\n>     path.ts\n>\n> $x$\n\n    a\n\n      b\n\nEnd",
  ],
  [
    "fence closing and language mutation",
    "```typescript\nconst x = `<unsafe>`;\n\n// $notMath$\n```\n\n`src/file.ts`",
  ],
  [
    "table and setext heading reclassification",
    "Heading\n===\n\n| A | B |\n| - | - |\n| $x$ | `file.ts` |\n\n- [x] done\n- [ ] pending",
  ],
  [
    "multiline math with blank lines and escaped delimiters",
    String.raw`Before \\(literal) and \(x+1\).

\[
\begin{aligned}
x &= 1 \\

 y &= 2
\end{aligned}
\]

$$A=
\begin{bmatrix}1&2\\3&4\end{bmatrix}$$`,
  ],
  [
    "unsafe content after stable math",
    "$x$\n\n[bad](javascript:alert(1))\n\n<img src=x onerror=alert(1)>\n\n$\\href{https://evil.invalid}{x}$\n\n![remote](https://evil.invalid/a.png)",
  ],
] as const;

describe("whole-document streaming semantics", () => {
  it.each(cases)(
    "matches a fresh render at every chunk: %s",
    (_name, source) => {
      const { container, rerender } = render(<RichText text="" />);
      // Small chunks deliberately cross delimiters and structural boundaries.
      for (let end = 1; end < source.length + 7; end += 7) {
        const text = source.slice(0, end);
        rerender(<RichText text={text} />);
        expect(container.innerHTML).toBe(freshMarkup(text));
      }
      expect(
        container.querySelector('a[href^="javascript:"], img, script'),
      ).toBeNull();
    },
  );

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

  it.each([
    "$x$",
    "\\[x\\]",
    "$$\nx\n$$",
    "```math\nx\n```",
    "$\\badcommand{x}$",
  ])("retains rehype-katex's exact generated markup: %s", (text) => {
    const original = render(
      <ReactMarkdown
        remarkPlugins={[remarkMath]}
        rehypePlugins={[
          [rehypeKatex, { trust: false, strict: false, throwOnError: false }],
        ]}
      >
        {text}
      </ReactMarkdown>,
    );
    const { container } = render(<RichText text={text} />);
    const expected = original.container;
    expect(container.querySelector(".katex, .katex-error")?.outerHTML).toBe(
      expected.querySelector(".katex, .katex-error")?.outerHTML,
    );
  });

  it("uses the same optimized renderer after ProgressiveRichText loads", async () => {
    const { container, rerender } = render(
      <ProgressiveRichText text={richPrefix} />,
    );
    await waitFor(() =>
      expect(container.querySelectorAll(".katex")).toHaveLength(3),
    );
    rerender(<ProgressiveRichText text={richPrefix + "\n\nDone"} />);
    expect(container.innerHTML).toBe(freshMarkup(richPrefix + "\n\nDone"));
  });
});

describe("bounded expensive-leaf reuse", () => {
  it("does no KaTeX or highlighting work for unchanged leaves on text deltas", () => {
    const math = vi.spyOn(katex, "renderToString");
    const highlight = vi.spyOn(hljs, "highlight");
    const { container, rerender } = render(<RichText text={richPrefix} />);
    expect(math).toHaveBeenCalledTimes(3);
    expect(highlight).toHaveBeenCalledTimes(2);
    const firstMath = container.querySelector(".katex");
    const firstCode = container.querySelector("pre code");
    math.mockClear();
    highlight.mockClear();
    for (let index = 0; index < 20; index++)
      rerender(
        <RichText
          text={richPrefix + "\n\nTail " + "word ".repeat(index + 1)}
        />,
      );
    expect(math).not.toHaveBeenCalled();
    expect(highlight).not.toHaveBeenCalled();
    expect(container.querySelector(".katex")).toBe(firstMath);
    expect(container.querySelector("pre code")).toBe(firstCode);
  });

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

  it("reuses math inside a changing paragraph and highlights only once across copy feedback", async () => {
    const math = vi.spyOn(katex, "renderToString");
    const highlight = vi.spyOn(hljs, "highlight");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container, rerender } = render(<RichText text={richPrefix} />);
    math.mockClear();
    highlight.mockClear();
    rerender(
      <RichText
        text={richPrefix.replace("and $y+2$.", "and $y+2$. More prose.")}
      />,
    );
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

  it("does not retain results across removed/replaced content or component lifetimes", () => {
    const math = vi.spyOn(katex, "renderToString");
    const highlight = vi.spyOn(hljs, "highlight");
    const { rerender, unmount, container } = render(
      <RichText text={richPrefix} />,
    );
    for (let index = 0; index < 10; index++)
      rerender(
        <RichText
          text={`$x_${index}$\n\n\`\`\`js\nconst x = ${index};\n\`\`\``}
        />,
      );
    math.mockClear();
    highlight.mockClear();
    rerender(<RichText text="" />);
    expect(container.textContent).toBe("");
    rerender(<RichText text={richPrefix} />);
    expect(math).toHaveBeenCalledTimes(3);
    expect(highlight).toHaveBeenCalledTimes(2);
    unmount();
    math.mockClear();
    highlight.mockClear();
    render(<RichText text={richPrefix} />);
    expect(math).toHaveBeenCalledTimes(3);
    expect(highlight).toHaveBeenCalledTimes(2);
  });
});
