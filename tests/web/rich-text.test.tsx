// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  RichText,
  projectKatexSelection,
  scanBackslashMath,
} from "../../src/components/RichText";
import { Transcript } from "../../src/components/Transcript";

class ClipboardDataTransfer {
  private readonly values = new Map<string, string>();
  get types(): string[] {
    return [...this.values.keys()];
  }
  setData(type: string, value: string): void {
    this.values.set(type, value);
  }
  getData(type: string): string {
    return this.values.get(type) ?? "";
  }
}

function textNode(root: Element): Text {
  const node = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
  if (!(node instanceof Text)) throw new Error("Expected rendered text node");
  return node;
}

function dispatchSelectionCopy(
  origin: Element,
  range: Range,
): { event: Event; data: ClipboardDataTransfer } {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  const data = new ClipboardDataTransfer();
  const event = new Event("copy", { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: data });
  origin.dispatchEvent(event);
  selection.removeAllRanges();
  return { event, data };
}

describe("formula rendering", () => {
  it("scans adversarial backslash math in deterministic linear work", () => {
    for (const size of [64, 4_096, 500_000]) {
      const input = `${"\\".repeat(size)}\\(unclosed`;
      const result = scanBackslashMath(input);
      expect(result.operations).toBe(input.length);
      expect(result.operations).toBeLessThanOrEqual(size + 10);
    }
    expect(scanBackslashMath("\\\\\\(x\\)").firstUnclosed).toBe(-1);
    expect(scanBackslashMath("\\\\(escaped").firstUnclosed).toBe(-1);
    expect(scanBackslashMath("\\[x\\]").hasOpeningDisplayClose).toBe(true);
    expect(scanBackslashMath("\\[x").firstUnclosed).toBe(0);
  });

  it("renders inline mathematics through KaTeX", () => {
    const { container } = render(
      <RichText text="The energy is $E=mc^2$ here." />,
    );
    expect(container.querySelector(".katex")).toBeTruthy();
    expect(container.textContent).toContain("The energy is");
  });

  it("renders display mathematics", () => {
    const { container } = render(
      <RichText text={"Before\n\n$$\\int_0^1 x^2\\,dx=\\frac13$$\n\nAfter"} />,
    );
    expect(container.querySelector(".katex-display")).toBeTruthy();
  });

  it("renders a complete formula-rich Pi response without stripped structures", () => {
    const source = String.raw`$$\sum_{i=1}^{n} i = \frac{n(n+1)}{2}$$
$$\int_{0}^{\infty} e^{-x^2}\,dx = \frac{\sqrt{\pi}}{2}$$
$$A =
\begin{bmatrix}
1 & 2 \\
3 & 4
\end{bmatrix}$$
$$\begin{aligned}
f(x) &= x^2 + 2x + 1 \\
     &= (x+1)^2
\end{aligned}$$
$$f(x)=
\begin{cases}
x^2, & x\geq 0 \\
-x, & x<0
\end{cases}$$`;
    const { container } = render(<RichText text={source} />);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(5);
    expect(container.querySelector(".sqrt svg path[d]")).toBeTruthy();
    expect(container.querySelectorAll(".katex-mathml mtable")).toHaveLength(3);
    expect(container.querySelectorAll("annotation")[2]?.textContent).toContain(
      "A =",
    );
  });

  it.each([
    ["radical", String.raw`\sqrt{\pi}`],
    ["wide accent", String.raw`\widehat{abcdef}`],
    ["extensible arrow", String.raw`\xrightarrow{n}`],
    ["extensible brace", String.raw`\overbrace{a+b+c}^{n}`],
  ])("preserves KaTeX's SVG path for %s", (_label, formula) => {
    const { container } = render(<RichText text={`$$${formula}$$`} />);
    const paths = [...container.querySelectorAll(".katex-display svg path")];
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path.hasAttribute("d"))).toBe(true);
  });

  it("preserves non-path SVG geometry such as cancellation lines", () => {
    const { container } = render(
      <RichText text={String.raw`$$\cancel{x}$$`} />,
    );
    const line = container.querySelector(".katex-display svg line");
    expect(line).toHaveAttribute("x1", "0");
    expect(line).toHaveAttribute("y2", "0");
    expect(line).toHaveAttribute("stroke-width", "0.046em");
  });

  it("preserves MathML structure and layout metadata for assistive technology", () => {
    const formula = String.raw`$$\begin{aligned}f(x)&=x^2\\&=(x+1)^2\end{aligned}$$`;
    const { container } = render(<RichText text={formula} />);
    const math = container.querySelector(".katex-mathml math");
    const table = math?.querySelector("mtable");
    expect(math?.getAttribute("display")).toBe("block");
    expect(table?.getAttribute("rowspacing")).toBe("0.25em");
    expect(table?.getAttribute("columnalign")).toBe("right left");
    expect(table?.getAttribute("columnspacing")).toBe("0em");
    expect(math?.querySelector("annotation")?.getAttribute("encoding")).toBe(
      "application/x-tex",
    );
  });

  it("keeps KaTeX trust-only commands inert", () => {
    const formula = String.raw`$\href{https://attacker.invalid}{x} + \htmlClass{attacker}{y} + \includegraphics{https://attacker.invalid/x.png}$`;
    const { container } = render(<RichText text={formula} />);
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector(".attacker")).toBeNull();
    expect(container.textContent).toContain("\\href");
    expect(container.textContent).toContain("\\htmlClass");
    expect(container.textContent).toContain("\\includegraphics");
  });

  it("renders the project name expression ins$\\pi$re", () => {
    const { container } = render(<RichText text="ins$\pi$re" />);
    expect(container.querySelector(".katex")).toBeTruthy();
    expect(container.textContent).toContain("ins");
    expect(container.textContent).toContain("re");
  });

  it("supports TeX inline and display delimiters at tokenization level", () => {
    const { container } = render(
      <RichText
        text={String.raw`Inline \(x+1\)

\[y^2\]`}
      />,
    );
    expect(container.querySelectorAll(".katex")).toHaveLength(2);
    expect(container.querySelector(".katex-display")).toBeTruthy();
  });

  it("does not reinterpret inline or fenced code as math", () => {
    const text = String.raw`Code: \`$x$ \(y\)\`

\`\`\`tex
$$z$$
\[w\]
\`\`\``.replaceAll("\\`", "`");
    const { container } = render(<RichText text={text} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("$x$ \\(y\\)");
    expect(container.textContent).toContain("$$z$$");
  });

  it.each([
    ["bare single dollar", "$"],
    ["single dollar", "$x"],
    ["bare double dollar", "$$"],
    ["leading double dollar", "$$x"],
    ["multiline double dollar", "$$\nx"],
    ["first-line multiline double dollar", "$$A=\nx"],
    ["bare parenthesis", String.raw`\(`],
    ["parenthesis", String.raw`\(x`],
    ["bare bracket", String.raw`\[`],
    ["bracket", String.raw`\[x`],
    ["multiline bracket", String.raw`\[\nx`],
  ])("keeps incomplete %s source exact and non-math", (_label, source) => {
    const { container } = render(<RichText text={source} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".rich-text")?.textContent).toBe(source);
  });

  it("preserves Markdown escapes and code without treating their delimiters as math", () => {
    const source = String.raw`Escaped \$x and \\(x; code \`$$x\``.replaceAll(
      "\\`",
      "`",
    );
    const { container } = render(<RichText text={source} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.textContent).toContain("Escaped $x and \\(x; code $$x");
  });

  it("keeps valid same-line and multiline display forms rendered", () => {
    const source = String.raw`$$x$$

$$
y
$$

\[z\]

\[
w
\]`;
    const { container } = render(<RichText text={source} />);
    expect(container.querySelectorAll(".katex-display")).toHaveLength(4);
  });

  it("keeps a KaTeX failure contained and the source readable", () => {
    const { container } = render(<RichText text={"$\\def\\bad{策划}$"} />);
    // throwOnError is false: the raw source stays visible inside the error span
    expect(container.textContent).toContain("\\def\\bad");
  });
});

describe("selection copy", () => {
  it("projects source TeX with canonical delimiters while preserving selected HTML", () => {
    const { container } = render(
      <RichText
        text={String.raw`Before $E=mc^2$

\[x^2\]

After.`}
      />,
    );
    const root = container.querySelector(".rich-text") as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(root);
    const projected = projectKatexSelection(range, root);
    expect(projected?.plain).toContain("Before $E=mc^2$");
    expect(projected?.plain).toContain("$$x^2$$");
    expect(projected?.plain).toContain("After.");
    expect(projected?.html).toContain("katex-html");
    expect(projected?.html).toContain("annotation");
  });

  it("copies partial inline and display selections with their original delimiter identity", () => {
    const { container } = render(
      <Transcript
        messages={[
          {
            role: "assistant",
            content: [
              {
                type: "text",
                text: String.raw`Inline $i+1$

\[d+2\]`,
              },
            ],
            timestamp: 1,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const inlineHtml = container.querySelector(".rich-text p .katex-html")!;
    const inlineRange = document.createRange();
    inlineRange.setStart(textNode(inlineHtml), 0);
    inlineRange.setEnd(textNode(inlineHtml), 1);
    const inline = dispatchSelectionCopy(inlineHtml, inlineRange);
    expect(inline.event.defaultPrevented).toBe(true);
    expect(inline.data.getData("text/plain")).toBe("$i+1$");
    expect(inline.data.getData("text/html")).toContain("katex-html");
    expect(inline.data.getData("text/html")).not.toContain("katex-display");

    const displayHtml = container.querySelector(".katex-display .katex-html")!;
    const displayRange = document.createRange();
    displayRange.setStart(textNode(displayHtml), 0);
    displayRange.setEnd(textNode(displayHtml), 1);
    const display = dispatchSelectionCopy(displayHtml, displayRange);
    expect(display.event.defaultPrevented).toBe(true);
    expect(display.data.getData("text/plain")).toBe("$$d+2$$");
    expect(display.data.getData("text/html")).toContain("katex-display");
  });

  it("copies multiple formulas with surrounding text and selected HTML", () => {
    const { container } = render(
      <Transcript
        messages={[
          {
            role: "assistant",
            content: [
              { type: "text", text: String.raw`Before $x$ middle \(y\) after` },
            ],
            timestamp: 1,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const paragraph = container.querySelector(".rich-text p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const copied = dispatchSelectionCopy(paragraph, range);
    expect(copied.data.getData("text/plain")).toBe(
      "Before $x$ middle $y$ after",
    );
    expect(
      copied.data.getData("text/html").match(/class=\"katex\"/g),
    ).toHaveLength(2);
    expect(copied.data.getData("text/html")).toContain("Before ");
    expect(copied.data.getData("text/html")).toContain(" after");
  });

  it("handles a real DOM selection and writes both ClipboardEvent formats", () => {
    const { container } = render(
      <Transcript
        messages={[
          {
            role: "assistant",
            content: [{ type: "text", text: "Before $x+1$ after" }],
            timestamp: 1,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const paragraph = container.querySelector(".rich-text p")!;
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const clipboardData = new ClipboardDataTransfer();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: clipboardData });

    paragraph.dispatchEvent(copy);

    expect(copy.defaultPrevented).toBe(true);
    expect(clipboardData.getData("text/plain")).toBe("Before $x+1$ after");
    expect(clipboardData.getData("text/html")).toContain("katex");
    expect(clipboardData.types).toEqual(
      expect.arrayContaining(["text/plain", "text/html"]),
    );
    selection.removeAllRanges();
  });
});

describe("raw HTML and unsafe URL defense", () => {
  it("never parses raw HTML from model content", () => {
    const html = 'Look <img src="x" onerror="window.__pwned = 1"> here';
    const { container } = render(<RichText text={html} />);
    expect(container.querySelector("img")).toBeNull();
    expect(
      (window as unknown as Record<string, unknown>).__pwned,
    ).toBeUndefined();
    expect(container.textContent).toContain("Look");
  });

  it("does not render script tags", () => {
    const { container } = render(
      <RichText text={"before <script>window.__script = 1</script> after"} />,
    );
    expect(container.querySelector("script")).toBeNull();
    expect(
      (window as unknown as Record<string, unknown>).__script,
    ).toBeUndefined();
  });

  it("strips javascript: URLs from links", () => {
    const { container } = render(
      <RichText text="[click me](javascript:window.__js=1)" />,
    );
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__js).toBeUndefined();
  });

  it("keeps safe https links with safe rel attributes", () => {
    render(<RichText text="[Pi docs](https://pi.dev)" />);
    const link = screen.getByRole("link", { name: "Pi docs" });
    expect(link).toHaveAttribute("href", "https://pi.dev");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
    expect(link).toHaveAttribute("target", "_blank");
  });

  it("renders remote markdown images as links instead of fetching them", () => {
    const { container } = render(
      <RichText text="![tracking pixel](https://attacker.invalid/pixel.png)" />,
    );
    // No <img>: rendering a message must not fire a request to an
    // attacker-chosen host. The reference stays reachable by choice.
    expect(container.querySelector("img")).toBeNull();
    const link = screen.getByRole("link", { name: /tracking pixel/ });
    expect(link).toHaveAttribute("href", "https://attacker.invalid/pixel.png");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
  });
});

describe("local file references", () => {
  it("marks local Markdown links as file references without external-link behavior", () => {
    render(<RichText text="See [the report](./out/report.pdf) for details." />);
    const link = screen.getByRole("link", { name: "the report" });
    expect(link).toHaveAttribute("data-file-path", "./out/report.pdf");
    expect(link).not.toHaveAttribute("target");
    expect(link).not.toHaveAttribute("rel");
  });

  it("marks absolute and file: URL links as file references", () => {
    render(
      <RichText text="[log](/tmp/run.log) and [chart](file:///tmp/chart.png)" />,
    );
    expect(screen.getByRole("link", { name: "log" })).toHaveAttribute(
      "data-file-path",
      "/tmp/run.log",
    );
    expect(screen.getByRole("link", { name: "chart" })).toHaveAttribute(
      "data-file-path",
      "file:///tmp/chart.png",
    );
  });

  it("keeps http(s) and mailto links as safe external links", () => {
    render(
      <RichText text="[Pi](https://pi.dev) [mail](mailto:a@b.c) [paper](http://x.test/p.pdf)" />,
    );
    for (const name of ["Pi", "mail", "paper"]) {
      const link = screen.getByRole("link", { name });
      expect(link).not.toHaveAttribute("data-file-path");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link).toHaveAttribute("rel", "noreferrer noopener");
    }
  });

  it("makes local images open the preview and remote images click-through links", () => {
    const { container } = render(
      <RichText text="![chart](./chart.png) and ![logo](https://pi.dev/logo.png)" />,
    );
    const local = screen.getByRole("button", { name: "Preview chart" });
    expect(local).toHaveAttribute("data-file-path", "./chart.png");
    // Remote images never auto-load; the reference becomes an explicit link.
    expect(container.querySelector("img")).toBeNull();
    const remote = screen.getByRole("link", { name: /logo/ });
    expect(remote).toHaveAttribute("href", "https://pi.dev/logo.png");
    expect(remote.closest("[data-file-path]")).toBeNull();
  });

  it("makes credible inline-code paths clickable without touching ordinary code", () => {
    const { container } = render(
      <RichText text="Edit `src/store.ts` then run `npm test`." />,
    );
    const ref = container.querySelector('[data-file-path="src/store.ts"]');
    expect(ref).toBeTruthy();
    expect(ref!.textContent).toBe("src/store.ts");
    expect(container.querySelector('[data-file-path="npm test"]')).toBeNull();
  });
});

describe("markdown constructs", () => {
  it("renders GFM tables and task lists", () => {
    const text = "| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo";
    const { container } = render(<RichText text={text} />);
    expect(container.querySelector("table")).toBeTruthy();
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(
      2,
    );
  });

  it("renders fenced code with a language label and copy control", () => {
    const { container } = render(
      <RichText text={"```python\nprint(1)\n```"} />,
    );
    expect(container.querySelector(".code-block__lang")?.textContent).toBe(
      "python",
    );
    expect(container.querySelector("code.hljs")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy code" }),
    ).toBeInTheDocument();
  });
});
