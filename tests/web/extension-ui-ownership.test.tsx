import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
} from "./helpers";
import { baseRoutes } from "./store-fixture";

beforeEach(async () => {
  installFakeWebSocket();
  installFetch(baseRoutes);
  await act(async () => store.init());
  FakeWebSocket.instances.at(-1)?.open();
});

afterEach(() => {
  configurePresentationAdapters(emptyToolPresentationConfiguration());
});

function emit(event: Record<string, unknown>) {
  act(() =>
    FakeWebSocket.instances.at(-1)!.emit({ sessionId: "s1", ...event }),
  );
}

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
  render(<ExtensionStatus />);
  const publishStatus = (extensionStatuses: Record<string, string>) =>
    emit({
      type: "extension_ui_request",
      id: "status",
      method: "setStatus",
      extensionStatuses,
    });

  publishStatus({ usage: "5h 12%", "example:tier": '{"tier":"fast"}' });
  expect(screen.getByText("5h 12%", { exact: true })).toBeVisible();
  publishStatus({ usage: "5h 12%", "example:tier": "Fast tier\nSecond line" });
  fireEvent.click(screen.getByRole("button", { name: "Extension status" }));
  const status = screen.getByRole("dialog", { name: "Extension status" });
  expect(within(status).getByText("Fast tier Second line")).toBeVisible();

  emit({
    type: "snapshot",
    data: {
      ...activeSnapshot({ sessionId: "s2" }),
      extensionStatuses: { status: "Other session\nSecond line" },
    },
  });
  expect(screen.queryByRole("dialog", { name: "Extension status" })).toBeNull();
  expect(screen.getByText("Other session Second line")).toBeVisible();
});

it("reuses controlled dialog content without a session store or transport", () => {
  const respond = vi.fn(),
    cancel = vi.fn();
  function Form({
    pending = false,
    error = null,
  }: {
    pending?: boolean;
    error?: string | null;
  }) {
    const [value, setValue] = useState("Original notes");
    return (
      <ExtensionDialogContent
        request={{
          sessionId: "example",
          id: "notes",
          method: "editor",
          title: "Task notes",
        }}
        value={value}
        pending={pending}
        error={error}
        onValueChange={setValue}
        onRespond={respond}
        onCancel={cancel}
      />
    );
  }
  const view = render(<Form />);
  fireEvent.change(screen.getByRole("textbox", { name: "Task notes" }), {
    target: { value: "Changed notes" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(respond).toHaveBeenCalledWith({ id: "notes", value: "Changed notes" });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  expect(cancel).toHaveBeenCalledOnce();
  view.rerender(<Form pending error="Please retry" />);
  expect(screen.getByRole("textbox")).toHaveValue("Changed notes");
  expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
  expect(screen.getByRole("alert")).toHaveTextContent("Please retry");
});
