// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PdfPreview, pdfRenderSize } from "../../src/components/PdfPreview";
import {
  markOccurrence,
  normalizeFindQuery,
  pageMatches,
} from "../../src/pdf-find";
import { deferred } from "./helpers";

const mocks = vi.hoisted(() => ({ load: vi.fn(), cancelText: vi.fn() }));
vi.mock("../../src/pdf-renderer", () => ({
  loadPdf: mocks.load,
  TextLayer: class {
    constructor(
      private options: { container: HTMLElement; textContentSource: string },
    ) {}
    render() {
      this.options.container.textContent = this.options.textContentSource;
      return Promise.resolve();
    }
    cancel() {
      mocks.cancelText();
    }
  },
}));

function fakePdf(numPages = 2) {
  const renderPage = vi.fn(() => ({
    promise: Promise.resolve(),
    cancel: vi.fn(),
  }));
  const cleanup = vi.fn();
  const document = {
    numPages,
    getPage: vi.fn(async (number: number) => ({
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: renderPage,
      streamTextContent: () => `Page ${number} selectable text`,
      cleanup,
    })),
  };
  const task = {
    promise: Promise.resolve(document),
    destroy: vi.fn(async () => {}),
  };
  return { task, document, renderPage, cleanup };
}

const pdfBlob = () => new Blob([new Uint8Array([37, 80, 68, 70])]);

describe("static PDF preview", () => {
  beforeEach(() => {
    mocks.load.mockReset();
    mocks.cancelText.mockReset();
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(424);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(424);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return Number.parseFloat(
          this.querySelector<HTMLElement>(".pdf-preview__pages")?.style
            .height ?? "500",
        );
      },
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it("keeps a bounded page window and releases rendering work when closed", async () => {
    const pdf = fakePdf(100);
    mocks.load.mockReturnValue(pdf.task);
    const { container, unmount } = render(
      <PdfPreview blob={pdfBlob()} name="long-report.pdf" />,
    );
    await screen.findByText("Page 1 selectable text");
    expect(pdf.document.getPage.mock.calls.length).toBeLessThanOrEqual(3);
    const scroll = screen.getByRole("region", { name: "PDF pages" });
    vi.useFakeTimers();
    try {
      scroll.scrollTop = 20_000;
      fireEvent.scroll(scroll);
      // Finish the virtualizer's scroll-end fallback while its view is mounted.
      await act(() => vi.runOnlyPendingTimersAsync());
    } finally {
      vi.useRealTimers();
    }
    await waitFor(() =>
      expect(screen.queryByRole("region", { name: "PDF page 1" })).toBeNull(),
    );
    await waitFor(() => expect(pdf.cleanup).toHaveBeenCalled());
    expect(container.querySelectorAll("canvas").length).toBeLessThanOrEqual(4);
    expect(pdf.document.getPage.mock.calls.length).toBeLessThan(12);
    unmount();
    expect(pdf.task.destroy).toHaveBeenCalledOnce();
    expect(mocks.cancelText).toHaveBeenCalled();
  });

  it("fits mixed portrait and landscape pages independently", async () => {
    const pdf = fakePdf();
    const original = pdf.document.getPage.getMockImplementation()!;
    pdf.document.getPage.mockImplementation(async (number) => ({
      ...(await original(number)),
      getViewport: ({ scale }: { scale: number }) => ({
        width: (number === 1 ? 600 : 800) * scale,
        height: (number === 1 ? 800 : 400) * scale,
      }),
    }));
    mocks.load.mockReturnValue(pdf.task);
    render(<PdfPreview blob={pdfBlob()} name="mixed.pdf" />);
    await screen.findByText("Page 2 selectable text");
    const portrait = screen.getByRole("region", { name: "PDF page 1" });
    const landscape = screen.getByRole("region", { name: "PDF page 2" });
    await waitFor(() =>
      expect(parseFloat(landscape.style.height)).toBeCloseTo(200),
    );
    expect(parseFloat(portrait.style.height)).toBeCloseTo((400 * 800) / 600);
  });

  it("does not start a worker if byte decoding finishes after closing the preview", async () => {
    const bytes = deferred<ArrayBuffer>();
    const blob = pdfBlob();
    vi.spyOn(blob, "arrayBuffer").mockReturnValue(bytes.promise);
    const { unmount } = render(<PdfPreview blob={blob} name="old.pdf" />);
    unmount();
    await act(async () => bytes.resolve(new ArrayBuffer(4)));
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("retires pending loading and ignores its result after replacement", async () => {
    const old = deferred<ReturnType<typeof fakePdf>["document"]>();
    const destroy = vi.fn(async () => {});
    mocks.load.mockReturnValueOnce({ promise: old.promise, destroy });
    const pdf = fakePdf();
    mocks.load.mockReturnValueOnce(pdf.task);
    const { rerender } = render(<PdfPreview blob={pdfBlob()} name="old.pdf" />);
    await waitFor(() => expect(mocks.load).toHaveBeenCalledTimes(1));
    rerender(<PdfPreview blob={pdfBlob()} name="new.pdf" />);
    await screen.findByText("Page 1 selectable text");
    expect(destroy).toHaveBeenCalledTimes(1);
    const stale = fakePdf();
    await act(async () => old.resolve(stale.document));
    expect(stale.document.getPage).not.toHaveBeenCalled();
  });

  it("cancels obsolete page renders on zoom without letting their completion replace the new surface", async () => {
    const pdf = fakePdf();
    const first = deferred<void>();
    const cancel = vi.fn(() => first.reject(new Error("cancelled")));
    pdf.renderPage.mockReturnValueOnce({ promise: first.promise, cancel });
    mocks.load.mockReturnValue(pdf.task);
    render(<PdfPreview blob={pdfBlob()} name="report.pdf" />);
    await waitFor(() => expect(pdf.renderPage).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole("button", { name: "Zoom in PDF" }));
    await screen.findByText("Page 2 selectable text");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("PDF page unavailable")).toBeNull();
  });

  it.each(["InvalidPDFException", "PasswordException"])(
    "shows an actionable %s error, not a blank preview",
    async (name) => {
      mocks.load.mockImplementation(() => ({
        promise: Promise.reject(Object.assign(new Error("bad"), { name })),
        destroy: vi.fn(async () => {}),
      }));
      render(<PdfPreview blob={pdfBlob()} name="report.pdf" />);
      await screen.findByText("PDF preview unavailable");
      expect(
        screen.getByText(
          name === "PasswordException"
            ? /Password required/
            : "Download to open in another reader.",
        ),
      ).toBeVisible();
    },
  );

  it("bounds backing pixels and dimensions for high-DPI, zoomed or extreme-aspect pages", () => {
    for (const [width, height] of [
      [600, 800],
      [1, 1_000_000],
      [1_000_000, 1],
    ]) {
      const size = pdfRenderSize(width!, height!, 1600, 3, 4);
      expect(size.width * size.height * size.pixels ** 2).toBeLessThanOrEqual(
        4_000_001,
      );
      expect(
        Math.max(size.width, size.height) * size.pixels,
      ).toBeLessThanOrEqual(8192);
      expect(Math.max(size.width, size.height)).toBeLessThanOrEqual(16_384);
    }
  });
});

it("finds repeated text in nested PDF text spans and clears the previous highlight", () => {
  const layer = document.createElement("div");
  layer.innerHTML =
    '<span>Sample A</span><span class="markedContent"><span>none</span><span>sample a twice SAMPLE  A</span></span>';
  const needle = normalizeFindQuery("  Sample   A ");
  const matches = pageMatches(
    2,
    ["Sample A", "none", "sample a twice SAMPLE  A"],
    needle,
  );
  expect(matches).toEqual([
    { page: 2, occurrence: 0 },
    { page: 2, occurrence: 1 },
    { page: 2, occurrence: 2 },
  ]);
  expect(
    markOccurrence(layer, needle, matches[2]!.occurrence, "hit")?.textContent,
  ).toBe("sample a twice SAMPLE  A");
  expect(
    markOccurrence(layer, needle, matches[0]!.occurrence, "hit")?.textContent,
  ).toBe("Sample A");
  expect(layer.querySelectorAll(".hit")).toHaveLength(1);
});
