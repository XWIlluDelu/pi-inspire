// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { App } from "../../src/App";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  sessionSummary,
} from "./helpers";

const sessions = [sessionSummary({ title: "Test session" })];
let renameBodies: Record<string, unknown>[] = [];

beforeEach(async () => {
  renameBodies = [];
  installFakeWebSocket();
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap")) {
      return {
        body: bootstrapPayload({
          snapshot: activeSnapshot({
            pageMessages: [
              { role: "user", content: "First prompt", timestamp: 1 },
            ],
          }),
        }),
      };
    }
    if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
    if (url.startsWith("/api/sessions/rename")) {
      renameBodies.push(jsonBody(init));
      return { body: { ok: true } };
    }
    if (url.startsWith("/api/sessions")) {
      return {
        body: { sessions, total: sessions.length, offset: 0, limit: 40 },
      };
    }
    if (url.startsWith("/api/extension-ui")) return { body: { ok: true } };
    if (url.startsWith("/api/preferences")) return { body: jsonBody(init) };
    if (url.startsWith("/api/git/status")) {
      return { body: { kind: "not-repository" } };
    }
    if (url.startsWith("/api/control/abort")) return { body: { ok: true } };
    return undefined;
  });
  await act(async () => store.init("token"));
  FakeWebSocket.instances.at(-1)?.open();
  await waitFor(() => expect(store.getState().sessionId).toBe("s1"));
});

afterEach(() => cleanup());

async function openPalette() {
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  return screen.findByRole("dialog", { name: "Command palette" });
}

describe("overlay ownership", () => {
  it("does not open the palette through Settings", async () => {
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const settings = await screen.findByRole("dialog", { name: "Settings" });

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).not.toBeInTheDocument();

    fireEvent.keyDown(settings, { key: "Escape" });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Settings" })).toBeNull(),
    );
  });

  it("lets an extension dialog supersede and exclude the palette", async () => {
    render(<App />);
    await openPalette();

    act(() =>
      FakeWebSocket.instances.at(-1)?.emit({
        type: "extension_ui_request",
        sessionId: "s1",
        id: "extension-choice",
        method: "select",
        title: "Choose output",
        options: ["a"],
      }),
    );
    await screen.findByRole("dialog", { name: "Choose output" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Command palette" }),
      ).toBeNull(),
    );

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      screen.queryByRole("dialog", { name: "Command palette" }),
    ).not.toBeInTheDocument();
  });

  it("closes the palette when Escape is pressed from an option", async () => {
    render(<App />);
    await openPalette();
    const option = screen.getByRole("option", { name: /New session/ });
    option.focus();

    fireEvent.keyDown(option, { key: "Escape" });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Command palette" }),
      ).toBeNull(),
    );
  });
});

describe("command palette rename", () => {
  it("keeps filtering separate from the prefilled rename value", async () => {
    render(<App />);
    await openPalette();
    const filter = screen.getByLabelText("Filter commands");
    fireEvent.change(filter, { target: { value: "rename" } });
    fireEvent.click(screen.getByRole("option", { name: /Rename session/ }));

    const rename = screen.getByLabelText("New session name");
    expect(rename).toHaveValue("Test session");
    fireEvent.keyDown(rename, { key: "Escape" });
    expect(screen.getByLabelText("Filter commands")).toHaveValue("rename");

    fireEvent.click(screen.getByRole("option", { name: /Rename session/ }));
    fireEvent.keyDown(screen.getByLabelText("New session name"), {
      key: "Enter",
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Command palette" }),
      ).toBeNull(),
    );
    expect(renameBodies).toEqual([]);
  });
});
