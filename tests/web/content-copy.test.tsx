// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CopyAction } from "../../src/components/CopyAction";
import { PathCopyButton } from "../../src/components/FilePreview";
import { RichText } from "../../src/components/RichText";
import { copyLoader } from "../../src/content-copy";
import { messageCopyContent } from "../../src/message-copy";
import { store } from "../../src/store";
import { deferred } from "./helpers";

afterEach(() => vi.restoreAllMocks());

describe("owned content copying", () => {
  it("keeps path confirmation with the copied path without replacing the focused control", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const { rerender } = render(<PathCopyButton path="/workspace/first.md" />);
    const button = screen.getByRole("button", {
      name: "Copy path /workspace/first.md",
    });
    act(() => button.focus());
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Path copied" });
    rerender(<PathCopyButton path="/workspace/second.md" />);
    expect(button).toHaveFocus();
    expect(button).toHaveAccessibleName("Copy path /workspace/second.md");
    expect(button.querySelector("svg")).toBeNull();
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Path copied" });
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      "/workspace/second.md",
    );
    rerender(<PathCopyButton path="/workspace/first.md" />);
    expect(button).toHaveAccessibleName("Copy path /workspace/first.md");
  });

  it("retires a copied code block's confirmation as its content grows", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
    const { rerender } = render(
      <RichText
        text={"\x60\x60\x60js\nfirst();\n\x60\x60\x60"}
        variant="assistant"
      />,
    );
    const button = screen.getByRole("button", { name: "Copy code" });
    act(() => button.focus());
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Copied" });
    rerender(
      <RichText
        text={"\x60\x60\x60js\nfirst();\nsecond();\n\x60\x60\x60"}
        variant="assistant"
      />,
    );
    expect(button).toHaveFocus();
    expect(button).toHaveAccessibleName("Copy code");
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Copied" });
    expect(navigator.clipboard.writeText).toHaveBeenLastCalledWith(
      "first();\nsecond();",
    );
  });

  it.each(["path", "code"] as const)(
    "reports a current %s copy failure through shared feedback",
    async (kind) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: vi
            .fn()
            .mockRejectedValue(new Error("Clipboard permission denied")),
        },
      });
      const report = vi
        .spyOn(store, "reportCopyError")
        .mockImplementation(() => {});
      render(
        kind === "path" ? (
          <PathCopyButton path="/workspace/result.md" />
        ) : (
          <RichText
            text={"\x60\x60\x60js\nfirst();\n\x60\x60\x60"}
            variant="assistant"
          />
        ),
      );
      fireEvent.click(
        screen.getByRole("button", {
          name:
            kind === "path" ? "Copy path /workspace/result.md" : "Copy code",
        }),
      );
      await waitFor(() =>
        expect(report).toHaveBeenCalledWith("Clipboard permission denied"),
      );
      expect(
        screen.queryByRole("button", { name: /^(Path copied|Copied)$/ }),
      ).toBeNull();
    },
  );

  it.each(["resolve", "reject"] as const)(
    "does not transfer a late clipboard %s to replacement content",
    async (outcome) => {
      const write = deferred<void>();
      const onError = vi.fn();
      const writeText = vi
        .fn()
        .mockImplementationOnce(() => write.promise)
        .mockResolvedValue(undefined);
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText },
      });
      const { rerender } = render(
        <CopyAction
          label="report"
          className="copy"
          text="first report"
          onError={onError}
        />,
      );
      fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith("first report"),
      );
      rerender(
        <CopyAction
          label="report"
          className="copy"
          text="second report"
          onError={onError}
        />,
      );
      expect(screen.getByRole("button", { name: "Copy report" })).toBeEnabled();
      await act(async () => {
        if (outcome === "resolve") write.resolve();
        else write.reject(new Error("Retired clipboard failure"));
        await write.promise.catch(() => {});
      });
      expect(
        screen.queryByRole("button", { name: "report copied" }),
      ).toBeNull();
      expect(onError).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
      await screen.findByRole("button", { name: "report copied" });
      expect(writeText).toHaveBeenLastCalledWith("second report");
    },
  );

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
        getContent={copyLoader((owner) => {
          signal = owner;
          return read.promise;
        })}
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
        getContent={copyLoader(() => read.promise)}
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
