import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { expect, it } from "vitest";
import { TaskBoardAdapter } from "../../docs/examples/task-board/TaskBoardAdapter";
import { store } from "../../src/store";
import { createComposerFixture } from "./fixtures/composer";
import { activeSnapshot, FakeWebSocket, selectSession } from "./helpers";

it("runs Task Board actions from Pi inventory without consuming the draft or crossing sessions", async () => {
  const host = await act(createComposerFixture);
  await act(async () => {
    store.drafts.setText("s1", "UNFINISHED DRAFT");
    await store.composer.addFiles([
      new File(["draft"], "draft.txt", { type: "text/plain" }),
    ]);
  });
  const details = {
    version: 1,
    tasks: [
      {
        id: "task-1",
        name: "Review input",
        status: "running",
        summary: "Demo timer is running",
        details: "Local demo work",
        notes: "Saved notes",
        capabilities: { stop: true, retry: false, open: true },
      },
    ],
  };
  const message = {
    role: "custom",
    customType: "example-task-board",
    content: "Demo tasks",
    details,
  };
  const snapshot = (available: boolean) =>
    activeSnapshot({
      commands: [
        ...(available
          ? [{ name: "demo-tasks-stop", source: "extension" }]
          : []),
      ],
      pageMessages: [message],
    });
  act(() => FakeWebSocket.instances.at(-1)?.emitSnapshot(snapshot(false)));
  render(<TaskBoardAdapter />);
  fireEvent.click(screen.getByRole("button", { name: /Review input/ }));
  expect(screen.getByRole("button", { name: "Stop" })).toBeDisabled();
  act(() => FakeWebSocket.instances.at(-1)?.emitSnapshot(snapshot(true)));
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  await waitFor(() => expect(host.promptBodies).toHaveLength(1));
  expect(host.promptBodies[0]).toMatchObject({
    message: "/demo-tasks-stop task-1",
  });
  expect(host.promptBodies[0]).not.toHaveProperty("attachmentIds");
  expect(store.drafts.get("s1").text).toBe("UNFINISHED DRAFT");
  expect(
    store.drafts.get(store.getState().sessionId).attachments[0]?.uploadedId,
  ).toBe("att-1");
  await selectSession(store, activeSnapshot({ sessionId: "s2" }));
  expect(
    screen.queryByRole("button", { name: "Back to tasks" }),
  ).not.toBeInTheDocument();
  expect(screen.getByText(/No task snapshot is loaded/)).toBeInTheDocument();
});
