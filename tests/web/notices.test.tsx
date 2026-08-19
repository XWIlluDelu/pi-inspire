// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../src/App";
import { store } from "../../src/store";
import {
  FakeWebSocket,
  bootstrapPayload,
  installFakeWebSocket,
  installFetch,
} from "./helpers";

describe("right-corner notices", () => {
  const writeText = vi.fn(async () => undefined);

  beforeEach(async () => {
    writeText.mockClear();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    installFakeWebSocket();
    installFetch((url) => {
      if (url.startsWith("/api/bootstrap")) {
        return {
          body: bootstrapPayload({
            snapshot: { active: null, runState: "idle", sessionStatuses: {} },
          }),
        };
      }
      if (url.startsWith("/api/sessions"))
        return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
      return undefined;
    });
    await store.init("token");
  });

  it("copies visible warning and error text, but keeps informational notices compact", async () => {
    render(<App />);
    const socket = FakeWebSocket.instances.at(-1)!;
    socket.emit({
      type: "extension_ui_request",
      id: "warn-1",
      method: "notify",
      notifyType: "warning",
      message: "(fff): cwd is too large\nSet FFF_ENABLE_HOME_SCAN=0",
    });
    socket.emit({
      type: "extension_error",
      extensionPath: "ext/example.ts",
      event: "tool_call",
      error: "boom",
    });
    socket.emit({
      type: "extension_ui_request",
      id: "info-1",
      method: "notify",
      message: "Indexing finished",
    });

    const warningCopy = await screen.findByRole("button", {
      name: "Copy warning",
    });
    expect(screen.getByRole("button", { name: "Copy error" })).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Copy information" }),
    ).not.toBeInTheDocument();

    fireEvent.click(warningCopy);
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        "(fff): cwd is too large\nSet FFF_ENABLE_HOME_SCAN=0",
      ),
    );
    expect(
      screen.getByRole("button", { name: "Warning copied" }),
    ).toBeVisible();
  });
});
