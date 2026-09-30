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

function fakePdf() {
  const renderPage = vi.fn(() => ({
    promise: Promise.resolve(),
    cancel: vi.fn(),
  }));
  const cleanup = vi.fn();
  const document = {
    numPages: 2,
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
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders one page with selectable text, page navigation and zoom, never active embeds", async () => {
    const pdf = fakePdf();
    mocks.load.mockReturnValue(pdf.task);
    const { container, unmount } = render(
      <PdfPreview blob={pdfBlob()} name="report.pdf" />,
    );
    await screen.findByText("Page 1 selectable text");
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    expect(
      container.querySelector("iframe, object, embed, a, form"),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Previous PDF page" }),
    ).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Next PDF page" }));
    await screen.findByText("Page 2 selectable text");
    expect(
      screen.getByRole("button", { name: "Next PDF page" }),
    ).toBeDisabled();
    expect(container.querySelectorAll("canvas")).toHaveLength(1);
    const scroll = screen.getByRole("region", { name: "PDF page 2" });
    scroll.scrollTop = 80;
    fireEvent.click(screen.getByRole("button", { name: "Zoom in PDF" }));
    await waitFor(() =>
      expect(
        Math.abs(container.querySelector("canvas")!.width - 500),
      ).toBeLessThanOrEqual(1),
    );
    await waitFor(() => expect(scroll.scrollTop).toBeCloseTo(100));
    fireEvent.click(screen.getByRole("button", { name: "Fit PDF to width" }));
    await waitFor(() =>
      expect(container.querySelector("canvas")!.width).toBe(400),
    );
    await waitFor(() => expect(scroll.scrollTop).toBeCloseTo(80));
    expect(mocks.load).toHaveBeenCalledWith(expect.any(ArrayBuffer));
    unmount();
    expect(pdf.task.destroy).toHaveBeenCalledTimes(1);
    expect(mocks.cancelText).toHaveBeenCalled();
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

  it("cancels a page render when navigating, without letting its completion replace the next page", async () => {
    const pdf = fakePdf();
    const first = deferred<void>();
    const cancel = vi.fn(() => first.reject(new Error("cancelled")));
    pdf.renderPage.mockReturnValueOnce({ promise: first.promise, cancel });
    mocks.load.mockReturnValue(pdf.task);
    render(<PdfPreview blob={pdfBlob()} name="report.pdf" />);
    await waitFor(() => expect(pdf.renderPage).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Next PDF page" }));
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
            ? /needs a password/
            : /could not be read/,
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
