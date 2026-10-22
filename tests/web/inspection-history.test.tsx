// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
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
