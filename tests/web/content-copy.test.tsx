// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyAction } from "../../src/components/CopyAction";
import { messageCopyContent } from "../../src/message-copy";
import { store } from "../../src/store";
import { deferred } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("owned content copying", () => {
  it("retires a pending content read on unmount without writing or reporting success", async () => {
    const read = deferred<string>();
    let signal: AbortSignal | undefined;
    const writeText = vi.fn();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const view = render(
      <CopyAction
        label="message"
        className="copy"
        getContent={(owner) => {
          signal = owner;
          return read.promise;
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    view.unmount();
    expect(signal?.aborted).toBe(true);
    read.resolve("retired content");
    await read.promise;
    expect(writeText).not.toHaveBeenCalled();
  });

  it("rechecks the source view after asynchronous reads and reports current clipboard errors", async () => {
    const read = deferred<string>();
    let current = true;
    vi.spyOn(store, "copyOwnership").mockImplementation(() => () => current);
    const report = vi
      .spyOn(store, "reportCopyError")
      .mockImplementation(() => {});
    const writeText = vi
      .fn()
      .mockRejectedValue(new Error("Clipboard permission denied"));
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { rerender } = render(
      <CopyAction
        label="message"
        className="copy"
        getContent={() => read.promise}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    current = false;
    read.resolve("old view");
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Copy message" }),
      ).toBeEnabled(),
    );
    expect(writeText).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
    current = true;
    rerender(<CopyAction label="message" className="copy" text="new view" />);
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() =>
      expect(report).toHaveBeenCalledWith("Clipboard permission denied"),
    );
    expect(screen.queryByRole("button", { name: "message copied" })).toBeNull();
  });

  it("uses direct saved-image authority rather than projected inline data and preserves duplicates", async () => {
    const png = new Blob(["saved"], { type: "image/png" });
    const read = vi.spyOn(store, "loadEmbeddedImage").mockResolvedValue(png);
    const owner = { sessionId: "s1", viewId: "v1", projectionKey: "p1" };
    const signal = new AbortController().signal;
    const message = {
      role: "user",
      __inspireMessageIndex: 4,
      content: [
        { type: "image", mimeType: "image/png", data: "not-authority" },
        { type: "text", text: "caption" },
        { type: "image", mimeType: "image/png", data: "not-authority" },
      ],
    };
    expect(await messageCopyContent(message, "caption", owner, signal)).toEqual(
      { text: "caption", images: [png, png] },
    );
    expect(read.mock.calls.map((call) => call[3])).toEqual([
      "pi-embedded://4/0",
      "pi-embedded://4/2",
    ]);
    read.mockRejectedValue(new Error("Saved image is unavailable"));
    await expect(
      messageCopyContent(message, "caption", owner, signal),
    ).rejects.toThrow("Saved image is unavailable");
  });
});
