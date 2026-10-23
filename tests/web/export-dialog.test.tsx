// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { type Api } from "../../src/api";
import { ExportDialog } from "../../src/components/ExportDialog";
import { store } from "../../src/store";
import { deferred } from "./helpers";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("lets an export continue after every close gesture, and reopening observes the same download", async () => {
  const completion = deferred<{ downloadId: string; fileName: string }>();
  const api = {
    exportSession: vi.fn(() => completion.promise),
    exportDownload: vi.fn(async () => new Blob(["saved history"])),
  };
  const internal = store as unknown as { api: Api | null };
  const previousApi = internal.api;
  internal.api = api as unknown as Api;
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:export");
      static revokeObjectURL = vi.fn();
    },
  );
  const downloads: string[] = [];
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    downloads.push(this.download);
  });
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Open export</button>
        <button>Other work</button>
        {open ? (
          <ExportDialog sessionId="s1" active onClose={() => setOpen(false)} />
        ) : null}
      </>
    );
  }
  const view = render(<Harness />);
  let pending: Promise<void> | undefined;
  try {
    for (const gesture of ["escape", "footer", "header", "overlay"]) {
      const open = screen.getByRole("button", { name: "Open export" });
      open.focus();
      fireEvent.click(open);
      if (gesture === "escape") {
        fireEvent.click(
          screen.getByRole("radio", { name: "JSONL Current branch" }),
        );
        fireEvent.click(screen.getByRole("button", { name: "Download" }));
        pending = store.exportSession("s1", "jsonl");
      }
      expect(
        screen.getByRole("radio", { name: "JSONL Current branch" }),
      ).toBeChecked();
      expect(screen.getByRole("button", { name: "Exporting…" })).toBeDisabled();
      expect(screen.getByRole("status")).toHaveTextContent(
        "You can close this dialog",
      );
      if (gesture === "escape") fireEvent.keyDown(document, { key: "Escape" });
      else if (gesture === "overlay")
        fireEvent.click(view.container.querySelector(".overlay")!);
      else
        fireEvent.click(
          screen.getByRole("button", {
            name: gesture === "footer" ? "Close" : "Close export",
          }),
        );
      expect(screen.queryByRole("dialog")).toBeNull();
      await waitFor(() => expect(open).toHaveFocus());
      screen.getByRole("button", { name: "Other work" }).focus();
      expect(screen.getByRole("button", { name: "Other work" })).toHaveFocus();
    }
    await act(async () => {
      completion.resolve({
        downloadId: "saved-export",
        fileName: "history.jsonl",
      });
      await pending;
    });
    expect(api.exportSession).toHaveBeenCalledExactlyOnceWith({
      sessionId: "s1",
      format: "jsonl",
    });
    expect(api.exportDownload).toHaveBeenCalledExactlyOnceWith(
      "s1",
      "saved-export",
    );
    expect(downloads).toEqual(["history.jsonl"]);
    expect(store.getState().exportingSessions).toEqual({});
    expect(store.getState().notices.at(-1)?.text).toBe(
      "Downloaded history.jsonl",
    );
  } finally {
    completion.resolve({
      downloadId: "saved-export",
      fileName: "history.jsonl",
    });
    await pending;
    internal.api = previousApi;
  }
});

it("keeps saved JSONL available for read-only history without offering HTML", async () => {
  const exportSession = vi.spyOn(store, "exportSession").mockResolvedValue();
  render(
    <ExportDialog sessionId="read-only" readOnly active onClose={() => {}} />,
  );
  expect(
    screen.getByRole("radio", { name: "HTML Whole session" }),
  ).toBeDisabled();
  expect(
    screen.getByRole("radio", { name: "JSONL Saved branch" }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() =>
    expect(exportSession).toHaveBeenCalledWith("read-only", "jsonl"),
  );
});

it("retains the selected format on failure and downloads for the captured session on retry", async () => {
  const exportSession = vi
    .spyOn(store, "exportSession")
    .mockRejectedValueOnce(new Error("Unable to read this session"))
    .mockResolvedValueOnce();
  const onClose = vi.fn();
  const view = render(<ExportDialog sessionId="s1" active onClose={onClose} />);
  for (const input of screen.getAllByRole("radio"))
    expect(input).toHaveClass("choice-input");
  expect(
    screen.getByRole("radio", { name: "HTML Whole session" }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("radio", { name: "JSONL Current branch" }));
  view.rerender(
    <ExportDialog sessionId="s1" active={false} onClose={onClose} />,
  );
  expect(screen.queryByRole("dialog")).toBeNull();
  view.rerender(<ExportDialog sessionId="s1" active onClose={onClose} />);
  expect(
    screen.getByRole("radio", { name: "JSONL Current branch" }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Unable to read this session",
  );
  expect(onClose).not.toHaveBeenCalled();
  expect(
    screen.getByRole("radio", { name: "JSONL Current branch" }),
  ).toBeChecked();
  fireEvent.click(screen.getByRole("button", { name: "Download" }));
  await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
  expect(exportSession.mock.calls).toEqual([
    ["s1", "jsonl"],
    ["s1", "jsonl"],
  ]);
});
