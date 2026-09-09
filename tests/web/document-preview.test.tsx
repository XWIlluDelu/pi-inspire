// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResourceDescriptor } from "../../shared/contracts";
import { DocumentPreview } from "../../src/components/DocumentPreview";
import { NotebookPreview } from "../../src/components/NotebookPreview";
import { RichText } from "../../src/components/RichText";
import { store } from "../../src/store";
import { deferred } from "./helpers";

const descriptor: ResourceDescriptor = {
  id: "document-1",
  sessionId: "s1",
  viewId: "view-s1",
  reference: "README.md",
  workspacePath: "reports/README.md",
  name: "README.md",
  mimeType: "text/markdown",
  size: 100,
  kind: "markdown",
};
const raster =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=";
const preview = (text: string, resource = descriptor) => (
  <DocumentPreview descriptor={resource} className="test-document">
    <RichText text={text} />
  </DocumentPreview>
);

describe("document Markdown", () => {
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
    vi.spyOn(store, "loadDocumentImage").mockResolvedValue(
      new Blob(["image"], { type: "image/png" }),
    );
    vi.spyOn(store, "openResource").mockResolvedValue();
  });
  afterEach(() => vi.restoreAllMocks());

  it("renders local images in place, preserving linked images, alt text and titles", async () => {
    const { container, unmount } = render(
      preview(
        '![Training curve](figures/curve.png "Validation MSE")\n\n[![Linked curve](figures/curve.png)](details.md)',
      ),
    );
    const image = await screen.findByRole("img", { name: "Training curve" });
    expect(image).toHaveAttribute("src", "blob:document-image");
    expect(image).toHaveAttribute("title", "Validation MSE");
    expect(container.querySelector("p img")).toBeTruthy();
    expect(store.loadDocumentImage).toHaveBeenCalledTimes(1);
    expect(store.loadDocumentImage).toHaveBeenCalledWith(
      "document-1",
      "./reports/figures/curve.png",
      expect.any(AbortSignal),
    );
    fireEvent.click(screen.getByRole("img", { name: "Linked curve" }));
    expect(store.openResource).toHaveBeenCalledWith("./reports/details.md");
    unmount();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:document-image");
  });

  it("resolves relative file links, extensionless links and inline paths from the document directory", () => {
    render(
      preview(
        "[Guide](../guide.md#results) [License](LICENSE) `./config.yaml`",
      ),
    );
    fireEvent.click(screen.getByRole("link", { name: "Guide" }));
    fireEvent.click(screen.getByRole("link", { name: "License" }));
    fireEvent.click(screen.getByRole("button", { name: "./config.yaml" }));
    expect(
      vi.mocked(store.openResource).mock.calls.map(([reference]) => reference),
    ).toEqual([
      "./reports/../guide.md#results",
      "./reports/LICENSE",
      "./reports/./config.yaml",
    ]);
  });

  it("keeps heading anchors inside the document, including Unicode and duplicates", () => {
    render(
      preview(
        "[Results](#训练结果) [Again](#训练结果-1)\n\n## 训练结果\n\n## 训练结果",
      ),
    );
    const headings = screen.getAllByRole("heading");
    expect(headings.map((heading) => heading.id)).toEqual([
      "user-content-训练结果",
      "user-content-训练结果-1",
    ]);
    fireEvent.click(screen.getByRole("link", { name: "Again" }));
    expect(headings[1]!.scrollIntoView).toHaveBeenCalled();
    expect(store.openResource).not.toHaveBeenCalled();
  });

  it("follows an incoming document fragment after the lazy notebook renderer mounts", async () => {
    render(
      <DocumentPreview
        descriptor={{ ...descriptor, reference: "reports/README.md#results" }}
        className="test-document"
      >
        <NotebookPreview
          text={JSON.stringify({
            cells: [{ cell_type: "markdown", source: "## Results" }],
          })}
        />
      </DocumentPreview>,
    );
    await screen.findByRole("heading", { name: "Results" });
    await waitFor(() =>
      expect(Element.prototype.scrollIntoView).toHaveBeenCalled(),
    );
  });

  it.each([false, true])(
    "waits for image layout before incoming anchors; user cancellation=%s",
    async (cancel) => {
      render(
        preview("## Results\n\n![Curve](curve.png)", {
          ...descriptor,
          reference: "reports/README.md#results",
        }),
      );
      const image = await screen.findByRole("img", { name: "Curve" });
      // jsdom does not decode blob images; explicitly deliver the browser's load.
      await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
      expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      if (cancel) fireEvent.wheel(image);
      Object.defineProperty(image, "complete", {
        configurable: true,
        value: true,
      });
      fireEvent.load(image);
      if (cancel) {
        await act(
          async () => new Promise((resolve) => setTimeout(resolve, 30)),
        );
        expect(Element.prototype.scrollIntoView).not.toHaveBeenCalled();
      } else
        await waitFor(() =>
          expect(Element.prototype.scrollIntoView).toHaveBeenCalledTimes(1),
        );
    },
  );

  it("shows failures and decode errors without falling back to raw paths", async () => {
    vi.mocked(store.loadDocumentImage).mockRejectedValueOnce(
      new Error("The file is not authorized"),
    );
    const { rerender } = render(preview("![Missing curve](missing.png)"));
    const failure = await screen.findByText(
      "Missing curve · Image unavailable",
    );
    expect(failure).toHaveAttribute("title", "The file is not authorized");
    expect(screen.queryByRole("img")).toBeNull();
    rerender(preview("![Corrupt curve](corrupt.png)"));
    fireEvent.error(await screen.findByRole("img", { name: "Corrupt curve" }));
    expect(
      screen.getByText("Corrupt curve · Image unavailable"),
    ).toHaveAttribute("title", "Image could not be decoded");
  });

  it("never auto-loads remote, protocol-relative, data, raw HTML or unrecognized conversation image URLs", () => {
    const text =
      '![Remote](https://attacker.invalid/pixel) ![Protocol relative](//attacker.invalid/pixel) ![Data](data:image/png;base64,AAAA) <img src="https://attacker.invalid/raw">';
    const { container } = render(
      <>
        {preview(text)}
        <RichText text={`${text} ![Unknown](unrecognized-format)`} />
      </>,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(store.loadDocumentImage).not.toHaveBeenCalled();
    expect(
      screen.getAllByRole("link", { name: /Protocol relative/ })[0],
    ).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("retains the conversation's explicit-open image behavior", () => {
    render(<RichText text="![Conversation curve](figures/curve.png)" />);
    expect(
      screen.getByRole("button", { name: "Preview Conversation curve" }),
    ).toHaveAttribute("data-file-path", "figures/curve.png");
    expect(store.loadDocumentImage).not.toHaveBeenCalled();
  });

  it("rejects late images after document replacement and survives StrictMode replay", async () => {
    const late = deferred<Blob>();
    vi.mocked(store.loadDocumentImage).mockImplementation((_id, reference) =>
      reference.includes("old")
        ? late.promise
        : Promise.resolve(new Blob(["new"])),
    );
    const { rerender } = render(
      <StrictMode>{preview("![Old](old.png)")}</StrictMode>,
    );
    await waitFor(() => expect(store.loadDocumentImage).toHaveBeenCalled());
    const oldSignal = vi.mocked(store.loadDocumentImage).mock.calls.at(-1)![2];
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

  it("renders Notebook Markdown/output file images and cell-local attachments without executing HTML", async () => {
    const text = JSON.stringify({
      cells: [
        {
          cell_type: "markdown",
          source:
            "![Cell file](figures/curve.png) ![Attached](attachment:plot%20one.png)",
          attachments: { "plot one.png": { "image/png": raster } },
        },
        {
          cell_type: "markdown",
          source:
            "![Other cell](attachment:plot%20one.png) ![Unsafe](attachment:active.svg)",
          attachments: {
            "active.svg": { "image/svg+xml": "<svg onload='bad()'/>" },
          },
        },
        {
          cell_type: "code",
          source: "",
          outputs: [
            {
              output_type: "display_data",
              data: { "text/markdown": "![Output file](../output.png)" },
            },
          ],
        },
      ],
    });
    render(
      <DocumentPreview descriptor={descriptor} className="test-document">
        <NotebookPreview text={text} />
      </DocumentPreview>,
    );
    const notebook = await screen.findByRole("document", {
      name: "Notebook preview",
    });
    expect(
      await within(notebook).findByRole("img", { name: "Attached" }),
    ).toHaveAttribute("src", `data:image/png;base64,${raster}`);
    await within(notebook).findByRole("img", { name: "Cell file" });
    await within(notebook).findByRole("img", { name: "Output file" });
    expect(
      within(notebook).queryByRole("img", { name: "Other cell" }),
    ).toBeNull();
    expect(
      within(notebook).getByText("Other cell · Image unavailable"),
    ).toBeVisible();
    expect(
      within(notebook).getByText("Unsafe · Image unavailable"),
    ).toBeVisible();
    expect(
      vi.mocked(store.loadDocumentImage).mock.calls.map(([, ref]) => ref),
    ).toEqual(["./reports/figures/curve.png", "./reports/../output.png"]);
  });
});
