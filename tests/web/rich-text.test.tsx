// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RichText } from "../../src/components/RichText";
import { Transcript } from "../../src/components/Transcript";
import { store } from "../../src/store";

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

  it.each(["assistant", "thinking", "extension", "user"] as const)(
    "does not join bare regex anchors into math in %s content",
    (variant) => {
      const source = String.raw`Use /^\d+$/ for the first check. Keep the ordinary words and spaces; replace it with /^(0|[1-9]\d*)$/ instead.`;
      const { container, rerender } = render(
        <RichText text={source} variant={variant} />,
      );
      expect(container.querySelector(".katex")).toBeNull();
      expect(container.querySelector(".rich-text")?.textContent).toBe(source);
      rerender(
        <RichText
          variant={variant}
          text={source + " **Review this** and retain $x+1$/2 as math."}
        />,
      );
      expect(container.querySelector("strong")?.textContent).toBe(
        "Review this",
      );
      expect(container.querySelectorAll(".katex")).toHaveLength(1);
      expect(container.querySelector("annotation")?.textContent).toBe("x+1");
    },
  );

  it("keeps regex code literal and valid adjacent math intact", () => {
    const source = "/^a$/i, /^b$/g, `/^c$/`, $x$ and $$y$$ and \\(z\\).";
    const { container } = render(<RichText text={source} />);
    expect(container.querySelector(".inline-code")?.textContent).toBe("/^c$/");
    expect(container.querySelectorAll("annotation")).toHaveLength(3);
    expect(container.querySelector(".rich-text")?.textContent).toContain(
      "/^a$/i, /^b$/g",
    );
  });

  it("keeps a KaTeX failure contained and the source readable", () => {
    const { container } = render(<RichText text={"$\\def\\bad{策划}$"} />);
    // throwOnError is false: the raw source stays visible inside the error span
    expect(container.textContent).toContain("\\def\\bad");
  });
});

describe("selection copy", () => {
  it("copies partial inline and display selections with their original delimiter identity", async () => {
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
    await waitFor(() =>
      expect(container.querySelector(".rich-text p .katex-html")).toBeTruthy(),
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

  it("handles a real DOM selection and writes both ClipboardEvent formats", async () => {
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
    await waitFor(() =>
      expect(container.querySelector(".rich-text p")).toBeTruthy(),
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

  it("strips javascript: URLs from links", () => {
    const { container } = render(
      <RichText text="[click me](javascript:window.__js=1)" />,
    );
    expect(container.querySelector('a[href^="javascript:"]')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__js).toBeUndefined();
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
  it.each([
    ["code file link", "`README.md`", "./guide.md#results", "README.md", true],
    [
      "code web link",
      "`README.md`",
      "https://pi.dev/guide",
      "README.md",
      false,
    ],
    [
      "local image link",
      "![Curve](./curve.png)",
      "./guide.md#results",
      "Curve",
      true,
    ],
    [
      "remote image link",
      "![Build status](https://pi.dev/status.svg)",
      "https://pi.dev/build",
      "Build status",
      false,
    ],
  ])(
    "preserves authored %s navigation when its content is clicked",
    async (_label, content, href, label, local) => {
      const openResource = vi.spyOn(store, "openResource").mockResolvedValue();
      const { container } = render(
        <Transcript
          messages={[
            {
              role: "assistant",
              content: [{ type: "text", text: `[${content}](${href})` }],
            },
          ]}
          streaming={false}
          thinkingVisibility="expanded"
          toolVisibility="expanded"
        />,
      );
      const target = await screen.findByText(label);
      expect(target.closest("a")).toHaveAttribute("href", href);
      expect(fireEvent.click(target)).toBe(!local);
      if (local) expect(openResource).toHaveBeenCalledExactlyOnceWith(href);
      else expect(openResource).not.toHaveBeenCalled();
      expect(container.querySelector("a button, a a")).toBeNull();
      expect(container.querySelector("img")).toBeNull();
    },
  );

  it("keeps a native code path literal while preserving a Markdown URL's encoding", () => {
    render(
      <RichText
        text={
          "Open `C#/report%20draft.md` or [space file](C%23/report%20draft.md)."
        }
      />,
    );
    expect(
      screen.getByRole("button", { name: "C#/report%20draft.md" }),
    ).toHaveAttribute("data-file-path", "C%23/report%2520draft.md");
    expect(screen.getByRole("link", { name: "space file" })).toHaveAttribute(
      "data-file-path",
      "C%23/report%20draft.md",
    );
  });

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
  it.each([
    [
      "unlabeled fence",
      "```\n  first\n\n\tsecond\n\n```",
      "  first\n\n\tsecond\n",
    ],
    ["indented code", "    first\n\n      second", "first\n\n  second"],
    [
      "unknown language",
      "```unknown-lang\n  first\n\nsecond\n```",
      "  first\n\nsecond",
    ],
    ["incomplete fence", "```\n  first\n\nsecond", "  first\n\nsecond"],
    ["path in fence", "```\nsrc/store.ts\n```", "src/store.ts"],
    ["indented path", "    src/store.ts", "src/store.ts"],
  ])(
    "preserves %s whitespace and copies source as a block",
    async (_label, text, code) => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      const { container } = render(<RichText text={text} />);
      expect(container.querySelector("pre code")?.textContent).toBe(code);
      expect(
        container.querySelector(".inline-code, [data-file-path]"),
      ).toBeNull();
      expect(
        screen.getByRole("button", { name: "Insert code in terminal" }),
      ).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
      await waitFor(() =>
        expect(screen.getByRole("button", { name: "Copied" })).toBeTruthy(),
      );
      expect(writeText).toHaveBeenCalledWith(code);
    },
  );

  it("does not parse HTML or math inside an unlabeled fence", () => {
    const { container } = render(
      <RichText text={"```\n<img src=x onerror=alert(1)>\n$x$\n```"} />,
    );
    expect(container.querySelector("img, .katex")).toBeNull();
    expect(container.querySelector("pre code")?.textContent).toBe(
      "<img src=x onerror=alert(1)>\n$x$",
    );
  });

  it("renders GFM tables and task lists", () => {
    const text = "| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] done\n- [ ] todo";
    const { container } = render(<RichText text={text} />);
    expect(container.querySelector("table")).toBeTruthy();
    const tasks = container.querySelectorAll('input[type="checkbox"]');
    expect(tasks).toHaveLength(2);
    for (const task of tasks) {
      expect(task).toHaveClass("choice-input");
      expect(task).toBeDisabled();
    }
    expect(tasks[0]).toBeChecked();
    expect(tasks[1]).not.toBeChecked();
  });

  it("keeps task markers separate from tight-item content without losing inline formatting", () => {
    const { container } = render(
      <RichText
        text={
          "- [x] Review **reference** and `run-id` before [next run](https://example.invalid/run).\n- [ ] Retain the sample."
        }
      />,
    );
    const tasks = container.querySelectorAll(".task-list-item");
    const content = tasks[0]!.querySelector(".rich-text__task-content")!;
    expect(content.textContent).toBe(
      "Review reference and run-id before next run.",
    );
    expect(content.querySelector("strong")).toHaveTextContent("reference");
    expect(content.querySelector("code")).toHaveTextContent("run-id");
    expect(content.querySelector("a")).toHaveAttribute(
      "href",
      "https://example.invalid/run",
    );
    const marker = content.querySelector(".rich-text__task-marker input");
    expect(marker).toBeChecked();
    expect(marker).toBeDisabled();
    expect(tasks[1]!.querySelector("input")).not.toBeChecked();
  });

  it.each([false, true])(
    "preserves paragraphs, nested tasks and literal whitespace with inline=%s",
    (inline) => {
      const { container } = render(
        <RichText
          inline={inline}
          variant="user"
          text={
            "- [x] Review **reference**.\n\n  Retain  the sample.\n\n  - [ ] Check drift.\n\n- [ ] Report."
          }
        />,
      );
      const list = container.querySelector("ul")!;
      const first = list.querySelector(
        ":scope > li > .rich-text__task-content",
      )!;
      expect(first.textContent).toContain("Retain  the sample.");
      expect(first.querySelectorAll(":scope > p")).toHaveLength(inline ? 0 : 2);
      const marker = first.querySelector(
        inline
          ? ":scope > .rich-text__task-marker input"
          : ":scope > p > .rich-text__task-marker input",
      );
      expect(marker).toBeChecked();
      expect(marker).toBeDisabled();
      const nested = first.querySelector("ul .task-list-item")!;
      expect(
        nested.querySelector(".rich-text__task-content")!.textContent,
      ).toBe("Check drift.");
      expect(nested.querySelector("input")).not.toBeChecked();
      expect(
        container.querySelectorAll(".rich-text__task-marker"),
      ).toHaveLength(3);
    },
  );

  it("keeps literal HTML safe within task content without changing its text", () => {
    const { container } = render(
      <RichText text="- [x] <!-- intentionally empty task -->" />,
    );
    expect(
      container.querySelector(".rich-text__task-content")!.textContent,
    ).toBe("<!-- intentionally empty task -->");
    expect(
      container.querySelector(".rich-text__task-marker input"),
    ).toBeChecked();
    expect(container.querySelector("input")).toBeDisabled();
  });

  it("leaves ordinary list markers and start values unchanged", () => {
    const { container } = render(
      <RichText
        text={
          "3. Review the reference.\n4. Retain the sample.\n\n- Plain bullet."
        }
      />,
    );
    expect(container.querySelector("ol")).toHaveAttribute("start", "3");
    expect(container.querySelectorAll("li")).toHaveLength(3);
    expect(container.querySelector(".rich-text__task-content")).toBeNull();
  });

  it("preserves ordinary entries and start values in mixed task lists", () => {
    const { container } = render(
      <RichText
        text={
          "- [x] Review the reference.\n- Keep the source notes.\n\n3. [ ] Check drift.\n4. Report the result."
        }
      />,
    );
    expect(container.querySelectorAll(".contains-task-list")).toHaveLength(2);
    expect(container.querySelector("ol")).toHaveAttribute("start", "3");
    const ordinary = container.querySelectorAll(
      ".contains-task-list > li:not(.task-list-item)",
    );
    expect(ordinary).toHaveLength(2);
    expect(ordinary[0]).toHaveTextContent("Keep the source notes.");
    expect(ordinary[1]).toHaveTextContent("Report the result.");
    for (const item of ordinary)
      expect(item.querySelector(".rich-text__task-content")).toBeNull();
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
