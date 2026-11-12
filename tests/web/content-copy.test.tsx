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
import { Transcript } from "../../src/components/Transcript";
import * as clipboard from "../../src/content-copy";
import { copyLoader } from "../../src/content-copy";
import { messageCopyContent } from "../../src/message-copy";
import { store } from "../../src/store";
import { deferred } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function captureClipboardSource() {
  const written = vi.fn();
  const request = vi
    .spyOn(clipboard, "writeCopyContent")
    .mockImplementation(
      async (
        source,
        current = () => true,
        signal = new AbortController().signal,
      ) => {
        const content =
          typeof source === "function" ? await source(signal) : source;
        if (content === null || signal.aborted || !current()) return false;
        written(content);
        return true;
      },
    );
  return { request, written };
}

describe("owned content copying", () => {
  it("retires a late path-copy failure when its view changes but the path stays the same", async () => {
    const write = deferred<void>();
    let current = true;
    vi.spyOn(store, "copyOwnership").mockImplementation(() => () => current);
    const report = vi
      .spyOn(store, "reportCopyError")
      .mockImplementation(() => {});
    const writeText = vi
      .fn()
      .mockImplementationOnce(() => write.promise)
      .mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    render(<PathCopyButton path="/workspace/result.md" />);
    const button = screen.getByRole("button", {
      name: "Copy path /workspace/result.md",
    });
    fireEvent.click(button);
    current = false;
    await act(async () => write.reject(new Error("Retired path copy failed")));
    expect(button).toHaveAccessibleName("Copy path /workspace/result.md");
    expect(report).not.toHaveBeenCalled();

    current = true;
    fireEvent.click(button);
    await screen.findByRole("button", { name: "Path copied" });
    expect(writeText).toHaveBeenLastCalledWith("/workspace/result.md");
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

  it("does not transfer a late clipboard success to replacement content", async () => {
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
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("first report"));
    rerender(
      <CopyAction
        label="report"
        className="copy"
        text="second report"
        onError={onError}
      />,
    );
    expect(screen.getByRole("button", { name: "Copy report" })).toBeEnabled();
    await act(async () => write.resolve());
    expect(screen.queryByRole("button", { name: "report copied" })).toBeNull();
    expect(onError).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Copy report" }));
    await screen.findByRole("button", { name: "report copied" });
    expect(writeText).toHaveBeenLastCalledWith("second report");
  });

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
    const read = vi.spyOn(store, "loadTranscriptImage").mockResolvedValue(png);
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

  it("copies expanded activity and keeps a tool path separate from its disclosure", async () => {
    const { written } = captureClipboardSource();
    const openResource = vi.spyOn(store, "openResource").mockResolvedValue();
    const path = "src/a.ts";
    const custom = {
      type: "custom",
      extensionName: "Web search",
      payload: { count: 2 },
    };
    render(
      <Transcript
        messages={[
          {
            role: "assistant",
            timestamp: 1,
            content: [
              { type: "thinking", thinking: "private reasoning" },
              {
                type: "toolCall",
                id: "copy-tool",
                name: "read",
                arguments: { path },
              },
              custom,
            ],
          },
          {
            role: "toolResult",
            toolCallId: "copy-tool",
            content: "file body",
            timestamp: 2,
          },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    for (const [label, copy, text] of [
      ["Thinking", "Copy thinking block", "private reasoning"],
      [
        "read tool",
        "Copy read tool block",
        [
          "read",
          "Arguments",
          JSON.stringify({ path }, null, 2),
          "Result",
          "file body",
        ].join("\n\n"),
      ],
      ["Web search", "Copy web search block", JSON.stringify(custom, null, 2)],
    ]) {
      expect(screen.queryByRole("button", { name: copy })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: `Expand ${label}` }));
      fireEvent.click(screen.getByRole("button", { name: copy }));
      await waitFor(() => {
        const copied = written.mock.lastCall?.[0];
        expect(typeof copied === "string" ? copied : copied?.text).toBe(text);
      });
    }

    fireEvent.click(screen.getByRole("button", { name: "Collapse read tool" }));
    const disclosure = screen.getByRole("button", { name: "Expand read tool" });
    fireEvent.click(screen.getByRole("button", { name: path }));
    await waitFor(() => expect(openResource).toHaveBeenCalledOnce());
    expect(disclosure).toHaveAttribute("aria-expanded", "false");

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(openResource).toHaveBeenCalledOnce();
  });
});
