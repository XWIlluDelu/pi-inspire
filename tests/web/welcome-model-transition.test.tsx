// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ModelOption, ThinkingLevel } from "../../shared/contracts";
import { Welcome } from "../../src/components/Welcome";
import { store } from "../../src/store";
import { mockModelMenuLayout } from "./fixtures/model-menu-layout";
import { bootstrapPayload, deferred, installFetch } from "./helpers";

const extended: ModelOption = {
  provider: "fixture",
  id: "extended",
  reasoning: true,
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
beforeEach(async () => {
  mockModelMenuLayout();
  thinking = (query) => query.get("current") as ThinkingLevel;
  catalog = () => models;
  installFetch(async (url) => {
    if (url === "/api/bootstrap")
      return { body: bootstrapPayload({ availableModels: models }) };
    if (url.startsWith("/api/models"))
      return { body: { models: await catalog() } };
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
