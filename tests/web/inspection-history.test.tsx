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
import { useInspectionHistory } from "../../src/use-inspection-history";

afterEach(cleanup);
function Inspection() {
  const [depth, setDepth] = useState(0);
  useInspectionHistory(depth, setDepth, "__testInspection");
  return (
    <>
      <button onClick={() => setDepth(1)}>Panel</button>
      <button onClick={() => setDepth(2)}>File</button>
      <button onClick={() => setDepth(0)}>Close</button>
      <output aria-label="Depth">{depth}</output>
    </>
  );
}

function NestedInspections({
  backgroundDepth,
  onBackgroundBack,
}: {
  backgroundDepth: number;
  onBackgroundBack: (depth: number) => void;
}) {
  const [open, setOpen] = useState(false);
  useInspectionHistory(backgroundDepth, onBackgroundBack, "__testBackground", {
    background: true,
  });
  useInspectionHistory(open ? 1 : 0, () => setOpen(false), "__testForeground");
  return (
    <>
      <button onClick={() => setOpen(true)}>Open image</button>
      <button onClick={() => setOpen(false)}>Close image</button>
      <output aria-label="Image">{open ? "Open" : "Closed"}</output>
    </>
  );
}

for (const [initial, next] of [
  [2, 0],
  [0, 1],
]) {
  it.each(["Close", "Back"])(
    `defers responsive parent depth ${initial} → ${next} until the foreground ends via %s`,
    async (method) => {
      history.replaceState({ baseline: true }, "");
      const back = vi.fn();
      const view = render(
        <NestedInspections backgroundDepth={initial} onBackgroundBack={back} />,
      );
      fireEvent.click(screen.getByText("Open image"));
      const foreground = history.state;
      const go = vi.spyOn(history, "go");
      try {
        view.rerender(
          <NestedInspections backgroundDepth={next} onBackgroundBack={back} />,
        );
        expect(go).not.toHaveBeenCalled();
        expect(history.state).toEqual(foreground);
        expect(screen.getByLabelText("Image")).toHaveTextContent("Open");
        if (method === "Close")
          fireEvent.click(screen.getByText("Close image"));
        else act(() => history.back());
        await waitFor(() =>
          expect(history.state?.__testBackground?.depth ?? 0).toBe(next),
        );
        expect(screen.getByLabelText("Image")).toHaveTextContent("Closed");
        expect(back).not.toHaveBeenCalled();
        view.rerender(
          <NestedInspections backgroundDepth={0} onBackgroundBack={back} />,
        );
        await waitFor(() => expect(history.state).toEqual({ baseline: true }));
      } finally {
        go.mockRestore();
      }
    },
  );
}

it("does not let a retired foreground marker block a responsive parent", async () => {
  history.replaceState({ baseline: true }, "");
  const back = vi.fn();
  const view = render(
    <NestedInspections backgroundDepth={0} onBackgroundBack={back} />,
  );
  fireEvent.click(screen.getByText("Open image"));
  const retired = structuredClone(history.state);
  fireEvent.click(screen.getByText("Close image"));
  await waitFor(() => expect(history.state).toEqual({ baseline: true }));
  // Forward or reload can expose an entry without its former live inspection.
  history.replaceState(retired, "");
  view.rerender(
    <NestedInspections backgroundDepth={1} onBackgroundBack={back} />,
  );
  expect(history.state.__testBackground.depth).toBe(1);
  expect(screen.getByLabelText("Image")).toHaveTextContent("Closed");
  view.rerender(
    <NestedInspections backgroundDepth={0} onBackgroundBack={back} />,
  );
  await waitFor(() => expect(history.state).toEqual(retired));
  history.replaceState({ baseline: true }, "");
});

it("backs out of a file, then its panel, before leaving the application", async () => {
  history.replaceState({ baseline: true }, "");
  render(<Inspection />);
  fireEvent.click(screen.getByText("File"));
  expect(history.state.__testInspection.depth).toBe(2);
  act(() => history.back());
  await waitFor(() =>
    expect(screen.getByLabelText("Depth")).toHaveTextContent("1"),
  );
  act(() => history.back());
  await waitFor(() =>
    expect(screen.getByLabelText("Depth")).toHaveTextContent("0"),
  );
  expect(history.state).toEqual({ baseline: true });
});

it("explicit close consumes all inspection entries without an empty Back stop", async () => {
  history.replaceState({ baseline: true }, "");
  render(<Inspection />);
  fireEvent.click(screen.getByText("Panel"));
  fireEvent.click(screen.getByText("File"));
  fireEvent.click(screen.getByText("Close"));
  await waitFor(() => expect(history.state).toEqual({ baseline: true }));
  expect(screen.getByLabelText("Depth")).toHaveTextContent("0");
});

it("keeps a reopened panel when the previous explicit close finishes traversing history", async () => {
  history.replaceState({ baseline: true }, "");
  render(<Inspection />);
  fireEvent.click(screen.getByText("Panel"));
  // Hold the browser's asynchronous traversal so reopening always precedes
  // its popstate acknowledgment, independently of event-loop scheduling.
  const go = vi.spyOn(history, "go").mockImplementation(() => {});
  try {
    fireEvent.click(screen.getByText("Close"));
    expect(go).toHaveBeenCalledExactlyOnceWith(-1);
    fireEvent.click(screen.getByText("Panel"));
    act(() => {
      history.replaceState({ baseline: true }, "");
      window.dispatchEvent(
        new PopStateEvent("popstate", { state: history.state }),
      );
    });
    expect(screen.getByLabelText("Depth")).toHaveTextContent("1");
    expect(history.state.__testInspection.depth).toBe(1);
  } finally {
    go.mockRestore();
  }
  act(() => history.back());
  await waitFor(() =>
    expect(screen.getByLabelText("Depth")).toHaveTextContent("0"),
  );
  expect(history.state).toEqual({ baseline: true });
});
