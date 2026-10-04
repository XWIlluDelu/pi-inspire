// @vitest-environment jsdom
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ExportDialog } from "../../src/components/ExportDialog";
import { store } from "../../src/store";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it("retains the selected format on failure and downloads for the captured session on retry", async () => {
  const exportSession = vi
    .spyOn(store, "exportSession")
    .mockRejectedValueOnce(new Error("Unable to read this session"))
    .mockResolvedValueOnce();
  const onClose = vi.fn();
  const view = render(<ExportDialog sessionId="s1" active onClose={onClose} />);
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
