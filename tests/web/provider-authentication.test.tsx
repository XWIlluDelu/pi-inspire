// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
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
const panel = (owner = { sessionId: "one" }) => (
  <ProviderAuthentication
    owner={owner}
    providers={loginProviders()}
    onRefresh={refresh}
  />
);
async function start(method = "Claude authorization") {
  fireEvent.click(screen.getByRole("button", { name: "Manage Anthropic" }));
  await act(async () =>
    fireEvent.click(screen.getByRole("button", { name: method })),
  );
}
beforeEach(() => {
  host.providerAuth.mockReset();
  host.refreshModels.mockReset().mockResolvedValue(undefined);
  refresh.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("provider directory", () => {
  it("uses one login status while preserving authorization actions and replacing progress with the outcome", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let attempt = pendingLogin({
      events: [
        {
          type: "auth_url",
          url: "https://example.com/authorize",
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
    host.providerAuth.mockImplementation(async () => attempt);
    const view = render(panel());
    await start();
    const login = within(
      screen.getByRole("group", { name: "Login to anthropic" }),
    );
    expect(login.getAllByRole("status")).toHaveLength(1);
    expect(login.getByRole("status")).toHaveTextContent(
      "Waiting for authorization…",
    );
    expect(screen.queryByText("Login in progress")).toBeNull();
    expect(
      login.getByRole("link", { name: "Open sign-in link" }),
    ).toHaveAttribute("href", "https://example.com/authorize");
    expect(login.getByText("ABCD-EFGH")).toBeVisible();
    expect(login.getByLabelText("Authorization code")).toBeEnabled();
    attempt = {
      ...attempt,
      status: "completed",
      message: "Login complete.",
      prompt: null,
    };
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(login.getAllByRole("status")).toHaveLength(1);
    expect(login.getByRole("status")).toHaveTextContent("Login complete.");
    expect(login.queryByText("Waiting for authorization…")).toBeNull();
    view.unmount();
  });

  it("requires initial provider data and keeps loaded choices usable when refresh fails", () => {
    const props = {
      owner: {},
      providers: [],
      onRefresh: refresh,
      loaded: false,
    };
    const view = render(<ProviderAuthentication {...props} loading />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading providers…");
    expect(
      screen.getByRole("button", { name: "Connect provider" }),
    ).toBeDisabled();
    expect(screen.queryByText("No connected providers.")).toBeNull();
    view.rerender(
      <ProviderAuthentication
        {...props}
        loadError="Provider service unavailable"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Connect provider" }),
    ).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Provider service unavailable",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledOnce();
    expect(screen.queryByText("No connected providers.")).toBeNull();
    view.rerender(<ProviderAuthentication {...props} loaded />);
    expect(
      screen.getByRole("button", { name: "Connect provider" }),
    ).toBeEnabled();
    expect(screen.getByText("No connected providers.")).toBeVisible();
    view.rerender(
      <ProviderAuthentication
        {...props}
        loaded
        loading
        providers={loginProviders()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Manage Anthropic" }),
    ).toBeEnabled();
    expect(screen.queryByText("Loading providers…")).toBeNull();
    view.rerender(
      <ProviderAuthentication
        {...props}
        loaded
        loadError="Offline"
        providers={loginProviders()}
      />,
    );
    expect(
      screen.getByRole("button", { name: "Manage Anthropic" }),
    ).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Provider refresh failed",
    );
  });

  it("emphasizes directory name matches and explains ID-only results without changing method titles", () => {
    const { container } = render(
      <ProviderAuthentication
        owner={{}}
        providers={[
          ...loginProviders(),
          {
            id: "azure-openai-responses",
            name: "Azure OpenAI",
            stored: null,
            methods: [{ type: "api_key", label: "Azure API key" }],
          },
        ]}
        onRefresh={refresh}
        discover
      />,
    );
    const directory = container.querySelector(".models-auth__providers")!;
    const search = screen.getByLabelText("Search providers");
    fireEvent.change(search, { target: { value: "  AZURE  " } });
    expect(directory.querySelectorAll(".models-provider-login")).toHaveLength(
      1,
    );
    expect(directory.querySelector(".search-match")).toHaveTextContent("Azure");
    expect(directory.querySelector("code")).toBeNull();
    fireEvent.change(search, { target: { value: "RESPONSES" } });
    expect(directory.querySelector("strong .search-match")).toBeNull();
    expect(directory.querySelector("code")).toHaveTextContent(
      "azure-openai-responses",
    );
    expect(directory.querySelector("code .search-match")).toHaveTextContent(
      "responses",
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Set up Azure OpenAI" }),
    );
    expect(container.querySelector(".models-auth__providers")).toBeNull();
    expect(
      container.querySelector(
        ".search-match, .models-provider-login__matched-id",
      ),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Azure API key" })).toBeVisible();
    expect(host.providerAuth).not.toHaveBeenCalled();
  });
  it("opens explicit login discovery and the unique queried provider's native methods", () => {
    const props = {
      owner: {},
      providers: [
        ...loginProviders(),
        {
          id: "anthropic-compatible",
          name: "Anthropic compatible",
          stored: null,
          methods: [
            { type: "api_key" as const, label: "Compatible provider API key" },
          ],
        },
      ],
      onRefresh: refresh,
    };
    const view = render(<ProviderAuthentication {...props} discover />);
    expect(screen.getByLabelText("Search providers")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "GitHub authorization" }),
    ).not.toBeInTheDocument();
    view.rerender(
      <ProviderAuthentication {...props} discover initialQuery="copilot" />,
    );
    expect(screen.queryByLabelText("Search providers")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "GitHub authorization" }),
    ).toBeEnabled();
    view.rerender(
      <ProviderAuthentication {...props} discover initialQuery="anthropic" />,
    );
    expect(
      screen.getByRole("button", { name: "Anthropic API key" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Claude authorization" }),
    ).toBeEnabled();
    expect(host.providerAuth).not.toHaveBeenCalled();
  });
});

describe("auth attempt observation and owner retirement", () => {
  it("recovers status polling after a temporary 503 and refreshes availability once completion arrives", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const modelsRefreshed = vi.fn(async () => {});
    let statusReads = 0;
    host.providerAuth.mockImplementation(async (_owner, operation) => {
      if (operation.operation === "start") return pendingLogin();
      if (operation.operation === "status") {
        if (++statusReads === 1) throw new Error("503 temporarily unavailable");
        return pendingLogin({
          status: "completed",
          prompt: null,
          message: "Login complete.",
        });
      }
      return null;
    });
    const view = render(
      <ProviderAuthentication
        owner={{ sessionId: "one" }}
        providers={loginProviders()}
        onRefresh={refresh}
        onModelsRefreshed={modelsRefreshed}
      />,
    );
    await start();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "503 temporarily unavailable",
    );
    expect(statusReads).toBe(1);
    await act(async () => vi.advanceTimersByTimeAsync(750));
    expect(statusReads).toBe(2);
    expect(screen.getByText("Login complete.")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(host.refreshModels).toHaveBeenCalledTimes(1);
    expect(modelsRefreshed).toHaveBeenCalledTimes(1);
    const reconnected = vi.fn(async () => {});
    view.rerender(
      <ProviderAuthentication
        owner={{ sessionId: "one" }}
        providers={loginProviders()}
        onRefresh={reconnected}
        onModelsRefreshed={modelsRefreshed}
      />,
    );
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(statusReads).toBe(2);
    expect(reconnected).not.toHaveBeenCalled();
    view.unmount();
  });

  it("retires polls across a prompt mutation so reads cannot restore an old secret input", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const old = pendingLogin({
      type: "api_key",
      prompt: { id: "key", type: "secret", message: "API key" },
    });
    const next = pendingLogin({
      type: "api_key",
      prompt: { id: "account", type: "text", message: "Account ID" },
    });
    const answer = deferred<ProviderLoginAttempt>(),
      poll = deferred<ProviderLoginAttempt>();
    let statusReads = 0;
    host.providerAuth.mockImplementation(async (_owner, operation) =>
      operation.operation === "start"
        ? old
        : operation.operation === "answer"
          ? answer.promise
          : operation.operation === "status"
            ? ++statusReads === 1
              ? old
              : poll.promise
            : null,
    );
    const view = render(panel());
    await start("Anthropic API key");
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "do-not-echo" },
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByLabelText("API key")).toHaveValue("do-not-echo");
    expect(screen.getByLabelText("API key")).toHaveFocus();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    await act(async () => vi.advanceTimersByTimeAsync(750));
    await act(async () => answer.resolve(next));
    expect(screen.getByLabelText("Account ID")).toBeVisible();
    await act(async () => poll.resolve(old));
    expect(screen.queryByLabelText("API key")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Account ID")).toHaveValue("");
    expect(document.body.textContent).not.toContain("do-not-echo");
    view.unmount();
  });

  it.each(["refused", "lost receipt"])(
    "continues observing after Cancel has a %s failure",
    async (failure) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      let cancelled = false;
      let reads = 0;
      host.providerAuth.mockImplementation(async (_owner, operation) => {
        if (operation.operation === "start") return pendingLogin();
        if (operation.operation === "cancel") {
          cancelled = failure === "lost receipt";
          throw new Error("Cancel response unavailable");
        }
        if (operation.operation === "status") {
          ++reads;
          return reads >= 3
            ? pendingLogin({
                status: cancelled ? "cancelled" : "completed",
                prompt: null,
                message: cancelled ? "Login cancelled." : "Login complete.",
              })
            : pendingLogin();
        }
        return null;
      });
      const view = render(panel());
      await start();
      await act(async () => vi.advanceTimersByTimeAsync(250));
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Cancel login" })),
      );
      expect(screen.getByRole("alert")).toHaveTextContent(
        "Cancel response unavailable",
      );
      await act(async () => vi.advanceTimersByTimeAsync(1500));
      expect(reads).toBe(3);
      expect(
        screen.getByText(cancelled ? "Login cancelled." : "Login complete."),
      ).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      await act(async () => vi.advanceTimersByTimeAsync(3000));
      expect(reads).toBe(3);
      view.unmount();
    },
  );
  it.each(["answer", "cancel"] as const)(
    "ignores a late %s failure after polling has confirmed completion",
    async (operation) => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const receipt = deferred<ProviderLoginAttempt>();
      const pending = pendingLogin({
        type: "api_key",
        prompt: { id: "key", type: "secret", message: "API key" },
      });
      host.providerAuth.mockImplementation(async (_owner, request) => {
        if (request.operation === "start") return pending;
        if (request.operation === operation) return receipt.promise;
        if (request.operation === "status")
          return {
            ...pending,
            status: "completed",
            prompt: null,
            message: "Login complete.",
          };
        return null;
      });
      const view = render(panel());
      await start("Anthropic API key");
      if (operation === "answer")
        fireEvent.change(screen.getByLabelText("API key"), {
          target: { value: "test-key" },
        });
      fireEvent.click(
        screen.getByRole("button", {
          name: operation === "answer" ? "Continue" : "Cancel login",
        }),
      );

      await act(async () => vi.advanceTimersByTimeAsync(250));
      expect(screen.getByText("Login complete.")).toBeVisible();
      await act(async () => receipt.reject(new Error("Response unavailable")));
      expect(screen.getByText("Login complete.")).toBeVisible();
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      view.unmount();
    },
  );

  it("keeps answer completion authoritative over failed and outstanding polls", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const poll = deferred<ProviderLoginAttempt>();
    let statusReads = 0;
    const pending = pendingLogin({
      type: "api_key",
      prompt: { id: "key", type: "secret", message: "API key" },
    });
    host.providerAuth.mockImplementation((_owner, request) => {
      if (request.operation === "start") return Promise.resolve(pending);
      if (request.operation === "status")
        return ++statusReads === 1
          ? Promise.reject(new Error("Status unavailable"))
          : poll.promise;
      if (request.operation === "answer")
        return Promise.resolve({
          ...pending,
          status: "completed",
          prompt: null,
          message: "Login complete.",
        });
      return Promise.resolve(null);
    });
    const view = render(panel());
    await start("Anthropic API key");
    fireEvent.change(screen.getByLabelText("API key"), {
      target: { value: "test-key" },
    });
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByRole("alert")).toHaveTextContent("Status unavailable");
    await act(async () => vi.advanceTimersByTimeAsync(750));
    // Both requests settle before React cleans up the pending polling effect.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));
      await Promise.resolve();
      poll.reject(new Error("Status unavailable"));
    });
    expect(screen.getByText("Login complete.")).toBeVisible();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    view.unmount();
  });

  it("retires a missing login when Cancel confirms there is no attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    host.providerAuth.mockImplementation(async (_owner, operation) =>
      operation.operation === "cancel" ? null : pendingLogin(),
    );
    const view = render(panel());
    await start();
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () =>
      fireEvent.click(screen.getByRole("button", { name: "Cancel login" })),
    );
    expect(screen.queryByText("Login in progress")).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Claude authorization" }),
    ).toBeEnabled();
    const reads = host.providerAuth.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(host.providerAuth).toHaveBeenCalledTimes(reads);
    view.unmount();
  });

  it("cleans up a late-created attempt without leaving the new owner busy", async () => {
    const pending = deferred<ProviderLoginAttempt>();
    host.providerAuth.mockImplementation(async (_owner, operation) =>
      operation.operation === "start" ? pending.promise : null,
    );
    const view = render(panel());
    await start();
    view.rerender(panel({ sessionId: "two" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage Anthropic" }));
    expect(
      screen.getByRole("button", { name: "Claude authorization" }),
    ).toBeEnabled();
    await act(async () => pending.resolve(pendingLogin()));
    expect(screen.queryByText("Login in progress")).not.toBeInTheDocument();
    expect(host.providerAuth).toHaveBeenCalledWith(
      { sessionId: "one" },
      { operation: "cancel", id: pendingLogin().id },
    );
    view.unmount();
  });
  it("does not render a retired owner's Cancel receipt or invoke its refresh", async () => {
    const cancel = deferred<ProviderLoginAttempt>();
    host.providerAuth.mockImplementation(async (_owner, operation) =>
      operation.operation === "start"
        ? pendingLogin()
        : operation.operation === "cancel"
          ? cancel.promise
          : pendingLogin(),
    );
    const view = render(panel());
    await start();
    fireEvent.click(screen.getByRole("button", { name: "Cancel login" }));
    view.rerender(panel({ sessionId: "two" }));
    await act(async () =>
      cancel.resolve(
        pendingLogin({
          status: "cancelled",
          message: "Old owner cancelled",
          prompt: null,
        }),
      ),
    );
    expect(screen.queryByText("Old owner cancelled")).not.toBeInTheDocument();
    expect(refresh).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Manage Anthropic" }));
    expect(
      screen.getByRole("button", { name: "Claude authorization" }),
    ).toBeEnabled();
    view.unmount();
  });
  it("keeps observing when same-owner props are replaced on reconnect", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    host.providerAuth.mockImplementation(async (_owner, operation) =>
      operation.operation === "status"
        ? pendingLogin({
            status: "completed",
            message: "Login complete.",
            prompt: null,
          })
        : pendingLogin(),
    );
    const view = render(panel());
    await start();
    view.rerender(panel());
    expect(screen.getByText("Login in progress")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Cancel login" }),
    ).not.toHaveClass("button--quiet");
    expect(
      host.providerAuth.mock.calls.some(
        ([, operation]) => operation.operation === "cancel",
      ),
    ).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(screen.getByText("Login complete.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Dismiss" })).toHaveClass(
      "button--quiet",
    );
    view.unmount();
  });
});
