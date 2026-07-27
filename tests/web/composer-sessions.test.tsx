// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { Composer } from "../../src/components/Composer";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
} from "./helpers";

let promptGate: Promise<void> | null = null;
let promptsSettled = 0;

beforeAll(async () => {
  installFakeWebSocket();
  installFetch(async (url) => {
    if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
    if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
    if (url.startsWith("/api/files")) {
      const session = /sessionId=([^&]*)/.exec(url)?.[1] ?? "";
      return { body: { files: [{ path: `${session}/only.ts`, name: "only.ts" }] } };
    }
    if (url.startsWith("/api/sessions")) return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
    if (url.startsWith("/api/prompt")) {
      if (promptGate) await promptGate;
      promptsSettled += 1;
      return { status: 202, body: { accepted: true } };
    }
    return undefined;
  });
  await store.init("token");
  FakeWebSocket.instances.at(-1)?.open();
});

describe("composer drafts across sessions", () => {
  it("a slow send from session A cannot clear session B's visible draft", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("Message");
    fireEvent.change(textarea, { target: { value: "message for A" } });

    let release!: () => void;
    promptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    // Switch to session B while A's send is still in flight; draft a message.
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({ sessionId: "s2", sessionName: "Session B" }),
      });
    });
    fireEvent.change(textarea, { target: { value: "draft for B" } });

    release();
    await waitFor(() => expect(promptsSettled).toBe(1));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    // The settled send consumed A's draft without touching B's visible one.
    expect(screen.getByLabelText("Message")).toHaveValue("draft for B");

    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({ type: "snapshot", data: activeSnapshot() });
    });
    expect(screen.getByLabelText("Message")).toHaveValue("");
  });

  it("keeps text typed during an in-flight send instead of clearing it", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("Message");
    fireEvent.change(textarea, { target: { value: "first message" } });

    let release!: () => void;
    promptGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const settledBefore = promptsSettled;
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    // The textarea stays editable during delivery; the user types the next
    // message before the send settles.
    fireEvent.change(textarea, { target: { value: "second message" } });

    release();
    await waitFor(() => expect(promptsSettled).toBe(settledBefore + 1));
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
    // The newer draft survives: only an unchanged sent draft is cleared.
    expect(screen.getByLabelText("Message")).toHaveValue("second message");
  });
});

describe("project file picker scoping", () => {
  it("clears and re-scopes results when the session changes", async () => {
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({ type: "snapshot", data: activeSnapshot({ sessionId: "sA" }) });
    });
    render(<Composer />);
    fireEvent.click(screen.getByRole("button", { name: "Add project files" }));
    fireEvent.change(screen.getByLabelText("Search project files"), { target: { value: "only" } });
    // Session A's path appears.
    await screen.findByRole("option", { name: /sA\/only\.ts/ });

    // Switching to B clears A's results immediately, then lists B's own.
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({ sessionId: "sB", sessionName: "B" }),
      });
    });
    expect(screen.queryByRole("option", { name: /sA\/only\.ts/ })).not.toBeInTheDocument();
    await screen.findByRole("option", { name: /sB\/only\.ts/ });
  });
});
