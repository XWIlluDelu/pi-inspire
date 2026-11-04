import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useImageUrl } from "../../src/use-image-url";
import { deferred } from "./helpers";

beforeEach(() => {
  let serial = 0;
  vi.spyOn(URL, "createObjectURL").mockImplementation(
    () => `blob:image-${++serial}`,
  );
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("image read and URL ownership", () => {
  it("keeps a stable read across renders and releases its URL on unmount", async () => {
    const load = vi.fn(async (_signal: AbortSignal) => new Blob(["image"]));
    const view = renderHook(() => useImageUrl(load), { wrapper: StrictMode });
    await waitFor(() => expect(view.result.current.src).toBe("blob:image-1"));
    expect(load.mock.calls[0][0].aborted).toBe(true);
    expect(URL.createObjectURL).toHaveBeenCalledOnce();

    view.rerender();
    expect(load).toHaveBeenCalledTimes(2);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    view.unmount();
    expect(load.mock.calls[1][0].aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:image-1");
  });

  it("does not reuse a revoked URL when returning to the same loader", async () => {
    const returning = deferred<Blob>();
    const other = deferred<Blob>();
    const load = vi
      .fn<(_: AbortSignal) => Promise<Blob>>()
      .mockResolvedValueOnce(new Blob(["first"]))
      .mockReturnValueOnce(returning.promise);
    const loadOther = vi.fn((_signal: AbortSignal) => other.promise);
    const view = renderHook(({ loader }) => useImageUrl(loader), {
      initialProps: { loader: load },
    });
    await waitFor(() => expect(view.result.current.src).toBe("blob:image-1"));
    view.rerender({ loader: loadOther });
    expect(view.result.current).toEqual({});
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:image-1");
    view.rerender({ loader: load });
    expect(view.result.current).toEqual({});
    await act(async () => other.reject(new Error("retired failure")));
    expect(view.result.current).toEqual({});
    await act(async () => returning.resolve(new Blob(["returning"])));
    expect(view.result.current.src).toBe("blob:image-2");
  });

  it("clears unavailable state on retry and discards a result after unmount", async () => {
    const retry = deferred<Blob | null>();
    const load = vi.fn(
      async (_signal: AbortSignal): Promise<Blob | null> => null,
    );
    const loadRetry = vi.fn((_signal: AbortSignal) => retry.promise);
    const view = renderHook(({ loader }) => useImageUrl(loader), {
      initialProps: { loader: load },
    });
    await waitFor(() =>
      expect(view.result.current.error).toBe("Image unavailable"),
    );
    view.rerender({ loader: loadRetry });
    expect(view.result.current).toEqual({});
    view.unmount();
    expect(loadRetry.mock.calls[0][0].aborted).toBe(true);
    await act(async () => retry.resolve(new Blob(["late"])));
    expect(URL.createObjectURL).not.toHaveBeenCalled();
  });
});
