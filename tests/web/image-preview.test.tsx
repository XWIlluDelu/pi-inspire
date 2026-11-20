import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TranscriptImage } from "../../src/components/ImagePreview";
import { fitImage, zoomImage } from "../../src/image-viewport";
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

  it("retires the viewer and object URL on view change, and reads fresh bytes on return", async () => {
    const other = deferred<Blob>();
    const returning = deferred<Blob>();
    const load = vi
      .spyOn(store.resources, "loadTranscriptImage")
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
      .spyOn(store.resources, "loadTranscriptImage")
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

it("bounds extreme zoom at eight times the source size", () => {
  const geometry = {
    image: { width: 1200, height: 800 },
    viewport: { width: 600, height: 400 },
  };
  expect(zoomImage(fitImage(geometry), geometry, 1e9).scale).toBe(8);
});
