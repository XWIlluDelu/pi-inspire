// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RichText } from "../../src/components/RichText";
import { ProgressiveRichText } from "../../src/components/ProgressiveRichText";
import {
  parseRichText,
  type RichTextParseRequest,
} from "../../src/rich-text-parser";

class ParserWorker {
  static instances: ParserWorker[] = [];
  onmessage: Worker["onmessage"] = null;
  onerror: Worker["onerror"] = null;
  onmessageerror: Worker["onmessageerror"] = null;
  readonly requests: RichTextParseRequest[] = [];
  terminate = vi.fn();
  constructor() {
    ParserWorker.instances.push(this);
  }
  postMessage(request: RichTextParseRequest) {
    this.requests.push(request);
  }
  finish(index: number) {
    const request = this.requests[index]!;
    this.onmessage?.call(
      this as unknown as Worker,
      new MessageEvent("message", {
        data: {
          id: request.id,
          tree: parseRichText(request.text, request.headings),
        },
      }),
    );
  }
}
function worker() {
  ParserWorker.instances = [];
  vi.stubGlobal("Worker", ParserWorker);
}
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const filler = "Ordinary paragraph.\n\n".repeat(1_700);

describe("large Markdown reader", () => {
  it("shows source immediately, preserves a parsed prefix, and resolves forward definitions", () => {
    worker();
    const source = "[Forward][later] and a footnote[^value].\n\n" + filler;
    const view = render(<RichText text={source} />);
    const parser = ParserWorker.instances[0]!;
    expect(view.container.querySelector('[aria-busy="true"]')).not.toBeNull();
    expect(view.container.textContent).toBe(source);
    act(() => parser.finish(0));
    expect(view.container.querySelector("p")).not.toBeNull();
    const text =
      source +
      "[later]: /docs/reference.md\n\n[^value]: Footnote value\n\n**New text**";
    view.rerender(<RichText text={text} />);
    expect(view.container.querySelector("p")).not.toBeNull();
    expect(view.container.textContent).toContain("**New text**");
    act(() => parser.finish(1));
    expect(
      view.container.querySelector('[data-file-path="/docs/reference.md"]')
        ?.textContent,
    ).toBe("Forward");
    expect(view.container.querySelector("strong")?.textContent).toBe(
      "New text",
    );
    expect(view.container.querySelector('[aria-busy="true"]')).toBeNull();
    const final = view.container.innerHTML;
    view.unmount();
    expect(parser.terminate).toHaveBeenCalledOnce();
    vi.stubGlobal("Worker", undefined);
    const synchronous = render(<RichText text={text} />);
    expect(synchronous.container.innerHTML).toBe(final);
  });

  it("does not resurrect an old parsed tree after replacement or unmount", () => {
    worker();
    const source = "## Old message\n\n" + filler;
    const view = render(<RichText text={source} />);
    const parser = ParserWorker.instances[0]!;
    act(() => parser.finish(0));
    view.rerender(<RichText text={source + "old tail"} />);
    const replacement =
      "## Replaced message\n\n" + filler + '<img src=x onerror="alert(1)">';
    view.rerender(<RichText text={replacement} />);
    expect(view.container.querySelector("h2")).toBeNull();
    expect(view.container.textContent).toBe(replacement);
    expect(view.container.querySelector("img")).toBeNull();
    act(() => parser.finish(1));
    expect(view.container.querySelector("h2")).toBeNull();
    expect(parser.requests[2]?.text).toBe(replacement);
    view.unmount();
    act(() => parser.finish(2));
    expect(view.container.innerHTML).toBe("");
    expect(parser.terminate).toHaveBeenCalledOnce();
  });

  it("keeps exact source readable through the existing boundary if worker loading fails", async () => {
    worker();
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const view = render(<ProgressiveRichText text={filler} />);
    await waitFor(() => expect(ParserWorker.instances).toHaveLength(1));
    const parser = ParserWorker.instances[0]!;
    act(() =>
      parser.onerror?.call(
        parser as unknown as Worker,
        new ErrorEvent("error", { message: "Asset unavailable" }),
      ),
    );
    await waitFor(() =>
      expect(
        view.container.querySelector(".rich-text--deferred"),
      ).not.toBeNull(),
    );
    expect(view.container.textContent).toBe(filler);
    expect(parser.terminate).toHaveBeenCalledOnce();
  });
});
