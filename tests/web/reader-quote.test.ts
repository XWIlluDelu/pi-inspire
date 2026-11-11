// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import {
  appendDraftBlock,
  formatReaderQuote,
  readerSelectionLocation,
} from "../../src/reader-quote";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("formatReaderQuote", () => {
  it("quotes each line and cites source lines in transcript notation", () => {
    expect(
      formatReaderQuote("a = 1\n\n\n\nb = 2  ", "analysis/fit.py", {
        kind: "lines",
        start: 40,
        end: 41,
      }),
    ).toBe("> a = 1\n>\n> b = 2\n>\n> — analysis/fit.py:40-41");
  });

  it("names a page, a page range or a section", () => {
    expect(
      formatReaderQuote("Instrument resolution: 0.1 ms", "report.pdf", {
        kind: "pages",
        start: 2,
        end: 2,
      }),
    ).toBe("> Instrument resolution: 0.1 ms\n>\n> — report.pdf, page 2");
    expect(
      formatReaderQuote("x", "report.pdf", { kind: "pages", start: 2, end: 3 }),
    ).toContain("report.pdf, pages 2–3");
    expect(
      formatReaderQuote("x", "notes.md", {
        kind: "section",
        heading: "Method",
      }),
    ).toContain("— notes.md, § Method");
    expect(formatReaderQuote("x", "notes.md", null)).toBe(
      "> x\n>\n> — notes.md",
    );
  });

  it("bounds very long passages", () => {
    const quote = formatReaderQuote("w ".repeat(3_000), "a.txt", null);
    expect(quote.length).toBeLessThan(2_100);
    expect(quote).toContain(" …");
  });
});

describe("appendDraftBlock", () => {
  it("separates blocks with one blank line and leaves the caret below", () => {
    expect(appendDraftBlock("", "> q")).toBe("> q\n\n");
    expect(appendDraftBlock("Question?\n\n\n", "> q")).toBe(
      "Question?\n\n> q\n\n",
    );
  });
});

function select(
  start: Node,
  startOffset: number,
  end: Node,
  endOffset: number,
) {
  const range = document.createRange();
  range.setStart(start, startOffset);
  range.setEnd(end, endOffset);
  return range;
}

describe("readerSelectionLocation", () => {
  it("counts Source lines from the start of the code element", () => {
    document.body.innerHTML =
      '<div id="root"><pre class="source-view__pre"><code>one\ntwo\nthree\nfour</code></pre></div>';
    const root = document.getElementById("root")!;
    const text = root.querySelector("code")!.firstChild!;
    expect(readerSelectionLocation(select(text, 4, text, 13), root)).toEqual({
      kind: "lines",
      start: 2,
      end: 3,
    });
  });

  it("reads PDF page numbers from page regions", () => {
    document.body.innerHTML =
      '<div id="root"><div class="pdf-preview__page" aria-label="PDF page 2"><span>A</span></div><div class="pdf-preview__page" aria-label="PDF page 3"><span>B</span></div></div>';
    const root = document.getElementById("root")!;
    const [a, b] = [...root.querySelectorAll("span")].map((s) => s.firstChild!);
    expect(readerSelectionLocation(select(a!, 0, b!, 1), root)).toEqual({
      kind: "pages",
      start: 2,
      end: 3,
    });
  });

  it("uses the nearest preceding heading in rendered documents", () => {
    document.body.innerHTML =
      '<div id="root"><h2>Intro</h2><p>x</p><h2>Method</h2><p id="t">Huber loss</p><h2>Results</h2></div>';
    const root = document.getElementById("root")!;
    const text = document.getElementById("t")!.firstChild!;
    expect(readerSelectionLocation(select(text, 0, text, 5), root)).toEqual({
      kind: "section",
      heading: "Method",
    });
  });
});
