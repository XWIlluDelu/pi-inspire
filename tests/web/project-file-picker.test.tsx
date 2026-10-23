// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { type ComponentProps, useRef } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError } from "../../src/api";
import { ProjectFilePicker } from "../../src/components/ProjectFiles";

type PickerProps = Pick<
  ComponentProps<typeof ProjectFilePicker>,
  "scope" | "search" | "showHidden" | "onAdd"
>;

const file = { name: "ready.ts", path: "src/ready.ts" };
const page = { files: [file], truncated: false };

function Picker(props: PickerProps) {
  const anchorRef = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button type="button" ref={anchorRef}>
        Add project files
      </button>
      <ProjectFilePicker
        {...props}
        anchorRef={anchorRef}
        selected={[]}
        disabled={false}
        onShowHiddenChange={vi.fn()}
        onClose={vi.fn()}
      />
    </>
  );
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

it("recovers a transient search without requiring another edit or adding a file", async () => {
  const search = vi
    .fn()
    .mockRejectedValueOnce(new ApiError(503, "Search unavailable"))
    .mockResolvedValue(page);
  const onAdd = vi.fn();
  render(
    <Picker search={search} scope="one" showHidden={false} onAdd={onAdd} />,
  );
  await act(() => vi.advanceTimersByTimeAsync(200));
  expect(search).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("status")).toHaveTextContent("Searching");
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(search).toHaveBeenCalledTimes(2);
  expect(
    screen.getByRole("option", { name: "ready.ts, src/ready.ts" }),
  ).toBeEnabled();
  expect(screen.queryByText("Project file search failed")).toBeNull();
  expect(onAdd).not.toHaveBeenCalled();
});

it.each(["query", "scope", "visibility", "dismissal"] as const)(
  "retires the old retry when %s changes",
  async (change) => {
    const search = vi
      .fn()
      .mockRejectedValueOnce(new ApiError(503, "Old search unavailable"))
      .mockResolvedValue(page);
    const props = { search, scope: "one", showHidden: false, onAdd: vi.fn() };
    const view = render(<Picker {...props} />);
    await act(() => vi.advanceTimersByTimeAsync(200));
    if (change === "query")
      fireEvent.change(
        screen.getByRole("combobox", { name: "Search project files" }),
        { target: { value: "ready" } },
      );
    else if (change === "scope")
      view.rerender(<Picker {...props} scope="two" />);
    else if (change === "visibility")
      view.rerender(<Picker {...props} showHidden />);
    else view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(search).toHaveBeenCalledTimes(change === "dismissal" ? 1 : 2);
    if (change === "query") expect(search).toHaveBeenLastCalledWith("ready");
    if (change === "visibility") expect(search).toHaveBeenLastCalledWith("");
  },
);

it("stops after persistent failure and never retries permissions failures", async () => {
  const search = vi
    .fn()
    .mockRejectedValue(new ApiError(503, "Persistent search failure"));
  const props = { search, scope: "one", showHidden: false, onAdd: vi.fn() };
  const view = render(<Picker {...props} />);
  await act(() => vi.advanceTimersByTimeAsync(14_200));
  expect(search).toHaveBeenCalledTimes(4);
  expect(screen.getByRole("status")).toHaveTextContent(
    "Project file search failed",
  );
  search.mockRejectedValue(new ApiError(403, "Access denied"));
  view.rerender(<Picker {...props} scope="two" />);
  await act(() => vi.advanceTimersByTimeAsync(20_000));
  expect(search).toHaveBeenCalledTimes(5);
  expect(props.onAdd).not.toHaveBeenCalled();
});
