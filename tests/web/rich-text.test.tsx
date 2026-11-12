// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RichText } from "../../src/components/RichText";
import { Transcript } from "../../src/components/Transcript";
import { store } from "../../src/store";
import { escapedCurrencyMath } from "./fixtures/rich-text-literals";

class ClipboardDataTransfer {
  private readonly values = new Map<string, string>();
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
    const math = container.querySelectorAll(".katex-mathml math");
    expect(container.querySelectorAll(".katex-mathml mtable")).toHaveLength(3);
    expect(math[2]?.querySelector("annotation")).toHaveTextContent("A =");
    expect(math[3]?.getAttribute("display")).toBe("block");
    expect(math[3]?.querySelector("mtable")?.getAttribute("columnalign")).toBe(
      "right left",
    );
    expect(math[3]?.querySelector("annotation")?.getAttribute("encoding")).toBe(
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
    ["single dollar", "$x"],
    ["bare double dollar", "$$"],
    ["first-line multiline double dollar", "$$A=\nx"],
    ["parenthesis", String.raw`\(x`],
    ["multiline bracket", String.raw`\[\nx`],
  ])("keeps incomplete %s source exact and non-math", (_label, source) => {
    const { container } = render(<RichText text={source} />);
    expect(container.querySelector(".katex")).toBeNull();
    expect(container.querySelector(".rich-text")?.textContent).toBe(source);
  });

  it("keeps regex code literal and valid adjacent math intact", () => {
    const source = "/^a$/i, /^b$/g, `/^c$/`, $x$ and $$y$$ and \\(z\\).";
    const { container } = render(<RichText text={source} />);
    expect(container.querySelector(".inline-code")?.textContent).toBe("/^c$/");
    expect(container.querySelectorAll("annotation")).toHaveLength(3);
    expect(container.querySelector(".rich-text")?.textContent).toContain(
      "/^a$/i, /^b$/g",
    );
  });

  it("recognizes genuine adjacent math and preserves delimiter escapes", () => {
    const formulas = [
      ["$ x+1 $", "x+1"],
      ["The $n$th item and 第$m$项。", "n", "m"],
      ["$f'(x)$", "f'(x)"],
      ["\\(" + escapedCurrencyMath + "\\)", escapedCurrencyMath],
      ["$$" + escapedCurrencyMath + "$$", escapedCurrencyMath],
      ["Cost $$" + escapedCurrencyMath + "$$.", escapedCurrencyMath],
      [String.raw`$\text{\$\$}$`, String.raw`\text{\$\$}`],
      [String.raw`$a\\$`, String.raw`a\\`],
      [
        String.raw`Inline $$x+\verb|$|+y$$ remains math.`,
        String.raw`x+\verb|$|+y`,
      ],
    ];
    const { container } = render(
      <RichText text={formulas.map(([text]) => text).join("\n\n")} />,
    );
    expect(
      Array.from(
        container.querySelectorAll("annotation"),
        (node) => node.textContent,
      ),
    ).toEqual(formulas.flatMap(([, ...source]) => source));
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("keeps a KaTeX failure contained and the source readable", () => {
    const { container } = render(<RichText text={"$\\def\\bad{策划}$"} />);
    // throwOnError is false: the raw source stays visible inside the error span
    expect(container.textContent).toContain("\\def\\bad");
  });
});

it("copies selected formulas and surrounding text with Markdown delimiters", async () => {
  const formula = String.raw`\begin{aligned}
  x&=1\\
    y&=2
\end{aligned}`;
  const inline = "Before $i+1$ after";
  const { container } = render(
    <Transcript
      messages={[
        {
          role: "assistant",
          content: [
            { type: "text", text: inline + "\n\n\\[\n" + formula + "\n\\]" },
          ],
        },
      ]}
      streaming={false}
      thinkingVisibility="collapsed"
      toolVisibility="collapsed"
    />,
  );
  await waitFor(() =>
    expect(container.querySelector(".katex-display")).toBeTruthy(),
  );
  const paragraph = container.querySelector(".rich-text p")!;
  const selection = document.createRange();
  selection.selectNodeContents(paragraph);
  const full = dispatchSelectionCopy(paragraph, selection);
  expect(full.event.defaultPrevented).toBe(true);
  expect(full.data.getData("text/plain")).toBe(inline);
  expect(full.data.getData("text/html")).toContain("katex-html");

  for (const [selector, expected, display] of [
    [".rich-text p .katex-html", "$i+1$", false],
    [".katex-display .katex-html", "$$\n" + formula + "\n$$", true],
  ] as const) {
    const rendered = container.querySelector(selector)!;
    const range = document.createRange();
    const first = textNode(rendered);
    range.setStart(first, 0);
    range.setEnd(first, 1);
    const { event, data } = dispatchSelectionCopy(rendered, range);
    expect(event.defaultPrevented).toBe(true);
    expect(data.getData("text/plain")).toBe(expected);
    expect(data.getData("text/html").includes("katex-display")).toBe(display);
  }
});

it("preserves raw HTML as inert text and strips unsafe link destinations", () => {
  const source =
    "<script>literal script</script>\n\n<img src=x onerror=alert(1)>\n\nArray<T> and <Widget />. [unsafe](javascript:alert(1))";
  const { container } = render(<RichText text={source} />);
  expect(container.textContent).toContain("<script>literal script</script>");
  expect(container.textContent).toContain("onerror=alert(1)");
  expect(container.textContent).toContain("Array<T> and <Widget />.");
  expect(
    container.querySelector('script, img, widget, a[href^="javascript:"]'),
  ).toBeNull();
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

  it("keeps local Markdown links in the session reader", () => {
    const paths = ["./out/report.pdf", "/tmp/run.log", "file:///tmp/chart.png"];
    render(
      <RichText
        text={paths.map((path, i) => `[file ${i}](${path})`).join(" ")}
      />,
    );
    for (const [i, path] of paths.entries()) {
      const link = screen.getByRole("link", { name: `file ${i}` });
      expect(link).toHaveAttribute("data-file-path", path);
    }
  });

  it("keeps http(s) and mailto links as safe external links", () => {
    render(
      <RichText text="[Pi](https://pi.dev) [mail](mailto:a@b.c) [paper](http://x.test/p.pdf)" />,
    );
    for (const name of ["Pi", "mail", "paper"]) {
      const link = screen.getByRole("link", { name });
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
    expect(remote).toHaveAttribute("rel", "noreferrer noopener");
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
  it("preserves and copies fenced and indented code as literal blocks", async ({
    onTestFinished,
  }) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const blocks = [
      [
        "```\n  src/store.ts\n\n\t$x$\n<img src=x>\n```",
        "  src/store.ts\n\n\t$x$\n<img src=x>",
      ],
      ["    src/store.ts\n\n      second", "src/store.ts\n\n  second"],
      ["```unknown-lang\n  first\n\nsecond\n```", "  first\n\nsecond"],
      ["```python\nprint(1)\n```", "print(1)"],
      ["```\n  unfinished", "  unfinished"],
    ];
    const { container } = render(
      <RichText text={blocks.map(([source]) => source).join("\n\n")} />,
    );
    expect(
      Array.from(
        container.querySelectorAll("pre code"),
        (code) => code.textContent,
      ),
    ).toEqual(blocks.map(([, expected]) => expected));
    expect(
      container.querySelector(".inline-code, [data-file-path], img, .katex"),
    ).toBeNull();
    expect(
      screen.getByText("python", { selector: ".code-block__lang" }),
    ).toBeVisible();
    expect(container.querySelector("code.language-python")).toHaveClass("hljs");
    expect(
      screen.getAllByRole("button", { name: "Insert code in terminal" }),
    ).toHaveLength(blocks.length);
    fireEvent.click(screen.getAllByRole("button", { name: "Copy code" })[0]!);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledExactlyOnceWith(blocks[0]![1]),
    );
  });

  it("keeps task markers separate from tight-item content without losing inline formatting", () => {
    const { container } = render(
      <RichText
        text={
          "| A | B |\n| - | - |\n| 1 | 2 |\n\n- [x] Review **reference** and `run-id` before [next run](https://example.invalid/run).\n- [ ] Retain the sample.\n\n7. Ordinary item."
        }
      />,
    );
    expect(screen.getByRole("table")).toBeInTheDocument();
    const ordinaryList = container.querySelector("ol");
    expect(ordinaryList).toHaveAttribute("start", "7");
    expect(ordinaryList?.querySelector("li")).toHaveTextContent(
      "Ordinary item",
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
    const pending = tasks[1]!.querySelector("input");
    expect(pending).not.toBeChecked();
    expect(pending).toBeDisabled();
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
});
