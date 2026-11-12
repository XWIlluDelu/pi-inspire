// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api";
import { ProjectFileControl } from "../../src/components/ProjectFiles";

type PickerProps = Pick<
  ComponentProps<typeof ProjectFileControl>,
  "scope" | "search" | "showHidden" | "onAdd"
>;

const file = { name: "ready.ts", path: "src/ready.ts" };
const page = { files: [file], truncated: false };

function Picker(props: PickerProps) {
  return (
    <ProjectFileControl
      {...props}
      selected={[]}
      open
      onShowHiddenChange={vi.fn()}
      onOpenChange={vi.fn()}
    />
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("recovers transient searches, reports exhausted retries, and does not retry access denials", async () => {
  const search = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(503, "Search unavailable"))
    .mockResolvedValue(page);
  const props = { search, scope: "one", showHidden: false, onAdd: vi.fn() };
  const view = render(<Picker {...props} />);
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(screen.getByRole("status")).toHaveTextContent("Searching");
  await act(() => vi.runAllTimersAsync());
  expect(
    screen.getByRole("option", { name: "ready.ts, src/ready.ts" }),
  ).toBeEnabled();

  search.mockRejectedValue(new ApiError(503, "Persistent search failure"));
  view.rerender(<Picker {...props} scope="two" />);
  await act(() => vi.runAllTimersAsync());
  expect(screen.getByRole("status")).toHaveTextContent(
    "Project file search failed",
  );

  search.mockClear().mockRejectedValue(new ApiError(403, "Access denied"));
  view.rerender(<Picker {...props} scope="three" />);
  await act(() => vi.runAllTimersAsync());
  expect(search).toHaveBeenCalledOnce();
  expect(props.onAdd).not.toHaveBeenCalled();
});

it("retires retries from superseded queries, projects, visibility, and a closed picker", async () => {
  const search = vi.fn().mockRejectedValue(new ApiError(503, "Unavailable"));
  const props = { search, scope: "one", showHidden: false, onAdd: vi.fn() };
  const view = render(<Picker {...props} />);
  await act(() => vi.advanceTimersByTimeAsync(200));

  fireEvent.change(
    screen.getByRole("combobox", { name: "Search project files" }),
    { target: { value: "ready" } },
  );
  await act(() => vi.advanceTimersByTimeAsync(200));
  view.rerender(<Picker {...props} scope="two" />);
  await act(() => vi.advanceTimersByTimeAsync(200));
  search.mockResolvedValue(page);
  view.rerender(<Picker {...props} scope="two" showHidden />);
  await act(() => vi.runAllTimersAsync());
  expect(search.mock.calls).toEqual([[""], ["ready"], ["ready"], ["ready"]]);
  expect(
    screen.getByRole("option", { name: "ready.ts, src/ready.ts" }),
  ).toBeEnabled();

  search.mockClear().mockRejectedValue(new ApiError(503, "Unavailable"));
  view.rerender(<Picker {...props} scope="three" showHidden />);
  await act(() => vi.advanceTimersByTimeAsync(200));
  view.unmount();
  await act(() => vi.runAllTimersAsync());
  expect(search).toHaveBeenCalledOnce();
});
