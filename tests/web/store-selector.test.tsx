// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { shallowEqual, store, useAppState } from "../../src/store";

afterEach(() => {
  cleanup();
  store.setResourcesOpen(false);
});

it("does not rerender selectors whose value is unchanged", () => {
  let renders = 0;

  function SessionProbe() {
    useAppState((state) => state.sessionId);
    renders += 1;
    return null;
  }

  render(<SessionProbe />);
  expect(renders).toBe(1);

  act(() => store.setResourcesOpen(true));
  expect(renders).toBe(1);
});

it("retains shallow object selections across unrelated updates", () => {
  let renders = 0;

  function SessionProbe() {
    useAppState(
      (state) => ({
        sessionId: state.sessionId,
        cwd: state.cwd,
      }),
      shallowEqual,
    );
    renders += 1;
    return null;
  }

  render(<SessionProbe />);
  expect(renders).toBe(1);

  act(() => store.setResourcesOpen(true));
  expect(renders).toBe(1);
});
