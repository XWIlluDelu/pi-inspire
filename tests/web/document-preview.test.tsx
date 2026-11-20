// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentPreview } from "../../src/components/DocumentPreview";
import { NotebookPreview } from "../../src/components/NotebookPreview";
import { RichText } from "../../src/components/RichText";
import { store } from "../../src/store";
import { fakeResourceDescriptor } from "./fixtures/resources";
import { deferred } from "./helpers";

const descriptor = fakeResourceDescriptor("README.md", {
  workspacePath: "reports/README.md",
  mimeType: "text/markdown",
  kind: "markdown",
});
const preview = (text: string, resource = descriptor) => (
  <DocumentPreview descriptor={resource} className="test-document">
    <RichText text={text} />
  </DocumentPreview>
);

describe("document image ownership", () => {
  beforeEach(() => {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:document-image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(store.resources, "loadDocumentImage").mockResolvedValue(
      new Blob(["image"], { type: "image/png" }),
    );
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([false, true])(
    "waits for image layout before incoming anchors; user cancellation=%s",
    async (cancel) => {
      vi.useFakeTimers({
        toFake: ["requestAnimationFrame", "cancelAnimationFrame"],
      });
      render(
        preview("## Results\n\n![Curve](curve.png)", {
          ...descriptor,
          reference: "reports/README.md#results",
        }),
      );
      const image = await screen.findByRole("img", { name: "Curve" });
      // jsdom does not decode blob images; explicitly deliver the browser's load.
      act(() => vi.advanceTimersToNextFrame());
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      if (cancel) fireEvent.wheel(image);
      Object.defineProperty(image, "complete", {
        configurable: true,
        value: true,
      });
      fireEvent.load(image);
      act(() => vi.advanceTimersToNextFrame());
      expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(
        cancel ? 0 : 1,
      );
    },
  );

  it("rejects late images after document replacement and survives StrictMode replay", async () => {
    const late = deferred<Blob>();
    vi.mocked(store.resources.loadDocumentImage).mockImplementation(
      (_id, reference) =>
        reference.includes("old")
          ? late.promise
          : Promise.resolve(new Blob(["new"])),
    );
    const { rerender } = render(
      <StrictMode>{preview("![Old](old.png)")}</StrictMode>,
    );
    await waitFor(() =>
      expect(store.resources.loadDocumentImage).toHaveBeenCalled(),
    );
    const oldSignal = vi
      .mocked(store.resources.loadDocumentImage)
      .mock.calls.at(-1)![2];
    rerender(
      <StrictMode>
        {preview("![New](new.png)", { ...descriptor, id: "document-2" })}
      </StrictMode>,
    );
    expect(oldSignal.aborted).toBe(true);
    await screen.findByRole("img", { name: "New" });
    await act(async () => late.resolve(new Blob(["stale"])));
    expect(screen.queryByRole("img", { name: "Old" })).toBeNull();
    expect(URL.createObjectURL).toHaveBeenCalledTimes(1);
  });
});

it.each([
  [{ kernelspec: { name: "python3" } }, "print(42)", true],
  [{ kernelspec: { name: "julia-1.11" } }, "function f()\nend", true],
  [{ kernelspec: { name: "deno" } }, "const x = 42", true],
  [
    {
      language_info: { name: "plaintext" },
      kernelspec: { language: "python", name: "python3" },
    },
    "print(42)",
    false,
  ],
  [
    { kernelspec: { language: "plaintext", name: "python3" } },
    "print(42)",
    false,
  ],
  [{ kernelspec: { name: "constructor" } }, "print(42)", false],
])(
  "uses explicit language before recognized kernel names: %j",
  (metadata, source, highlighted) => {
    const { container } = render(
      <NotebookPreview
        text={JSON.stringify({
          metadata,
          cells: [{ cell_type: "code", source }],
        })}
      />,
    );
    const code = container.querySelector(".notebook-preview__cell--code code")!;
    expect(code.textContent).toBe(source);
    expect(code.childElementCount > 0).toBe(highlighted);
  },
);
