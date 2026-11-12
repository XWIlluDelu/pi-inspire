import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ImageGallery } from "../../src/components/ImageGallery";
import {
  ImagePreview,
  TranscriptImage,
} from "../../src/components/ImagePreview";
import {
  constrainImage,
  fitImage,
  type ImageGeometry,
  resizeImage,
  zoomImage,
} from "../../src/image-viewport";
import { store } from "../../src/store";
import { deferred } from "./helpers";

describe("image preview ownership", () => {
  beforeEach(() => {
    // Real Back navigation is exercised by the browser gallery workflow.
    vi.spyOn(window.history, "pushState").mockImplementation(() => {});
  });

  const view = (viewId: string) => (
    <TranscriptImage
      sessionId="session"
      viewId={viewId}
      projectionKey={`projection-${viewId}`}
      reference="pi-embedded://5/1"
      name="saved plot"
      alt="Saved plot"
    />
  );

  it("fits the next figure even when it reuses the same document-owned URL", () => {
    render(
      <ImageGallery>
        <ImagePreview src="blob:shared" name="First figure" />
        <ImagePreview src="blob:shared" name="Repeated figure" />
      </ImageGallery>,
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Preview First figure" }),
    );
    const dialog = screen.getByRole("dialog", { name: "Image preview" });
    const image = dialog.querySelector("img")!;
    Object.defineProperties(image, {
      naturalWidth: { value: 1200 },
      naturalHeight: { value: 800 },
    });
    fireEvent.load(image);
    const originalFit = image.style.transform;
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Actual size" }),
    );
    fireEvent.change(
      within(dialog).getByRole("combobox", { name: "Image background" }),
      { target: { value: "Black" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Next image" }));
    expect(dialog.querySelector("img")?.style.transform).toBe(originalFit);
    expect(
      within(dialog).getByRole("combobox", { name: "Image background" }),
    ).toHaveValue("Black");
    expect(
      within(dialog).getByRole("group", { name: "Image navigation" }),
    ).toHaveTextContent("2 / 2");
  });
  it("orders a gallery by the document, updates labels without closing, and never revives a retired selection", async () => {
    const items = (sources: string[], name = "two.png") => (
      <StrictMode>
        <ImageGallery>
          {sources.map((src) => (
            <ImagePreview
              key={src}
              src={src}
              name={src === "blob:two" ? name : "one.png"}
            />
          ))}
        </ImageGallery>
      </StrictMode>
    );
    const { rerender } = render(items(["blob:one", "blob:two"]));
    fireEvent.click(screen.getByRole("button", { name: "Preview two.png" }));
    let dialog = screen.getByRole("dialog", { name: "Image preview" });
    expect(
      within(dialog).getByRole("group", { name: "Image navigation" }),
    ).toHaveTextContent("2 / 2");
    rerender(items(["blob:two", "blob:one"], "renamed.png"));
    dialog = screen.getByRole("dialog", { name: "Image preview" });
    expect(within(dialog).getByText("renamed.png")).toBeInTheDocument();
    expect(
      within(dialog).getByRole("group", { name: "Image navigation" }),
    ).toHaveTextContent("1 / 2");
    fireEvent.click(within(dialog).getByRole("button", { name: "Next image" }));
    expect(dialog.querySelector("img")).toHaveAttribute("src", "blob:one");
    rerender(items(["blob:two"]));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Image preview" }),
      ).toBeNull(),
    );
    rerender(items(["blob:one", "blob:two"]));
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
  });

  it("retires the viewer and object URL on view change, and reads fresh bytes on return", async () => {
    const other = deferred<Blob>();
    const returning = deferred<Blob>();
    const load = vi
      .spyOn(store, "loadTranscriptImage")
      .mockResolvedValueOnce(new Blob(["first view"]))
      .mockReturnValueOnce(other.promise)
      .mockReturnValueOnce(returning.promise);
    vi.spyOn(URL, "createObjectURL")
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:returning");
    const revoke = vi.spyOn(URL, "revokeObjectURL");
    const { rerender, unmount } = render(view("first"));
    fireEvent.click(
      await screen.findByRole("button", { name: "Preview saved plot" }),
    );
    expect(screen.getByRole("dialog", { name: "Image preview" })).toBeVisible();

    rerender(view("other"));
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();
    expect(revoke).toHaveBeenCalledWith("blob:first");
    expect(load.mock.lastCall).toEqual([
      "session",
      "other",
      "projection-other",
      "pi-embedded://5/1",
      expect.any(AbortSignal),
    ]);

    rerender(view("first"));
    expect(load.mock.calls[1]?.[4].aborted).toBe(true);
    await act(async () => other.reject(new Error("Stale source")));
    expect(
      screen.getByRole("button", { name: "Saved plot loading" }),
    ).toBeDisabled();
    await act(async () => returning.resolve(new Blob(["returned view"])));
    expect(screen.getByRole("img", { name: "Saved plot" })).toHaveAttribute(
      "src",
      "blob:returning",
    );
    expect(screen.queryByRole("dialog", { name: "Image preview" })).toBeNull();

    unmount();
    expect(revoke.mock.calls).toEqual([["blob:first"], ["blob:returning"]]);
  });

  it("clears a retired error and discards an image that finishes after unmount", async () => {
    const retry = deferred<Blob>();
    const load = vi
      .spyOn(store, "loadTranscriptImage")
      .mockRejectedValueOnce(new Error("Image unavailable"))
      .mockReturnValueOnce(retry.promise);
    const create = vi.spyOn(URL, "createObjectURL");
    const { rerender, unmount } = render(view("first"));
    expect(
      await screen.findByRole("button", { name: "Saved plot unavailable" }),
    ).toBeDisabled();

    rerender(view("retry"));
    expect(
      screen.getByRole("button", { name: "Saved plot loading" }),
    ).toBeDisabled();
    unmount();
    expect(load.mock.lastCall?.[4].aborted).toBe(true);
    await act(async () => retry.resolve(new Blob(["late"])));
    expect(create).not.toHaveBeenCalled();
  });
});

describe("image preview geometry", () => {
  const geometry: ImageGeometry = {
    image: { width: 1200, height: 800 },
    viewport: { width: 600, height: 400 },
  };

  it("keeps the source point under a moving pinch center", () => {
    const view = fitImage(geometry);
    const anchor = { x: -100, y: -50 };
    const destination = { x: 40, y: 20 };
    const zoomed = zoomImage(view, geometry, 1, anchor, destination);
    expect((destination.x - zoomed.x) / zoomed.scale).toBe(
      (anchor.x - view.x) / view.scale,
    );
    expect((destination.y - zoomed.y) / zoomed.scale).toBe(
      (anchor.y - view.y) / view.scale,
    );
  });

  it("refits after resize and clamps manual pan without changing zoom", () => {
    const resized = { ...geometry, viewport: { width: 320, height: 600 } };
    expect(resizeImage(fitImage(geometry), resized).scale).toBeCloseTo(
      320 / 1200,
    );
    const manual = { scale: 1, fitted: false, x: 500, y: 30 };
    expect(resizeImage(manual, resized)).toEqual({ ...manual, x: 440 });
    const small = { ...resized, image: { width: 64, height: 64 } };
    expect(constrainImage(manual, small)).toEqual({ ...manual, x: 0, y: 0 });
  });

  it("caps close-ups while allowing the full height of long screenshots", () => {
    expect(zoomImage(fitImage(geometry), geometry, 1e9).scale).toBe(8);
    const long = {
      image: { width: 1200, height: 10000 },
      viewport: { width: 320, height: 400 },
    };
    expect(zoomImage(fitImage(long), long, 0).scale).toBe(0.04);
  });
});
