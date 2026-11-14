// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { useConfigurationDocument } from "../../src/use-configuration-document";
import { deferred } from "./helpers";

type Snapshot = { revision: number };
const review = (revision: number) => ({ revision });

it("retains the edited target through conflict and refresh, then records a committed save without readback", async () => {
  const { result } = renderHook(() =>
    useConfigurationDocument<Snapshot, { value: string }>({
      owner: "current",
      active: true,
      unavailable: "Unavailable",
    }),
  );
  const get = () => result.current;
  await act(async () => {
    await get().load(async () => review(1));
  });
  act(() =>
    get().open(
      { value: "User's edit" },
      document.createElement("button"),
      true,
    ),
  );
  await act(async () => {
    await get().write(
      async () => {
        throw new Error("Configuration changed elsewhere");
      },
      { close: true },
    );
  });
  expect(get()).toMatchObject({
    snapshot: review(1),
    edit: { value: "User's edit" },
    browsing: false,
    error: "Configuration changed elsewhere",
  });
  await act(async () => {
    await get().load(async () => review(2));
  });
  expect(get()).toMatchObject({
    snapshot: review(2),
    edit: { value: "User's edit" },
  });
  await act(async () => {
    await get().write(
      async () => ({ warning: "Saved. Reload files before editing." }),
      { close: true },
    );
  });
  expect(get()).toMatchObject({
    snapshot: review(2),
    readFailed: true,
    edit: null,
    browsing: true,
    error: "Saved. Reload files before editing.",
  });
});

it("orders observations, saves once and retires late reads and writes on owner changes", async () => {
  const { result, rerender } = renderHook(
    ({ owner }) =>
      useConfigurationDocument<Snapshot, string>({
        owner,
        active: true,
        unavailable: "Unavailable",
      }),
    { initialProps: { owner: "old" } },
  );
  const get = () => result.current;
  const read = deferred<Snapshot>();
  act(() => {
    void get().load(() => read.promise);
  });
  await act(async () => {
    await get().write(async () => ({ snapshot: review(2) }));
  });
  await act(async () => read.reject(new Error("Retired read")));
  expect(get()).toMatchObject({ snapshot: review(2), error: null });

  const saved = deferred<{ snapshot: Snapshot }>();
  act(() => {
    void get().write(() => saved.promise);
  });
  const duplicate = () => {
    throw new Error("A write is already in flight");
  };
  expect(await get().write(duplicate)).toBe(false);
  expect(get().busy).toBe(true);
  rerender({ owner: "replacement" });
  await act(async () => saved.resolve({ snapshot: review(3) }));
  expect(get()).toMatchObject({ snapshot: null, busy: false, error: null });
});

it("leaves focus on the control the user moved to during an edit save", async () => {
  const { result } = renderHook(() =>
    useConfigurationDocument<Snapshot, string>({
      owner: "current",
      active: true,
      unavailable: "Unavailable",
    }),
  );
  const root = document.createElement("div");
  const buttons = [
    document.createElement("button"),
    document.createElement("button"),
  ];
  const [opener, elsewhere] = buttons;
  root.append(...buttons);
  document.body.append(root);
  result.current.root.current = root;
  try {
    opener.focus();
    act(() => result.current.open("editing", opener));
    const saved = deferred<{ snapshot: Snapshot }>();
    act(() => {
      void result.current.write(() => saved.promise, { close: true });
    });
    elsewhere.focus();
    await act(async () => saved.resolve({ snapshot: review(2) }));
    expect(result.current.edit).toBeNull();
    expect(document.activeElement).toBe(elsewhere);
  } finally {
    root.remove();
  }
});
