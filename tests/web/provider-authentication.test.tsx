import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderLoginAttempt } from "../../shared/model-settings";
import { ProviderAuthentication } from "../../src/components/ProviderAuthentication";
import { loginProviders, pendingLogin } from "./fixtures/model-settings";
import { deferred } from "./helpers";

const host = vi.hoisted(() => ({
  providerAuth: vi.fn(),
  refreshModels: vi.fn(),
}));
vi.mock("../../src/store", () => ({ store: host }));

const refresh = vi.fn(async () => {});
const panel = (
  props: Partial<ComponentProps<typeof ProviderAuthentication>> = {},
) => (
  <ProviderAuthentication
    owner={{ sessionId: "one" }}
    providers={loginProviders()}
    onRefresh={refresh}
    {...props}
  />
);
const keyPrompt = () =>
  pendingLogin({
    type: "api_key",
    prompt: { id: "key", type: "secret", message: "API key" },
  });
const terminal = (status: "completed" | "cancelled" = "completed") =>
  pendingLogin({
    status,
    prompt: null,
    message: status === "completed" ? "Login complete." : "Login cancelled.",
  });
const click = (name: string) =>
  fireEvent.click(screen.getByRole("button", { name }));
const nextPoll = (delay = 250) => act(() => vi.advanceTimersByTimeAsync(delay));
async function start(method = "Claude authorization") {
  click("Manage Anthropic");
  await act(async () => click(method));
}
beforeEach(() => {
  host.providerAuth.mockReset();
  host.refreshModels.mockReset().mockResolvedValue(undefined);
  refresh.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("provider directory", () => {
  it("distinguishes unavailable data from an empty directory and keeps saved choices on refresh failure", () => {
    const initial = { providers: [], loaded: false };
    const view = render(panel({ ...initial, loading: true }));
    expect(screen.getByRole("status")).toHaveTextContent("Loading providers");
    expect(
      screen.getByRole("button", { name: "Connect provider" }),
    ).toBeDisabled();

    view.rerender(
      panel({ ...initial, loadError: "Provider service unavailable" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Provider service unavailable",
    );
    expect(
      screen.getByRole("button", { name: "Connect provider" }),
    ).toBeDisabled();
    click("Retry");
    expect(refresh).toHaveBeenCalledOnce();

    view.rerender(panel({ providers: [], loaded: true }));
    expect(screen.getByText("No connected providers.")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Connect provider" }),
    ).toBeEnabled();

    view.rerender(panel({ loadError: "Offline" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Provider refresh failed",
    );
    expect(
      screen.getByRole("button", { name: "Manage Anthropic" }),
    ).toBeEnabled();
  });
});

describe("login attempt ownership", () => {
  beforeEach(() =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }),
  );

  it("keeps the native prompt on reconnect, retries a failed poll and refreshes once on completion", async () => {
    let readFailed = false;
    const pending = pendingLogin({
      events: [
        {
          type: "auth_url",
          url: "https://example.invalid/authorize",
          userCode: "ABCD-EFGH",
        },
        { type: "progress", message: "Waiting for authorization…" },
      ],
      prompt: {
        id: "code",
        type: "manual_code",
        message: "Authorization code",
      },
    });
    host.providerAuth.mockImplementation(async (_owner, request) => {
      if (request.operation === "start") return pending;
      if (request.operation !== "status") return null;
      if (readFailed) return terminal();
      readFailed = true;
      throw new Error("503 temporarily unavailable");
    });

    const modelsRefreshed = vi.fn(async () => {});
    const view = render(panel({ onModelsRefreshed: modelsRefreshed }));
    await start();
    const login = within(
      screen.getByRole("group", { name: "Login to anthropic" }),
    );
    expect(login.getByRole("status")).toHaveTextContent(
      "Waiting for authorization",
    );
    expect(
      login.getByRole("link", { name: "Open sign-in link" }),
    ).toHaveAttribute("href", "https://example.invalid/authorize");
    expect(login.getByText("ABCD-EFGH")).toBeVisible();
    expect(login.getByLabelText("Authorization code")).toBeEnabled();

    await nextPoll();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "503 temporarily unavailable",
    );
    const reconnected = vi.fn(async () => {});
    view.rerender(
      panel({ onRefresh: reconnected, onModelsRefreshed: modelsRefreshed }),
    );
    expect(login.getByLabelText("Authorization code")).toBeEnabled();
    await nextPoll(750);

    expect(login.getByRole("status")).toHaveTextContent("Login complete.");
    expect(login.queryByLabelText("Authorization code")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    await nextPoll(1500);
    expect(
      host.providerAuth.mock.calls.map(([, request]) => request.operation),
    ).toEqual(["start", "status", "status"]);
    expect(refresh).not.toHaveBeenCalled();
    expect(reconnected).toHaveBeenCalledOnce();
    expect(host.refreshModels).toHaveBeenCalledExactlyOnceWith({
      sessionId: "one",
    });
    expect(modelsRefreshed).toHaveBeenCalledOnce();
  });

  it("preserves typed input on a fresh poll and never restores an old prompt after an answer", async () => {
    const old = keyPrompt();
    const stale = deferred<ProviderLoginAttempt>();
    let reads = 0;
    host.providerAuth.mockImplementation(async (_owner, request) => {
      if (request.operation === "start") return old;
      if (request.operation === "status")
        return ++reads === 1 ? old : stale.promise;
      if (request.operation === "answer")
        return {
          ...old,
          prompt: { id: "account", type: "text", message: "Account ID" },
        };
      return null;
    });
    render(panel());
    await start("Anthropic API key");
    const key = screen.getByLabelText("API key");
    fireEvent.change(key, { target: { value: "do-not-echo" } });
    await nextPoll();
    expect(key).toHaveValue("do-not-echo");
    expect(key).toHaveFocus();

    await nextPoll(750);
    expect(reads).toBe(2);
    await act(async () => click("Continue"));
    await act(async () => stale.resolve(old));
    expect(screen.queryByLabelText("API key")).toBeNull();
    expect(screen.getByLabelText("Account ID")).toHaveValue("");
    expect(document.body.textContent).not.toContain("do-not-echo");
  });

  it("continues observing a failed Cancel request until login is cancelled", async () => {
    host.providerAuth.mockImplementation(async (_owner, request) => {
      if (request.operation === "cancel")
        throw new Error("Cancel response unavailable");
      return request.operation === "status"
        ? terminal("cancelled")
        : pendingLogin();
    });
    render(panel());
    await start();
    await act(async () => click("Cancel login"));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Cancel response unavailable",
    );
    await nextPoll();
    expect(screen.getByRole("status")).toHaveTextContent("Login cancelled.");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it.each([
    { action: "answer", completes: "status", fails: "answer" },
    { action: "cancel", completes: "status", fails: "cancel" },
    { action: "answer", completes: "answer", fails: "status" },
  ] as const)(
    "preserves completion from $completes after a late $fails failure",
    async ({ action, completes, fails }) => {
      const late = deferred<ProviderLoginAttempt>();
      const attempt = keyPrompt();
      host.providerAuth.mockImplementation(async (_owner, request) => {
        if (request.operation === "start") return attempt;
        if (request.operation === fails) return late.promise;
        if (request.operation === completes) return terminal();
        return null;
      });
      render(panel());
      await start("Anthropic API key");
      if (action === "answer")
        fireEvent.change(screen.getByLabelText("API key"), {
          target: { value: "test-key" },
        });
      const button = action === "answer" ? "Continue" : "Cancel login";
      if (fails === "status") {
        await nextPoll();
        await act(async () => click(button));
      } else {
        click(button);
        await nextPoll();
      }
      expect(host.providerAuth).toHaveBeenCalledWith(
        { sessionId: "one" },
        expect.objectContaining({ operation: fails, id: attempt.id }),
      );
      expect(screen.getByRole("status")).toHaveTextContent("Login complete.");
      await act(async () => late.reject(new Error("Response unavailable")));
      expect(screen.getByRole("status")).toHaveTextContent("Login complete.");
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );

  it("stops polling and allows another login when Cancel confirms there is no attempt", async () => {
    host.providerAuth.mockImplementation(async (_owner, request) =>
      request.operation === "cancel" ? null : pendingLogin(),
    );
    render(panel());
    await start();
    await act(async () => click("Cancel login"));
    expect(
      screen.queryByRole("group", { name: "Login to anthropic" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Claude authorization" }),
    ).toBeEnabled();
    await nextPoll(1500);
    expect(
      host.providerAuth.mock.calls.map(([, request]) => request.operation),
    ).toEqual(["start", "cancel"]);
  });

  it("cancels a late-created attempt on its original owner", async () => {
    const pending = deferred<ProviderLoginAttempt>();
    host.providerAuth.mockImplementation(async (_owner, request) =>
      request.operation === "start" ? pending.promise : null,
    );
    const view = render(panel());
    await start();
    view.rerender(panel({ owner: { sessionId: "two" } }));
    await act(async () => pending.resolve(pendingLogin()));
    expect(host.providerAuth).toHaveBeenCalledWith(
      { sessionId: "one" },
      { operation: "cancel", id: pendingLogin().id },
    );
    click("Manage Anthropic");
    expect(
      screen.getByRole("button", { name: "Claude authorization" }),
    ).toBeEnabled();
  });

  it("does not show a retired owner's Cancel result or refresh the new owner", async () => {
    const cancel = deferred<ProviderLoginAttempt>();
    host.providerAuth.mockImplementation(async (_owner, request) =>
      request.operation === "cancel" ? cancel.promise : pendingLogin(),
    );
    const view = render(panel());
    await start();
    click("Cancel login");
    view.rerender(panel({ owner: { sessionId: "two" } }));
    await act(async () => cancel.resolve(terminal("cancelled")));
    expect(screen.queryByText("Login cancelled.")).toBeNull();
    expect(refresh).not.toHaveBeenCalled();
    click("Manage Anthropic");
    expect(
      screen.getByRole("button", { name: "Claude authorization" }),
    ).toBeEnabled();
  });
});
