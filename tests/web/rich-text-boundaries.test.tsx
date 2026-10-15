// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RichText } from "../../src/components/RichText";
import { parseRichText } from "../../src/rich-text-parser";
import {
  escapedCurrencyMath,
  richTextLiteralCases,
} from "./fixtures/rich-text-literals";

describe("literal content beside mathematical notation", () => {
  it.each(richTextLiteralCases)(
    "preserves %s without swallowing adjacent Markdown",
    (_name, source) => {
      const { container } = render(
        <RichText
          text={source + "\n\n**Still prose**, followed by $x+1$/2."}
        />,
      );
      expect(container.querySelector("p")?.textContent).toBe(source);
      expect(container.querySelector("strong")?.textContent).toBe(
        "Still prose",
      );
      expect(container.querySelectorAll(".katex")).toHaveLength(1);
      expect(container.querySelector("annotation")?.textContent).toBe("x+1");
    },
  );

  it.each([
    ["ordinary", "$x+1$", "x+1"],
    ["padded", "$ x+1 $", "x+1"],
    ["ordinal suffix", "The $n$th item.", "n"],
    ["Chinese adjacency", "第$n$项。", "n"],
    ["prime", "$f'(x)$", "f'(x)"],
    ["currency", "$" + escapedCurrencyMath + "$", escapedCurrencyMath],
    [
      "backslash currency",
      "\\(" + escapedCurrencyMath + "\\)",
      escapedCurrencyMath,
    ],
    [
      "display currency",
      "$$" + escapedCurrencyMath + "$$",
      escapedCurrencyMath,
    ],
    [
      "inline double dollar",
      "Cost $$" + escapedCurrencyMath + "$$.",
      escapedCurrencyMath,
    ],
    [
      "repeated escaped dollars",
      String.raw`$\text{\$\$}$`,
      String.raw`\text{\$\$}`,
    ],
    ["even slash run", String.raw`$a\\$`, String.raw`a\\`],
    [
      "mixed marker lengths",
      String.raw`Inline $$x+\verb|$|+y$$ remains math.`,
      String.raw`x+\verb|$|+y`,
    ],
  ])("keeps %s math and delimiter escapes intact", (_name, source, body) => {
    const { container } = render(<RichText text={source!} />);
    expect(container.querySelectorAll("annotation")).toHaveLength(1);
    expect(container.querySelector("annotation")?.textContent).toBe(body);
    expect(container.querySelector(".katex-error")).toBeNull();
  });

  it("preserves raw inline and block tags as inert text", () => {
    const source =
      '<script>window.__injected = true</script>\n\n<img src="https://example.invalid/tracker" onerror="alert(1)">\n\nArray<T> and <Widget />.';
    const { container } = render(<RichText text={source} />);
    expect(container.textContent).toContain(
      "<script>window.__injected = true</script>",
    );
    expect(container.textContent).toContain("Array<T> and <Widget />.");
    expect(container.querySelector("script, img, widget")).toBeNull();
    expect(container.textContent).toContain('onerror="alert(1)"');
  });

  it("uses the same boundary rules in document and chat parsing", () => {
    const text =
      richTextLiteralCases.map(([, source]) => source).join("\n\n") +
      "\n\n$" +
      escapedCurrencyMath +
      "$";
    expect(parseRichText(text, true)).toEqual(parseRichText(text, false));
  });

  it("leaves code and escaped literal dollars outside math unchanged", () => {
    const text =
      String.raw`Price \$5 and \$10.` +
      "\n\n`Array<T> $HOME $PATH`\n\n```sh\necho $HOME; /^\\d+$/\n```";
    const { container } = render(<RichText text={text} />);
    expect(container.querySelectorAll(".katex")).toHaveLength(0);
    expect(container.querySelector("p")?.textContent).toBe("Price $5 and $10.");
    expect(container.querySelector(".inline-code")?.textContent).toBe(
      "Array<T> $HOME $PATH",
    );
    expect(container.querySelector("pre")?.textContent).toBe(
      "echo $HOME; /^\\d+$/",
    );
  });
});
