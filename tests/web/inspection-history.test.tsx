// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useState } from "react";
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
