import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { emptyToolPresentationConfiguration } from "../../shared/tool-presentation-config";
import { ExtensionDialogContent } from "../../src/components/ExtensionDialogContent";
import { ExtensionStatus } from "../../src/components/ExtensionDisplays";
import { configurePresentationAdapters } from "../../src/presentation-adapters";
import { store } from "../../src/store";
import {
  activeSnapshot,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  selectSession,
} from "./helpers";
import { baseRoutes } from "./store-fixture";

afterEach(() => {
  configurePresentationAdapters(emptyToolPresentationConfiguration());
});

it("keeps machine status out of the header and scopes expanded status to its session", async () => {
  installFakeWebSocket();
  installFetch(baseRoutes);
  await act(async () => store.init());
  const socket = FakeWebSocket.instances.at(-1)!;
  socket.join(activeSnapshot());
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
  render(<ExtensionStatus />);
  const publishStatus = (extensionStatuses: Record<string, string>) =>
    act(() =>
      socket.emit({
        type: "extension_ui_request",
        sessionId: "s1",
        id: "status",
        method: "setStatus",
        extensionStatuses,
      }),
    );

  publishStatus({ usage: "5h 12%", "example:tier": '{"tier":"fast"}' });
  expect(screen.getByText("5h 12%", { exact: true })).toBeVisible();
  publishStatus({ usage: "5h 12%", "example:tier": "Fast tier\nSecond line" });
  fireEvent.click(screen.getByRole("button", { name: "Extension status" }));
  const status = screen.getByRole("dialog", { name: "Extension status" });
  expect(status).toHaveTextContent("Fast tier Second line");

  await selectSession(store, {
    ...activeSnapshot({ sessionId: "s2" }),
    extensionStatuses: { status: "Other session\nSecond line" },
  });
  expect(screen.queryByRole("dialog", { name: "Extension status" })).toBeNull();
  expect(screen.getByText("Other session Second line")).toBeVisible();
});

it("returns editor changes to its caller and submits the caller's current value", () => {
  const change = vi.fn();
  const respond = vi.fn();
  const editor = (value: string) => (
    <ExtensionDialogContent
      request={{ sessionId: "demo", id: "notes", method: "editor" }}
      value={value}
      onValueChange={change}
      pending={false}
      onRespond={respond}
      onCancel={vi.fn()}
    />
  );
  const { rerender } = render(editor("Original"));
  fireEvent.change(screen.getByRole("textbox"), {
    target: { value: "Edited" },
  });
  expect(change).toHaveBeenCalledWith("Edited");
  rerender(editor("Reset by caller"));
  expect(screen.getByRole("textbox")).toHaveValue("Reset by caller");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(respond).toHaveBeenCalledWith({
    id: "notes",
    value: "Reset by caller",
  });
});
