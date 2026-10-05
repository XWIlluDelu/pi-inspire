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
  ).toHaveTextContent("max");
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
  fireEvent.click(screen.getByRole("option", { name: /^low$/ }));
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
  ).toHaveTextContent("low");
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
      ).toHaveTextContent("high"),
    );
  },
);
it("applies model policy but preserves intentional effort entered after its request", async () => {
  const pending = deferred<ThinkingLevel>();
  thinking = () => pending.promise;
  render(<Welcome showRecent={false} inherited={inherit} />);
  pick("ordinary");
  fireEvent.click(screen.getByRole("combobox", { name: "Thinking level" }));
  fireEvent.click(screen.getByRole("option", { name: /^low$/ }));
  await act(async () => pending.resolve("medium"));
  expect(
    screen.getByRole("combobox", { name: "Thinking level" }),
  ).toHaveTextContent("low");
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
  ).toHaveTextContent("unavailable");
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
    ).toHaveTextContent("minimal"),
  );
  await act(async () => pending.resolve("high"));
  expect(
    screen.getByRole("combobox", { name: "Thinking level" }),
  ).toHaveTextContent("minimal");
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
  fireEvent.click(screen.getByRole("option", { name: /^xhigh$/ }));
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
  ).toHaveTextContent("xhigh");
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
    ).toHaveTextContent("high"),
  );
  fireEvent.click(screen.getByRole("combobox", { name: "Thinking level" }));
  fireEvent.click(screen.getByRole("option", { name: /^low$/ }));
  catalog = () => [{ provider: "fixture", id: "fresh", reasoning: true }];
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  await screen.findByRole("option", { name: /^fresh/ });
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
    "ordinary",
  );
  expect(
    screen.getByRole("combobox", { name: "Thinking level" }),
  ).toHaveTextContent("low");
});
