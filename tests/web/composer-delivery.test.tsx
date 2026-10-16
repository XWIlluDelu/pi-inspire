// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/components/Composer";
import { store } from "../../src/store";
import {
  attachFile,
  createComposerFixture,
  typeDraft,
} from "./fixtures/composer";
import {
  activeSnapshot,
  deferred,
  FakeWebSocket,
  type RouteResponse,
} from "./helpers";

let host: Awaited<ReturnType<typeof createComposerFixture>>;
beforeEach(async () => {
  host = await createComposerFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("composer delivery and artifacts", () => {
  it("uploads a selected file and sends its attachment id, then clears on accept", async () => {
    render(<Composer />);
    await attachFile();
    const attachment = (await screen.findByText("notes.txt")).closest("li");
    expect(attachment).toHaveAttribute("title", "notes.txt\ntext/plain · 5 B");

    typeDraft("check this");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(host.promptBodies.length).toBeGreaterThan(0));
    expect(host.promptBodies.at(-1)).toMatchObject({
      message: "check this",
      attachmentIds: ["att-1"],
    });
    // accepted submission clears the draft and attachments
    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
  });

  it("does not clear a later matching draft when an earlier handed-off receipt arrives", async () => {
    const first = deferred<RouteResponse>();
    host.promptGates.push(first.promise);
    render(<Composer />);

    typeDraft("same text");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() =>
      expect(host.promptBodies.at(-1)?.message).toBe("same text"),
    );
    expect(screen.getByLabelText("Message")).toHaveValue("");

    typeDraft("same text");
    await act(async () => {
      first.resolve({ status: 202, body: { accepted: true } });
      await first.promise;
    });
    await waitFor(() => expect(store.getState().sending).toBe(false));
    expect(screen.getByLabelText("Message")).toHaveValue("same text");
  });

  it("shows a failed delivery immediately without replacing a newer draft", async () => {
    const first = deferred<RouteResponse>();
    host.promptGates.push(first.promise);
    render(<Composer />);
    typeDraft("first delivery");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    typeDraft("newer draft");
    await act(async () => {
      first.resolve({ status: 400, body: { error: "Not delivered" } });
      await first.promise;
    });
    await waitFor(() => expect(store.getState().sending).toBe(false));
    expect(screen.getByText("Message not delivered")).toBeInTheDocument();
    expect(screen.getByLabelText("Message")).toHaveValue("newer draft");
    expect(screen.getByRole("button", { name: "Restore" })).toBeDisabled();
    typeDraft("");
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByLabelText("Message")).toHaveValue("first delivery");
    expect(screen.queryByText("Message not delivered")).not.toBeInTheDocument();
  });

  it("allows successive attachment-only and repeated project-only submissions", async () => {
    render(<Composer />);
    const before = host.promptBodies.length;

    await attachFile("first.txt");
    await screen.findByText("notes.txt");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(host.promptBodies.length).toBe(before + 1));
    await waitFor(() =>
      expect(screen.queryByText("notes.txt")).not.toBeInTheDocument(),
    );

    await attachFile("second.txt");
    await screen.findByText("notes.txt");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    await waitFor(() => expect(host.promptBodies.length).toBe(before + 2));
    expect(host.promptBodies.slice(before)).toEqual([
      expect.objectContaining({ message: "", attachmentIds: ["att-1"] }),
      expect.objectContaining({ message: "", attachmentIds: ["att-1"] }),
    ]);

    for (let index = 0; index < 2; index++) {
      await waitFor(() => expect(store.getState().sending).toBe(false));
      act(() => store.addProjectFile("src/repeated.ts"));
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(host.promptBodies.length).toBe(before + 3 + index),
      );
      expect(host.promptBodies.at(-1)).toMatchObject({
        message: "",
        projectFiles: ["src/repeated.ts"],
      });
    }
  });

  it("retains the draft and attachments when submission fails", async () => {
    host.promptFails = true;
    render(<Composer />);
    await attachFile();
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    typeDraft("keep me");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(store.getState().notices.at(-1)?.text).toBe("boom"),
    );
    expect(store.getState().error).toBeNull();
    expect(screen.getByLabelText("Message")).toHaveValue("keep me");
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    host.promptFails = false;
  });

  it("a slow send from session A cannot clear session B's visible draft", async () => {
    render(<Composer />);
    const textarea = screen.getByLabelText("Message");
    fireEvent.change(textarea, { target: { value: "message for A" } });
    act(() => store.addProjectFile("src/a.ts"));

    const response = deferred<RouteResponse>();
    host.promptGates.push(response.promise);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(host.promptBodies.at(-1)).toMatchObject({
        sessionId: "s1",
        message: "message for A",
        projectFiles: ["src/a.ts"],
      }),
    );
    expect(store.getState().sending).toBe(true);
    expect(textarea).toHaveValue("");

    // Switch to session B while A's send is still in flight; draft a message.
    act(() => {
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({ sessionId: "s2", sessionName: "Session B" }),
      });
    });
    expect(store.getState().sessionId).toBe("s2");
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "draft for B" },
    });
    act(() => store.addProjectFile("src/b.ts"));

    await act(async () =>
      response.resolve({ status: 202, body: { accepted: true } }),
    );
    await waitFor(() => expect(store.getState().sessionId).toBe("s2"));
    await waitFor(() => expect(store.getState().sending).toBe(false));
    // The settled send consumed A's draft without touching B's visible one.
    expect(screen.getByLabelText("Message")).toHaveValue("draft for B");
    expect(
      screen.getByRole("button", { name: "Remove src/b.ts" }),
    ).toBeEnabled();

    act(() => {
      FakeWebSocket.instances
        .at(-1)!
        .emit({ type: "snapshot", data: activeSnapshot() });
    });
    await waitFor(() => expect(store.getState().sending).toBe(false));
    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(store.getState().projectFiles).toEqual([]);
    act(() =>
      FakeWebSocket.instances.at(-1)!.emit({
        type: "snapshot",
        data: activeSnapshot({ sessionId: "s2", sessionName: "Session B" }),
      }),
    );
    expect(screen.getByLabelText("Message")).toHaveValue("draft for B");
    expect(store.getState().projectFiles).toEqual(["src/b.ts"]);
  });
  it("hands off only the delivered canonical paths and preserves new editable chips", async () => {
    render(<Composer />);
    act(() => store.addProjectFile("src/owned.ts"));
    fireEvent.change(screen.getByLabelText("Message"), {
      target: { value: "send with file" },
    });
    const response = deferred<RouteResponse>();
    host.promptGates.push(response.promise);
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(store.getState().sending).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Remove src/owned.ts" }),
    ).not.toBeInTheDocument();
    expect(host.promptBodies.at(-1)?.projectFiles).toEqual(["src/owned.ts"]);

    act(() => {
      store.removeProjectFile("src/owned.ts");
      store.addProjectFile("src/racing.ts");
    });
    expect(store.getState().projectFiles).toEqual(["src/racing.ts"]);
    expect(
      screen.getByRole("button", { name: "Remove src/racing.ts" }),
    ).toBeEnabled();

    await act(async () =>
      response.resolve({ status: 202, body: { accepted: true } }),
    );
    await waitFor(() => expect(store.getState().sending).toBe(false));
    expect(store.getState().projectFiles).toEqual(["src/racing.ts"]);
    expect(host.promptBodies.at(-1)?.projectFiles).toEqual(["src/owned.ts"]);
    act(() => store.removeProjectFile("src/racing.ts"));
  });
});
