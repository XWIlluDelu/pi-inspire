// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelOption, NewSessionDefaults } from "../../shared/contracts";
import type { ModelCatalogResponse } from "../../shared/model-settings";
import { ApiError } from "../../src/api";
import { Welcome } from "../../src/components/Welcome";
import { store } from "../../src/store";
import { mockModelMenuLayout } from "./fixtures/model-menu-layout";
import {
  bootstrapPayload,
  deferred,
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
let thinkingPreferences: ModelCatalogResponse["thinkingPreferences"];
let catalog: () => Promise<ModelOption[]> | ModelOption[];
let defaults: NewSessionDefaults;
beforeEach(async () => {
  installFakeWebSocket();
  mockModelMenuLayout();
  thinkingPreferences = undefined;
  catalog = () => models;
  defaults = { cwd: "/one", model: ordinary, thinkingLevel: "high" };
  installFetch(async (url) => {
    if (url.startsWith("/api/bootstrap"))
      return { body: bootstrapPayload({ availableModels: models }) };
    if (url.startsWith("/api/models"))
      return {
        body: { models: await catalog(), defaults, thinkingPreferences },
      };
    return undefined;
  });
  await store.init();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
function pick(id: string) {
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  fireEvent.click(screen.getByRole("option", { name: new RegExp(id) }));
}

it("blocks an inherited model until the connected Host has verified the directory", async () => {
  vi.useFakeTimers();
  const catalog = vi
    .spyOn(store, "readNewSessionModels")
    .mockRejectedValueOnce(new ApiError(503, "Old scope unavailable"))
    .mockResolvedValue({ models, defaults });
  render(<Welcome showRecent={false} inherited={inherit} />);
  const message = screen.getByRole("textbox", { name: "First message" });
  fireEvent.change(message, {
    target: { value: "Wait for the directory check" },
  });
  const start = screen.getByRole("button", { name: "Start session" });
  expect(start).toBeDisabled();
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(catalog).toHaveBeenCalledTimes(1);
  expect(start).toBeDisabled();
  await act(() => store.init());
  await act(() => vi.advanceTimersByTimeAsync(2_000));
  expect(catalog).toHaveBeenCalledTimes(2);
  expect(start).toBeEnabled();

  catalog.mockRejectedValue(new ApiError(503, "Directory service unavailable"));
  await act(() => store.init());
  expect(start).toBeDisabled();
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(start).toBeDisabled();
  const retry = screen.getByRole("button", { name: "Retry" });
  expect(retry).toBeEnabled();
  expect(screen.getByRole("alert")).toHaveTextContent(
    "Directory service unavailable",
  );

  catalog.mockResolvedValue({ models, defaults });
  await act(async () => fireEvent.click(retry));
  expect(start).toBeEnabled();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(message).toHaveValue("Wait for the directory check");
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
  await act(() => vi.advanceTimersByTimeAsync(15_000));
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
    "ordinary",
  );
  expect(screen.getByRole("button", { name: "Start session" })).toBeEnabled();
  expect(screen.getByRole("textbox", { name: "First message" })).toHaveValue(
    "Keep the resolved default",
  );
});

it("uses native candidate effort from the workspace catalog and preserves the choice on refresh", async () => {
  const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
  defaults = { cwd: "/one", model: extended, thinkingLevel: "low" };
  thinkingPreferences = {
    defaultLevel: "low",
    byModel: { "fixture/ordinary": "max" },
  };
  render(
    <Welcome
      showRecent={false}
      inherited={{ ...inherit, thinkingLevel: "low" }}
    />,
  );
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "Use the selected effort" },
  });
  const button = screen.getByRole("button", { name: "Start session" });
  await waitFor(() => expect(button).toBeEnabled());
  pick("ordinary");
  expect(screen.getByRole("combobox", { name: "Thinking level" })).toHaveValue(
    "high",
  );
  thinkingPreferences = { defaultLevel: "minimal", byModel: {} };
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Model" })),
  );
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Search models" }), {
    key: "Escape",
  });
  fireEvent.click(button);
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith("/one", {
      model: { provider: "fixture", id: "ordinary" },
      thinkingLevel: "high",
    }),
  );
});

it("waits for inherited selection before starting or creating a directory", async () => {
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
  await waitFor(() =>
    expect(queries).toHaveBeenCalledExactlyOnceWith(
      "source",
      "/one",
      true,
      expect.any(AbortSignal),
    ),
  );
  expect(screen.getByRole("button", { name: "Start session" })).toBeDisabled();
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/missing" },
  });
  const create = await screen.findByRole("button", {
    name: "Create folder and start",
  });
  expect(create).toBeDisabled();
  expect(create).toHaveAttribute("aria-busy", "true");
  vi.useFakeTimers();
  await act(async () =>
    source.reject(new ApiError(503, "The source model is unavailable")),
  );
  expect(screen.queryByText("The source model is unavailable")).toBeNull();
  expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
  expect(create).toBeDisabled();
  source = deferred<ModelCatalogResponse>();
  await act(() => vi.advanceTimersByTimeAsync(2_000));
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

it("submits an explicit choice from the refreshed catalog after an older preview arrives late", async () => {
  const pending = deferred<ModelCatalogResponse>();
  const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
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
  fireEvent.click(screen.getByRole("option", { name: /extended/ }));
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "Use the selected router" },
  });
  const submit = screen.getByRole("button", { name: "Start session" });
  await waitFor(() => expect(submit).toBeEnabled());
  fireEvent.click(submit);
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith("/one", {
      model: { provider: "fixture", id: "extended" },
      thinkingLevel: "max",
    }),
  );
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
  fireEvent.change(screen.getByRole("combobox", { name: "Thinking level" }), {
    target: { value: "low" },
  });
  defaults = { cwd: "/two", model: ordinary, thinkingLevel: "medium" };
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/two" },
  });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
      "ordinary",
    ),
  );
  expect(screen.getByRole("combobox", { name: "Thinking level" })).toHaveValue(
    "low",
  );
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "intentional effort" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Start session" }));
  await waitFor(() =>
    expect(start).toHaveBeenCalledWith("/two", { thinkingLevel: "low" }),
  );
});
it.each([
  { chosen: "Low", effective: "low", shown: "Low" },
  { chosen: "Max", effective: "high", shown: "High" },
])(
  "keeps manual $chosen effort on a model switch, clamping only unsupported levels",
  async ({ chosen, effective, shown }) => {
    const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
    render(
      <Welcome
        showRecent={false}
        inherited={{ ...inherit, thinkingLevel: "high" }}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Thinking level" }), {
      target: { value: chosen.toLowerCase() },
    });
    pick("ordinary");
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toHaveValue(shown.toLowerCase());
    fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
      target: { value: "Keep my effort choice" },
    });
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Start session" }),
      ).toBeEnabled(),
    );
    expect(
      screen.getByRole("combobox", { name: "Thinking level" }),
    ).toHaveValue(shown.toLowerCase());
    fireEvent.click(screen.getByRole("button", { name: "Start session" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith("/one", {
        model: { provider: "fixture", id: "ordinary" },
        thinkingLevel: effective,
      }),
    );
  },
);
it("keeps the selected model and manual effort when the target catalog changes", async () => {
  const start = vi.spyOn(store, "newSession").mockResolvedValue(null);
  render(<Welcome showRecent={false} inherited={inherit} />);
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "Use manual effort" },
  });
  defaults = { cwd: "/one", model: extended, thinkingLevel: "max" };
  pick("ordinary");
  fireEvent.change(screen.getByRole("combobox", { name: "Thinking level" }), {
    target: { value: "low" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "Project directory" }), {
    target: { value: "/two" },
  });
  catalog = () => [{ provider: "fixture", id: "fresh", reasoning: true }];
  thinkingPreferences = { defaultLevel: "medium", byModel: {} };
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  await screen.findByRole("option", { name: /^fresh/ });
  expect(screen.getByRole("button", { name: "Model" })).toHaveTextContent(
    "ordinary",
  );
  expect(screen.getByRole("combobox", { name: "Thinking level" })).toHaveValue(
    "low",
  );
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
it("keeps a same-cwd catalog read alive across equivalent inheritance and effort input", async () => {
  vi.useFakeTimers();
  const pending = deferred<ModelOption[]>();
  catalog = () => pending.promise;
  const refresh = vi.spyOn(store, "readNewSessionModels");
  const surface = () => (
    <Welcome
      showRecent={false}
      inherited={{ ...inherit, sessionId: "current", model: { ...extended } }}
    />
  );
  const view = render(surface());
  await act(() => vi.advanceTimersByTimeAsync(220));
  expect(refresh).toHaveBeenCalledExactlyOnceWith(
    "current",
    "/one",
    false,
    expect.any(AbortSignal),
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Thinking level" }), {
    target: { value: "xhigh" },
  });
  view.rerender(surface());
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(refresh).toHaveBeenCalledTimes(1);
  await act(async () =>
    pending.resolve([...models, { provider: "fixture", id: "fresh" }]),
  );
  expect(screen.getByRole("combobox", { name: "Thinking level" })).toHaveValue(
    "xhigh",
  );
  const next = deferred<ModelOption[]>();
  catalog = () => next.promise;
  fireEvent.click(screen.getByRole("button", { name: "Model" }));
  expect(screen.getByRole("option", { name: /^fresh/ })).toBeVisible();
  await act(async () => next.resolve(models));
});
it("checks the settled directory and ignores an older missing-path response", async () => {
  vi.useFakeTimers();
  const old = deferred<ModelCatalogResponse>();
  const current = deferred<ModelCatalogResponse>();
  const queries = vi
    .spyOn(store, "readNewSessionModels")
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(current.promise);
  render(<Welcome showRecent={false} inherited={inherit} />);
  const directory = screen.getByRole("textbox", { name: "Project directory" });
  fireEvent.change(screen.getByRole("textbox", { name: "First message" }), {
    target: { value: "Keep this draft" },
  });
  for (const value of ["/s", "/st", "/stale"]) {
    fireEvent.change(directory, { target: { value } });
    await act(() => vi.advanceTimersByTimeAsync(60));
  }
  await act(() => vi.advanceTimersByTimeAsync(300));
  expect(queries.mock.calls.map(([, cwd]) => cwd)).toEqual(["/stale"]);

  fireEvent.change(directory, { target: { value: "/valid" } });
  await act(() => vi.advanceTimersByTimeAsync(300));
  fireEvent.change(directory, { target: { value: " /valid " } });
  await act(async () => current.resolve({ models, defaults }));
  const start = screen.getByRole("button", { name: "Start session" });
  expect(start).toBeEnabled();
  await act(async () =>
    old.reject(
      new ApiError(
        400,
        "Project path does not exist",
        undefined,
        "PROJECT_DIRECTORY_MISSING",
      ),
    ),
  );
  expect(
    screen.queryByRole("button", { name: "Create folder and start" }),
  ).toBeNull();
  expect(start).toBeEnabled();
});
