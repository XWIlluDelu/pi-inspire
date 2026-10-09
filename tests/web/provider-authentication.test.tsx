// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderLoginAttempt } from "../../shared/model-settings";
import { loginProviders, pendingLogin } from "./fixtures/model-settings";

const host = vi.hoisted(() => ({
  providerAuth: vi.fn(),
  refreshModels: vi.fn(),
}));
vi.mock("../../src/store", () => ({ store: host }));

import { ProviderAuthentication } from "../../src/components/ProviderAuthentication";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
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
  it("keeps the same optional connection entry when nothing is stored", () => {
    render(
      <ProviderAuthentication
        owner={{}}
        providers={loginProviders().map((provider) => ({
          ...provider,
          stored: null,
        }))}
        onRefresh={refresh}
      />,
    );
    expect(
      screen.queryByRole("region", { name: "Connected providers" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Search providers")).not.toBeInTheDocument();
    const connect = screen.getByRole("button", { name: "Connect provider" });
    fireEvent.click(connect);
    expect(screen.getByLabelText("Search providers")).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Set up Anthropic" }),
    ).toBeEnabled();
    fireEvent.click(
      screen.getByRole("button", { name: "Back to connected providers" }),
    );
    expect(screen.queryByLabelText("Search providers")).not.toBeInTheDocument();
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
  it("discloses native methods and secondary removal for saved credentials without requiring deletion first", () => {
    render(panel());
    expect(
      screen.queryByRole("region", { name: "Available providers" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Search providers")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Anthropic API key" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Remove credential")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Manage Anthropic" }));
    expect(
      screen.getByRole("button", { name: "Anthropic API key" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", { name: "Claude authorization" }),
    ).toBeEnabled();
    expect(
      screen.getByRole("button", {
        name: "Remove saved credentials for Anthropic",
      }),
    ).toBeVisible();
    expect(host.providerAuth).not.toHaveBeenCalled();
    expect(screen.queryByText("No saved credential")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Connect provider" }));
    expect(
      screen.queryByRole("button", { name: "Anthropic API key" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Connected providers" }),
    ).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Search providers"), {
      target: { value: "copilot" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Set up GitHub Copilot" }),
    );
    expect(
      screen.getByRole("button", { name: "GitHub authorization" }),
    ).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Back to providers" }));
    expect(screen.getByLabelText("Search providers")).toHaveValue("copilot");
    fireEvent.click(
      screen.getByRole("button", { name: "Back to connected providers" }),
    );
    expect(
      screen.getByRole("button", { name: "Manage Anthropic" }),
    ).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "GitHub authorization" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Anthropic API key" }),
    ).not.toBeInTheDocument();
  });
  it("distinguishes unresolved, failed, loaded no-match and stale loaded data", () => {
    const props = { owner: {}, providers: [], onRefresh: refresh };
    const view = render(
      <ProviderAuthentication {...props} loading loaded={false} />,
    );
    expect(screen.getByRole("status")).toHaveTextContent("Loading providers…");
    expect(screen.queryByText(/No providers/)).not.toBeInTheDocument();
    expect(
      screen.queryByRole("region", { name: "Connected providers" }),
    ).not.toBeInTheDocument();
    view.rerender(
      <ProviderAuthentication {...props} loaded={false} loadError="Offline" />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Failed to load providers: Offline",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(refresh).toHaveBeenCalledTimes(1);
    view.rerender(
      <ProviderAuthentication
        {...props}
        providers={loginProviders()}
        loadError="Offline"
      />,
    );
    expect(
      screen.getByRole("button", { name: "Manage Anthropic" }),
    ).toBeEnabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Provider refresh failed",
    );
    fireEvent.click(screen.getByRole("button", { name: "Connect provider" }));
    fireEvent.change(screen.getByLabelText("Search providers"), {
      target: { value: "nonexistent" },
    });
    expect(
      screen.getByText('No available providers matching "nonexistent"'),
    ).toBeVisible();
    expect(
      within(
        screen.getByRole("region", { name: "Available providers" }),
      ).queryByText("Anthropic"),
    ).not.toBeInTheDocument();
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
    await act(async () => vi.advanceTimersByTimeAsync(1500));
    expect(statusReads).toBe(2);
    view.unmount();
  });

  it("reveals supplied remote instructions on demand and does not invent method help", async () => {
    host.providerAuth.mockResolvedValue(pendingLogin());
    render(panel());
    expect(screen.queryByText("Remote login")).not.toBeInTheDocument();
    await start();
    await screen.findByRole("button", { name: "Copy authorization code" });

    expect(screen.getByText("Remote login")).toBeVisible();
    expect(
      screen.queryByText(/then paste the authorization code here/),
    ).not.toBeInTheDocument();
    const help = screen.getByRole("button", { name: "About remote login" });
    fireEvent.click(help);
    expect(help).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByText(/then paste the authorization code here/),
    ).toBeVisible();
    fireEvent.click(help);
    expect(
      screen.queryByText(/then paste the authorization code here/),
    ).not.toBeInTheDocument();
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
