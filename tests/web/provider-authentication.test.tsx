import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ProviderLoginAttempt,
  ProviderLoginOption,
} from "../../shared/model-settings";
import { ProviderAuthentication } from "../../src/components/ProviderAuthentication";
import { deferred } from "./helpers";

const host = vi.hoisted(() => ({
  providerAuth: vi.fn(),
}));
vi.mock("../../src/store", () => ({ store: host }));

const refresh = vi.fn(async () => {});
const providers: ProviderLoginOption[] = [
  {
    id: "anthropic",
    name: "Anthropic",
    stored: "api_key",
    methods: [
      { type: "api_key", label: "Anthropic API key" },
      { type: "oauth", label: "Claude authorization" },
    ],
  },
];
const pending = (
  overrides: Partial<ProviderLoginAttempt> = {},
): ProviderLoginAttempt => ({
  id: "login",
  provider: "anthropic",
  type: "oauth",
  status: "pending",
  events: [],
  prompt: null,
  ...overrides,
});
const panel = (
  props: Partial<ComponentProps<typeof ProviderAuthentication>> = {},
) => (
  <ProviderAuthentication
    owner={{ sessionId: "one" }}
    providers={providers}
    onRefresh={refresh}
    {...props}
  />
);
const keyPrompt = () =>
  pending({
    type: "api_key",
    prompt: { id: "key", type: "secret", message: "API key" },
  });
const terminal = (status: "completed" | "cancelled" = "completed") =>
  pending({
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
  refresh.mockClear();
});
afterEach(() => vi.useRealTimers());

describe("login attempt ownership", () => {
  beforeEach(() =>
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] }),
  );

  it("keeps the native prompt on reconnect, retries a failed poll and refreshes once on completion", async () => {
    const attempt = pending({
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
    host.providerAuth
      .mockResolvedValueOnce(attempt)
      .mockRejectedValueOnce(new Error("503 temporarily unavailable"))
      .mockResolvedValueOnce(terminal());

    const view = render(panel());
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
    expect(screen.queryByRole("alert")).toBeNull();
    const reconnected = vi.fn(async () => {});
    view.rerender(panel({ onRefresh: reconnected }));
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

  it.each([
    { completes: "status", fails: "answer" },
    { completes: "answer", fails: "status" },
  ] as const)(
    "preserves completion from $completes after a late $fails failure",
    async ({ completes, fails }) => {
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
      fireEvent.change(screen.getByLabelText("API key"), {
        target: { value: "test-key" },
      });
      if (fails === "status") {
        await nextPoll();
        await act(async () => click("Continue"));
      } else {
        click("Continue");
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
      request.operation === "cancel" ? null : pending(),
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

  it.each(["cancel", "logout"] as const)(
    "does not publish a retired owner's %s result",
    async (operation) => {
      const retired = deferred<ProviderLoginAttempt | null>();
      host.providerAuth.mockImplementation(async (_owner, request) =>
        request.operation === operation ? retired.promise : pending(),
      );
      const view = render(panel());
      if (operation === "cancel") {
        await start();
        click("Cancel login");
      } else {
        click("Manage Anthropic");
        click("Remove saved credentials for Anthropic");
        click("Remove saved credentials");
      }
      view.rerender(panel({ owner: { sessionId: "two" } }));
      await act(async () =>
        retired.resolve(operation === "cancel" ? terminal("cancelled") : null),
      );
      expect(screen.queryByText("Login cancelled.")).toBeNull();
      expect(refresh).not.toHaveBeenCalled();
      click("Manage Anthropic");
      expect(
        screen.getByRole("button", { name: "Claude authorization" }),
      ).toBeEnabled();
    },
  );
});
