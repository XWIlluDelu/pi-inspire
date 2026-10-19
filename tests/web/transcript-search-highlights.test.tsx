// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderedSearchRanges } from "../../src/components/transcript-search-highlights";

describe("rendered transcript search", () => {
  it("highlights filename labels, not their full-path tooltip or transport metadata", () => {
    const { container } = render(
      <div>
        <div className="rich-text">
          <p>Inspect this</p>
        </div>
        <ul className="user-bubble__files">
          <li title="/cache/report.md">
            <span>report.md</span>
          </li>
          <li title="/workspace/report.md">
            <span>report.md</span>
          </li>
        </ul>
      </div>,
    );
    expect(
      renderedSearchRanges(container, "report.md").map((range) =>
        range.toString(),
      ),
    ).toEqual(["report.md", "report.md"]);
    expect(renderedSearchRanges(container, "/cache")).toHaveLength(0);
  });

  it("maps literal text across emphasis without altering markup or copy text", () => {
    const { container } = render(
      <div className="rich-text">
        <p>
          First <strong>precise</strong> match, second <em>precise match</em>.
        </p>
      </div>,
    );
    const html = container.innerHTML;
    const text = container.textContent;
    const ranges = renderedSearchRanges(container, "PRECISE match");
    expect(ranges.map((range) => range.toString())).toEqual([
      "precise match",
      "precise match",
    ]);
    expect(ranges[0]!.startContainer.parentElement?.tagName).toBe("STRONG");
    expect(ranges[0]!.endContainer.parentElement?.tagName).toBe("P");
    expect(container.innerHTML).toBe(html);
    expect(container.textContent).toBe(text);
  });

  it("includes syntax spans, but not code actions, hidden text or duplicate MathML", () => {
    const { container } = render(
      <div className="rich-text">
        <div className="code-block__bar">
          <button>Copy match</button>
        </div>
        <pre>
          <code>
            const <span className="hljs-string">match</span> = 1;
          </code>
        </pre>
        <span hidden>match</span>
        <span className="katex">
          <span className="katex-mathml">match</span>
          <span className="katex-html" aria-hidden>
            match
          </span>
        </span>
      </div>,
    );
    expect(
      renderedSearchRanges(container, "match").map((range) => range.toString()),
    ).toEqual(["match", "match"]);
  });

  it("does not duplicate nested extension bodies or join unrelated paragraphs", () => {
    const { container } = render(
      <div className="custom-message__body">
        <div className="rich-text">
          <p>matched</p>
          <p>words</p>
        </div>
      </div>,
    );
    expect(renderedSearchRanges(container, "matched")).toHaveLength(1);
    expect(renderedSearchRanges(container, "matchedwords")).toHaveLength(0);
  });

  it("keeps offsets in the original string when case folding changes length", () => {
    const { container } = render(
      <div className="rich-text">
        <p>İ X, [x]+</p>
      </div>,
    );
    expect(
      renderedSearchRanges(container, "x").map((range) => range.toString()),
    ).toEqual(["X", "x"]);
    expect(
      renderedSearchRanges(container, "[x]+").map((range) => range.toString()),
    ).toEqual(["[x]+"]);
  });

  it("preserves literal punctuation, CJK and astral text offsets", () => {
    const { container } = render(
      <div className="rich-text">
        <p>
          📖 [结果] <strong>📖 [结果]</strong>
        </p>
      </div>,
    );
    expect(
      renderedSearchRanges(container, "📖 [结果]").map((range) =>
        range.toString(),
      ),
    ).toEqual(["📖 [结果]", "📖 [结果]"]);
    expect(renderedSearchRanges(container, "")).toHaveLength(0);
  });
});
