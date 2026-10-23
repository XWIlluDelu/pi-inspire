// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type {
  ModelOption,
  NewSessionDefaults,
  ThinkingLevel,
} from "../../shared/contracts";
import type { ModelCatalogResponse } from "../../shared/model-settings";
import { ApiError } from "../../src/api";
import { Welcome } from "../../src/components/Welcome";
import { store } from "../../src/store";
import { mockModelMenuLayout } from "./fixtures/model-menu-layout";
import {
  activeSnapshot,
  bootstrapPayload,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
} from "./helpers";

const extended: ModelOption = {
  provider: "fixture",
  id: "extended",
  reasoning: true,
  virtual: true,
  thinkingLevelMap: { xhigh: "xhigh", max: "max" },
};
const ordinary: ModelOption = {
  provider: "fixture",
  id: "ordinary",
  reasoning: true,
};
const plain: ModelOption = {
  provider: "fixture",
  id: "plain",
  reasoning: false,
};
const models = [extended, ordinary, plain];
const inherit = {
  cwd: "/one",
  model: extended,
  thinkingLevel: "max",
  commands: [],
};
let thinking: (
  query: URLSearchParams,
) => Promise<ThinkingLevel> | ThinkingLevel;
let catalog: () => Promise<ModelOption[]> | ModelOption[];
let defaults: NewSessionDefaults;
beforeEach(async () => {
  installFakeWebSocket();
  mockModelMenuLayout();
  thinking = (query) => query.get("current") as ThinkingLevel;
  catalog = () => models;
  defaults = { cwd: "/one", model: ordinary, thinkingLevel: "high" };
  installFetch(async (url) => {
    if (url.startsWith("/api/bootstrap"))
      return { body: bootstrapPayload({ availableModels: models }) };
    if (url.startsWith("/api/models"))
      return { body: { models: await catalog(), defaults } };
    if (url.startsWith("/api/new-session/thinking"))
      return {
        body: {
          level: await thinking(new URL(url, "http://fixture").searchParams),
        },
      };
    return undefined;
  });
  await store.init("fixture-token");
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function pick(id: string) {
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: new RegExp(id) }));
}

it("recovers a transient directory/model precheck without creating a session or changing input", async () => {
  vi.useFakeTimers();
  const queries = vi
    .spyOn(store, "readNewSessionModels")
    .mockRejectedValueOnce(new ApiError(503, "Directory service unavailable"))
    .mockResolvedValue({ models, defaults });
  const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
  render(
    <Welcome showRecent={false} inherited={{ ...inherit, model: null }} />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "Preserve this message" },
  });
  await act(() => vi.advanceTimersByTimeAsync(220));
  expect(queries).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(queries).toHaveBeenCalledTimes(2);
  expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue(
    "Preserve this message",
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(start).not.toHaveBeenCalled();
});

it("does not let an inherited model bypass unverified directory checks or their exhausted recovery", async () => {
  vi.useFakeTimers();
  const queries = vi
    .spyOn(store, "readNewSessionModels")
    .mockRejectedValue(new ApiError(503, "Directory service unavailable"));
  const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
  render(<Welcome showRecent={false} inherited={inherit} />);
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "Wait for the directory check" },
  });
  expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
  await act(() => vi.advanceTimersByTimeAsync(14_220));
  expect(queries).toHaveBeenCalledTimes(4);
  expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  expect(screen.getByText("Directory service unavailable")).toBeVisible();
  queries.mockResolvedValue({ models, defaults });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled();
  expect(screen.queryByText("Directory service unavailable")).toBeNull();
  queries.mockRejectedValue(
    new ApiError(503, "Replacement directory service unavailable"),
  );
  await act(() => store.init("replacement-token"));
  expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
  await act(() => vi.advanceTimersByTimeAsync(14_220));
  expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled();
  expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
  expect(start).not.toHaveBeenCalled();
});

it("does not retire an in-flight check for whitespace-only directory edits", async () => {
  vi.useFakeTimers();
  const result = deferred<ModelCatalogResponse>();
  const queries = vi
    .spyOn(store, "readNewSessionModels")
    .mockReturnValue(result.promise);
  render(<Welcome showRecent={false} inherited={inherit} />);
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "Keep validation" },
  });
  await act(() => vi.advanceTimersByTimeAsync(220));
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: " /one " },
  });
  await act(async () => result.resolve({ models, defaults }));
  expect(queries).toHaveBeenCalledTimes(1);
  expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled();
});

it("retains confirmed readiness and choices when an optional catalog refresh stays unavailable", async () => {
  vi.useFakeTimers();
  const queries = vi
    .spyOn(store, "readNewSessionModels")
    .mockResolvedValue({ models, defaults });
  render(
    <Welcome showRecent={false} inherited={{ ...inherit, model: null }} />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "Keep the resolved default" },
  });
  await act(() => vi.advanceTimersByTimeAsync(220));
  expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled();
  queries.mockRejectedValue(new ApiError(503, "Directory service unavailable"));
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  await act(() => vi.advanceTimersByTimeAsync(0));
  expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled();
  await act(() => vi.advanceTimersByTimeAsync(14_000));
  expect(queries).toHaveBeenCalledTimes(5);
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
    "ordinary",
  );
  expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue(
    "Keep the resolved default",
  );
  await act(() => vi.advanceTimersByTimeAsync(30_000));
  expect(queries).toHaveBeenCalledTimes(5);
});

it.each(["directory", "transport", "unmount"] as const)(
  "retires a queued directory/model retry on %s change",
  async (change) => {
    vi.useFakeTimers();
    const queries = vi
      .spyOn(store, "readNewSessionModels")
      .mockRejectedValueOnce(new ApiError(503, "Old scope unavailable"))
      .mockResolvedValue({ models, defaults });
    const view = render(
      <Welcome showRecent={false} inherited={{ ...inherit, model: null }} />,
    );
    await act(() => vi.advanceTimersByTimeAsync(220));
    expect(queries).toHaveBeenCalledTimes(1);
    if (change === "directory") {
      fireEvent.change(
        screen.getByRole("textbox", { name: "Project directory" }),
        {
          target: { value: "/two" },
        },
      );
    } else if (change === "transport") {
      await act(() => store.init("replacement-token"));
    } else {
      view.unmount();
    }
    await act(() => vi.advanceTimersByTimeAsync(2_000));
    expect(queries).toHaveBeenCalledTimes(change === "unmount" ? 1 : 2);
    if (change === "directory")
      expect(queries).toHaveBeenLastCalledWith(undefined, "/two");
  },
);

it.each([false, true])(
  "recovers explicit-model effort preview unless manual effort supersedes it (manual=%s)",
  async (manual) => {
    vi.useFakeTimers();
    const policy = vi
      .spyOn(store, "resolveNewSessionThinking")
      .mockRejectedValueOnce(new ApiError(503, "Thinking preview unavailable"))
      .mockResolvedValue("medium");
    render(<Welcome showRecent={false} inherited={inherit} />);
    fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
      target: { value: "Use the selected effort" },
    });
    await act(() => vi.advanceTimersByTimeAsync(220));
    pick("ordinary");
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(policy).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: "Start session" }),
    ).toBeDisabled();
    if (manual) {
      fireEvent.click(screen.getByRole("combobox", { name: "Thinking level" }));
      fireEvent.click(screen.getByRole("option", { name: /^Low$/ }));
    }
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(policy).toHaveBeenCalledTimes(manual ? 1 : 2);
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toHaveTextContent(manual ? "Low" : "Medium");
    expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  },
);

it("inherits the selected router and its effective effort without reapplying workspace/model policy", async () => {
  const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
  const policy = vi.fn(() => "xhigh" as ThinkingLevel);
  thinking = policy;
  render(<Welcome showRecent={false} inherited={inherit} />);
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(
    screen.getByRole("option", { name: /extended.*Router/ }),
  ).toBeVisible();
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search models" }), {
    key: "Escape",
  });
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "continue selected router" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith("/one", {
      model: { provider: "fixture", id: "extended" },
      thinkingLevel: "max",
    }),
  );
  expect(policy).not.toHaveBeenCalled();
});
it("waits for a pending source selection instead of applying workspace defaults", async () => {
  const source =
    deferred<import("../../shared/model-settings").ModelCatalogResponse>();
  const queries = vi
    .spyOn(store, "readNewSessionModels")
    .mockImplementation(async (_sessionId, _cwd, inherit) =>
      inherit ? source.promise : { models, defaults },
    );
  const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
  render(
    <Welcome
      showRecent={false}
      inherited={{
        ...inherit,
        sessionId: "source",
        model: null,
        modelDiscovery: "loading",
      }}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "inherit pending router" },
  });
  await waitFor(() =>
    expect(queries).toHaveBeenCalledWith("source", "/one", true),
  );
  await waitFor(() => expect(queries).toHaveBeenCalledWith("source", "/one"));
  expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
    "Resolving model",
  );
  await act(async () =>
    source.resolve({
      models,
      selection: {
        cwd: "/one",
        model: extended,
        thinkingLevel: "max",
      },
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "extended",
    ),
  );
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith("/one", {
      model: { provider: "fixture", id: "extended" },
      thinkingLevel: "max",
    }),
  );
});

it("recovers inherited selection before allowing missing-folder creation", async () => {
  let source = deferred<ModelCatalogResponse>();
  const queries = vi
    .spyOn(store, "readNewSessionModels")
    .mockImplementation(async (_sessionId, cwd, inherit) => {
      if (inherit) return source.promise;
      if (cwd === "/missing")
        throw new ApiError(
          400,
          "Project path does not exist",
          undefined,
          "PROJECT_DIRECTORY_MISSING",
        );
      return { models, defaults };
    });
  const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
  render(
    <Welcome
      showRecent={false}
      inherited={{
        ...inherit,
        sessionId: "source",
        model: null,
        modelDiscovery: "loading",
      }}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "Keep inherited choices" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/missing" },
  });
  const create = await screen.findByRole("button", {
    name: "Create folder and start",
  });
  expect(create).toBeDisabled();
  expect(screen.getByText("Resolving model…")).toBeInTheDocument();
  vi.useFakeTimers();
  await act(async () =>
    source.reject(new ApiError(503, "The source model is unavailable")),
  );
  expect(screen.queryByText("The source model is unavailable")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(create).toBeDisabled();
  source = deferred<ModelCatalogResponse>();
  await act(() => vi.advanceTimersByTimeAsync(1_000));
  expect(queries.mock.calls.filter(([, , inherit]) => inherit)).toHaveLength(2);
  expect(screen.getByText("Resolving model…")).toBeInTheDocument();
  expect(create).toBeDisabled();
  await act(async () =>
    source.resolve({
      models,
      selection: { cwd: "/one", model: extended, thinkingLevel: "max" },
    }),
  );
  expect(create).toBeEnabled();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  await act(async () => fireEvent.click(create));
  expect(start).toHaveBeenCalledWith("/missing", {
    createDirectory: true,
    model: { provider: "fixture", id: "extended" },
    thinkingLevel: "max",
  });
});

it("refreshes the displayed workspace default but omits preview overrides at startup", async () => {
  const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
  render(<Welcome showRecent={false} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/one" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "ordinary",
    ),
  );
  defaults = { cwd: "/one", model: extended, thinkingLevel: "max" };
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "extended",
    ),
  );
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search models" }), {
    key: "Escape",
  });
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "use native default" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() => expect(start).toHaveBeenCalledWith("/one", {}));
});
it("keeps a newer catalog refresh when an older default preview arrives late", async () => {
  const pending =
    deferred<import("../../shared/model-settings").ModelCatalogResponse>();
  const queries = vi
    .spyOn(store, "readNewSessionModels")
    .mockReturnValueOnce(pending.promise);
  render(<Welcome showRecent={false} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/one" },
  });
  await waitFor(() => expect(queries).toHaveBeenCalledTimes(1));
  defaults = { cwd: "/one", model: extended, thinkingLevel: "max" };
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "extended",
    ),
  );
  await act(async () =>
    pending.resolve({
      models,
      defaults: { cwd: "/one", model: ordinary, thinkingLevel: "high" },
    }),
  );
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
    "extended",
  );
  expect(
    screen.getByRole("combobox", { name: "Thinking level" }),
  ).toHaveTextContent("Max");
});
it("keeps a manual default effort across workspace changes and submits only that effort override", async () => {
  const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
  render(<Welcome showRecent={false} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/one" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "ordinary",
    ),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Thinking level" }));
  fireEvent.click(screen.getByRole("option", { name: /^Low$/ }));
  defaults = { cwd: "/two", model: ordinary, thinkingLevel: "medium" };
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/two" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "ordinary",
    ),
  );
  expect(
    screen.getByRole("combobox", { name: "Thinking level" }),
  ).toHaveTextContent("Low");
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "intentional effort" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith("/two", { thinkingLevel: "low" }),
  );
});
it("treats choosing the displayed default as an explicit selection without resetting its effort", async () => {
  const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
  render(<Welcome showRecent={false} />);
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/one" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "ordinary",
    ),
  );
  pick("ordinary");
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "explicit model" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith("/one", {
      model: { provider: "fixture", id: "ordinary" },
      thinkingLevel: "high",
    }),
  );
});
it.each(["xhigh", "max"])(
  "clamps inherited %s to high rather than off on an ordinary model",
  async (level) => {
    render(
      <Welcome
        showRecent={false}
        inherited={{ ...inherit, thinkingLevel: level }}
      />,
    );
    pick("ordinary");
    await waitFor(() =>
      expect(
        screen.getByRole("combobox", { name: "Thinking level" }),
      ).toHaveTextContent("High"),
    );
  },
);
it("settles model readiness when manual effort supersedes policy, including across directory changes", async () => {
  const pending = deferred<ThinkingLevel>();
  const policy = vi.fn(() => pending.promise);
  thinking = policy;
  const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
  render(<Welcome showRecent={false} inherited={inherit} />);
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "Use manual effort" },
  });
  pick("ordinary");
  await waitFor(() => expect(policy).toHaveBeenCalledTimes(1));
  expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
  fireEvent.click(screen.getByRole("combobox", { name: "Thinking level" }));
  fireEvent.click(screen.getByRole("option", { name: /^Low$/ }));
  expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/two" },
  });
  await act(async () => pending.resolve("medium"));
  expect(policy).toHaveBeenCalledTimes(1);
  expect(
    screen.getByRole("combobox", { name: "Thinking level" }),
  ).toHaveTextContent("Low");
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith("/two", {
      model: { provider: "fixture", id: "ordinary" },
      thinkingLevel: "low",
    }),
  );
});
it("ignores an old model response after another model is chosen", async () => {
  const pending = deferred<ThinkingLevel>();
  thinking = (query) =>
    query.get("modelId") === "ordinary" ? pending.promise : "off";
  render(<Welcome showRecent={false} inherited={inherit} />);
  pick("ordinary");
  pick("plain");
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toBeDisabled(),
  );
  await act(async () => pending.resolve("medium"));
  expect(
    screen.getByRole("combobox", { name: "Thinking level" }),
  ).toHaveTextContent("Unavailable");
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
    "plain",
  );
});
it("ignores an old workspace response and uses the new workspace's configured level", async () => {
  const pending = deferred<ThinkingLevel>();
  const calls: string[] = [];
  thinking = (query) => {
    calls.push(`${query.get("cwd")}/${query.get("modelId")}`);
    return query.get("cwd") === "/one" ? pending.promise : "minimal";
  };
  render(<Welcome showRecent={false} inherited={inherit} />);
  pick("ordinary");
  await waitFor(() => expect(calls).toContain("/one/ordinary"));
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/two" },
  });
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toHaveTextContent("Minimal"),
  );
  await act(async () => pending.resolve("high"));
  expect(
    screen.getByRole("combobox", { name: "Thinking level" }),
  ).toHaveTextContent("Minimal");
});
it("keeps a same-cwd catalog read alive across same-model snapshot objects and effort input", async () => {
  vi.useFakeTimers();
  const pending = deferred<ModelOption[]>();
  catalog = () => pending.promise;
  const refresh = vi.spyOn(store, "readNewSessionModels");
  const emit = () =>
    FakeWebSocket.instances.at(-1)!.emit({
      type: "snapshot",
      data: activeSnapshot({
        sessionId: "current",
        cwd: "/one",
        model: { ...extended },
        thinkingLevel: "max",
        availableModels: models,
      }),
    });
  act(emit);
  render(<Welcome showRecent={false} />);
  await act(() => vi.advanceTimersByTimeAsync(220));
  expect(refresh).toHaveBeenCalledExactlyOnceWith("current", "/one");
  fireEvent.click(screen.getByRole("combobox", { name: "Thinking level" }));
  fireEvent.click(screen.getByRole("option", { name: /^Xhigh$/ }));
  for (let i = 0; i < 3; i++) {
    act(emit);
    await act(() => vi.advanceTimersByTimeAsync(90));
  }
  await act(() => vi.advanceTimersByTimeAsync(240));
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () =>
    pending.resolve([...models, { provider: "fixture", id: "fresh" }]),
  );
  expect(
    screen.getByRole("combobox", { name: "Thinking level" }),
  ).toHaveTextContent("Xhigh");
  const next = deferred<ModelOption[]>();
  catalog = () => next.promise;
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("option", { name: /^fresh/ })).toBeVisible();
  await act(async () => next.resolve(models));
});
it("waits for directory typing to settle before refreshing prospective models", async () => {
  vi.useFakeTimers();
  const refresh = vi.spyOn(store, "readNewSessionModels");
  render(<Welcome showRecent={false} inherited={inherit} />);
  for (const value of ["/w", "/wo", "/work"]) {
    fireEvent.change(
      screen.getByRole("textbox", { name: "Project directory" }),
      {
        target: { value },
      },
    );
    await act(() => vi.advanceTimersByTimeAsync(60));
  }
  expect(refresh).not.toHaveBeenCalled();
  await act(() => vi.advanceTimersByTimeAsync(220));
  expect(refresh).toHaveBeenCalledExactlyOnceWith(undefined, "/work");
});
it("refreshes prospective choices without replacing an explicitly chosen model or thinking level", async () => {
  render(<Welcome showRecent={false} inherited={inherit} />);
  pick("ordinary");
  await waitFor(() =>
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toHaveTextContent("High"),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Thinking level" }));
  fireEvent.click(screen.getByRole("option", { name: /^Low$/ }));
  catalog = () => [{ provider: "fixture", id: "fresh", reasoning: true }];
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  await screen.findByRole("option", { name: /^fresh/ });
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
    "ordinary",
  );
  expect(
    screen.getByRole("combobox", { name: "Thinking level" }),
  ).toHaveTextContent("Low");
});
