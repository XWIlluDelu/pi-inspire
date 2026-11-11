import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import { ExtensionStatus } from "../../src/components/ExtensionDisplays";
import { ExtensionUiDialog } from "../../src/components/ExtensionUiDialog";
import { configurePresentationAdapters } from "../../src/presentation-adapters";
import { store } from "../../src/store";
import {
  activeSnapshot,
  deferred,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
} from "./helpers";
import { baseRoutes } from "./store-fixture";

let response: ReturnType<typeof deferred<{ body: { ok: boolean } }>>;

beforeEach(async () => {
  response = deferred();
  installFakeWebSocket();
  installFetch((url, init) =>
    url === "/api/extension-ui" ? response.promise : baseRoutes(url, init),
  );
  await act(async () => store.init());
  FakeWebSocket.instances.at(-1)?.open();
});

afterEach(() => {
  vi.useRealTimers();
  configurePresentationAdapters(emptyToolPresentationConfiguration());
});

function emit(event: Record<string, unknown>) {
  act(() =>
    FakeWebSocket.instances.at(-1)!.emit({ sessionId: "s1", ...event }),
  );
}

function request(fields: Record<string, unknown>) {
  emit({ type: "extension_ui_request", ...fields });
}

it.each([
  { method: "select", delayed: true, focus: "Next choice" },
  { method: "confirm", delayed: true, focus: "Yes" },
  { method: "confirm", delayed: false, focus: "Yes" },
])(
  "focuses the next $method request across acknowledgement handoff (delayed=$delayed)",
  async ({ method, delayed, focus }) => {
    render(<ExtensionUiDialog />);
    request({
      id: "previous",
      method: "select",
      title: "Previous",
      options: ["Continue"],
    });
    fireEvent.click(screen.getByRole("option", { name: "Continue" }));
    const acknowledge = () =>
      act(async () => response.resolve({ body: { ok: true } }));
    if (!delayed) await acknowledge();

    const next = {
      id: "next",
      method,
      title: "Next",
      options: ["Next choice"],
    };
    request(next);
    emit({ type: "extension_ui_remove", id: "previous", reason: "answered" });
    const dialog = screen.getByRole("dialog", { name: "Next" });
    if (delayed) {
      expect(dialog).toHaveFocus();
      expect(dialog).toHaveAttribute("aria-busy", "true");
      await acknowledge();
    }
    await waitFor(() =>
      expect(
        within(dialog).getByRole(method === "select" ? "option" : "button", {
          name: focus,
        }),
      ).toHaveFocus(),
    );
    if (method === "confirm") {
      const no = within(dialog).getByRole("button", { name: "No" });
      no.focus();
      request({ ...next, title: "Updated question" });
      expect(no).toHaveFocus();
    }
  },
);

it("counts down the absolute deadline and leaves an untimed request without a countdown", () => {
  vi.useFakeTimers();
  render(<ExtensionUiDialog />);
  request({
    id: "timed",
    method: "input",
    title: "Timed",
    expiresAt: Date.now() + 10_000,
  });
  expect(screen.getByText("10s remaining")).toBeVisible();
  act(() => vi.advanceTimersByTime(3_000));
  expect(screen.getByText("7s remaining")).toBeVisible();
  emit({ type: "extension_ui_remove", id: "timed", reason: "answered" });
  request({ id: "untimed", method: "input", title: "Untimed" });
  expect(screen.queryByText(/remaining/)).toBeNull();
});

it("keeps machine status out of the header and scopes expanded status to its session", () => {
  configurePresentationAdapters({
    ...emptyToolPresentationConfiguration(),
    controls: [
      {
        id: "user.example.tier",
        slot: "thinking",
        label: "Tier",
        command: "/tier",
        state: { key: "example:tier", value: "tier" },
        options: [{ value: "fast", label: "Fast" }],
      },
    ],
  });
  const { container } = render(<ExtensionStatus />);
  const publishStatus = (extensionStatuses: Record<string, string>) =>
    request({ id: "status", method: "setStatus", extensionStatuses });

  publishStatus({ usage: "5h 12%", "example:tier": '{"tier":"fast"}' });
  expect(container).toHaveTextContent(/^5h 12%$/);
  publishStatus({ usage: "5h 12%", "example:tier": "Fast tier\nSecond line" });
  fireEvent.click(screen.getByRole("button", { name: "Extension status" }));
  const status = screen.getByRole("dialog", { name: "Extension status" });
  expect(
    within(status)
      .getAllByRole("paragraph")
      .map((line) => line.textContent),
  ).toEqual(["Fast tier\nSecond line", "5h 12%"]);

  emit({
    type: "snapshot",
    data: {
      ...activeSnapshot({ sessionId: "s2" }),
      extensionStatuses: { status: "Other session\nSecond line" },
    },
  });
  expect(screen.queryByRole("dialog", { name: "Extension status" })).toBeNull();
  expect(container).toHaveTextContent("Other session");
});
