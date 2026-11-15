// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelOption } from "../../shared/contracts";
import type { ModelCatalogResponse } from "../../shared/model-settings";
import { ApiError } from "../../src/api";
import { Welcome } from "../../src/components/Welcome";
import { store } from "../../src/store";
import { mockModelMenuLayout } from "./fixtures/model-menu-layout";
import { bootstrapPayload, deferred, installFakeWebSocket } from "./helpers";
import { installStoreRoutes } from "./store-fixture";

const inherited: ModelOption = {
  provider: "fixture",
  id: "router",
  reasoning: true,
  virtual: true,
  thinkingLevelMap: { max: "max" },
};
const alternative: ModelOption = {
  provider: "fixture",
  id: "alternative",
  reasoning: true,
};
const models = [inherited, alternative];
const catalog: ModelCatalogResponse = {
  models,
  defaults: { cwd: "/target", model: alternative, thinkingLevel: "medium" },
};
const selection = {
  cwd: "/source",
  model: inherited,
  thinkingLevel: "max",
} as const;
const failure = new ApiError(503, "The source model is unavailable");

beforeEach(async () => {
  installFakeWebSocket();
  installStoreRoutes((url) =>
    url === "/api/bootstrap"
      ? { body: bootstrapPayload({ availableModels: models }) }
      : undefined,
  );
  mockModelMenuLayout();
  await store.init();
});
afterEach(() => {
  cleanup();
  store.drafts.clear(null);
  vi.useRealTimers();
});

const directory = () =>
  screen.getByRole("textbox", { name: "Project directory" });
const message = () => screen.getByRole("textbox", { name: "First message" });
const model = () => screen.getByRole("button", { name: "Model" });
const start = () => screen.getByRole("button", { name: "Start session" });
it("blocks New during inherited lookup and lets the same draft retry a failed source", async () => {
  let recover = false;
  const source = deferred<ModelCatalogResponse>();
  const read = vi
    .spyOn(store, "readNewSessionModels")
    .mockImplementation(async (_sessionId, _cwd, inherit) => {
      if (!inherit) return catalog;
      if (recover) return { ...catalog, selection };
      return source.promise;
    });
  render(
    <Welcome
      inherited={{
        sessionId: "source",
        cwd: "/source",
        model: null,
        modelDiscovery: "loading",
        thinkingLevel: "off",
        commands: [],
      }}
    />,
  );
  fireEvent.change(directory(), { target: { value: "/target" } });
  fireEvent.change(message(), { target: { value: "Keep this draft" } });
  await waitFor(() =>
    expect(read).toHaveBeenCalledWith(
      undefined,
      "/target",
      false,
      expect.any(AbortSignal),
    ),
  );
  expect(start()).toBeDisabled();
  expect(screen.queryByText(failure.message)).toBeNull();
  vi.useFakeTimers();
  await act(async () => source.reject(failure));
  await act(() => vi.advanceTimersByTimeAsync(14_100));
  expect(screen.getByText(failure.message)).toBeVisible();
  expect(start()).toBeDisabled();

  recover = true;
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: "Retry" })),
  );
  expect(model()).toHaveTextContent("router");
  expect(
    screen.getByRole("combobox", { name: "Thinking level" }),
  ).toHaveTextContent(/max/i);
  expect(start()).toBeEnabled();
  expect(message()).toHaveValue("Keep this draft");
});

it("preserves an explicit selection when a superseded directory preview returns", async () => {
  const old = deferred<ModelCatalogResponse>();
  const read = vi
    .spyOn(store, "readNewSessionModels")
    .mockReturnValueOnce(old.promise)
    .mockResolvedValue(catalog);
  render(<Welcome />);
  fireEvent.change(directory(), { target: { value: "/old" } });
  await waitFor(() => expect(read).toHaveBeenCalledOnce());
  const staleSignal = read.mock.calls[0]![3];
  fireEvent.change(directory(), { target: { value: "/target" } });
  fireEvent.change(message(), {
    target: { value: "Draft with explicit choice" },
  });
  await waitFor(() => expect(start()).toBeEnabled());
  await act(async () => fireEvent.click(model()));
  fireEvent.click(screen.getByRole("option", { name: /router/ }));
  await act(async () =>
    old.resolve({ models: [], defaults: { ...selection, model: null } }),
  );
  expect(staleSignal?.aborted).toBe(true);
  expect(model()).toHaveTextContent("router");
  expect(start()).toBeEnabled();

  read.mockRejectedValue(new ApiError(403, "Directory check unavailable"));
  await act(async () => store.init());
  expect(start()).toBeDisabled();
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Directory check unavailable",
  );
  expect(model()).toHaveTextContent("router");
  expect(message()).toHaveValue("Draft with explicit choice");
});

it("requires a selection if native metadata supplies no model", async () => {
  vi.spyOn(store, "readNewSessionModels").mockResolvedValue({
    models: [],
    defaults: { ...selection, model: null },
  });
  render(<Welcome />);
  fireEvent.change(directory(), { target: { value: "/target" } });
  fireEvent.change(message(), { target: { value: "Do not guess" } });
  await screen.findByText("Models are unavailable");
  expect(model()).toHaveTextContent("Model unavailable");
  expect(start()).toBeDisabled();
});
