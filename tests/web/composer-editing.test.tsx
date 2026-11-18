// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Composer } from "../../src/components/Composer";
import { store } from "../../src/store";
import { createComposerFixture, typeDraft } from "./fixtures/composer";
import { activeSnapshot, deferred, FakeWebSocket } from "./helpers";

let host: Awaited<ReturnType<typeof createComposerFixture>>;
beforeEach(async () => {
  host = await createComposerFixture();
});
afterEach(() => vi.unstubAllGlobals());

it("retains the editor across a streamed leaf and recalls material under the current leaf", async () => {
  const releaseHistory = deferred<void>();
  host.historyGate = releaseHistory.promise;
  host.historyEntries = [
    {
      text: "",
      images: [
        {
          reference: "pi-history-image://entry-4/1",
          mimeType: "image/png",
          size: 7,
        },
      ],
      files: [
        {
          reference: "pi-history-file://entry-4/0",
          fileName: "report.pdf",
          kind: "attachment",
        },
        {
          reference: "pi-history-file://entry-4/1",
          fileName: "source.ts",
          kind: "project",
        },
      ],
    },
    { text: "older saved prompt", images: [], files: [] },
  ];
  const socket = FakeWebSocket.instances.at(-1)!;
  const stream = (leaf: string, revision: number) =>
    act(() =>
      socket.emitSnapshot(
        activeSnapshot({
          isStreaming: true,
          durableLeafId: leaf,
          effectiveLeafId: leaf,
          transcriptPage: {
            effectiveLeafId: leaf,
            revision,
            appendFromRevision: 10,
          },
        }),
      ),
    );
  stream("leaf-a", 10);
  render(<Composer />);
  const input = screen.getByRole<HTMLTextAreaElement>("textbox", {
    name: "Message",
  });
  typeDraft("current draft");
  input.focus();
  input.setSelectionRange(2, 6, "backward");
  await waitFor(() => expect(host.historyRequests).toBe(1));
  stream("leaf-b", 11);
  expect(host.historyRequests).toBe(1);
  expect(screen.getByRole("textbox", { name: "Message" })).toBe(input);
  expect([
    input.selectionStart,
    input.selectionEnd,
    input.selectionDirection,
  ]).toEqual([2, 6, "backward"]);
  await act(async () => releaseHistory.resolve());
  host.historyGate = null;
  input.setSelectionRange(0, 0);
  const press = (key: string) => fireEvent.keyDown(input, { key });
  press("ArrowUp");
  expect(input).toHaveValue("");
  expect(store.drafts.get("s1").text).toBe("current draft");
  press("ArrowUp");
  expect(input).toHaveValue("older saved prompt");
  press("ArrowDown");
  expect(input).toHaveValue("");
  press("ArrowDown");
  expect(input.selectionStart).toBe(0);
  press("ArrowUp");
  const send =
    screen.queryByRole("button", { name: "Send as steer" }) ??
    screen.getByRole("button", { name: "Send message" });
  fireEvent.click(send);
  await waitFor(() =>
    expect(host.promptBodies.at(-1)).toMatchObject({
      sessionId: "s1",
      message: "",
      historyArtifacts: {
        viewId: "view-s1",
        incarnation: "projection-1",
        effectiveLeafId: "leaf-b",
        imageReferences: ["pi-history-image://entry-4/1"],
        fileReferences: [
          "pi-history-file://entry-4/0",
          "pi-history-file://entry-4/1",
        ],
      },
    }),
  );
});

it("dispatches only the configured desktop send chord and disables proofing marks", async () => {
  render(<Composer />);
  const input = screen.getByRole("textbox", { name: "Message" });
  expect(input).toHaveAttribute("spellcheck", "false");
  expect(input).toHaveAttribute("autocorrect", "off");
  const enter = (modifiers: Partial<KeyboardEvent> = {}) =>
    fireEvent.keyDown(input, { key: "Enter", ...modifiers });
  const send = async (message: string, modifiers?: Partial<KeyboardEvent>) => {
    expect(enter(modifiers)).toBe(false);
    await waitFor(() =>
      expect(host.promptBodies.at(-1)).toMatchObject({ message }),
    );
    expect(input).toHaveValue("");
  };
  typeDraft("ordinary Enter");
  for (const modifiers of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
  ])
    expect(enter(modifiers)).toBe(true);
  expect(host.promptBodies).toEqual([]);
  await send("ordinary Enter");

  act(() => store.setPreference("desktopSendKey", "mod-enter"));
  await waitFor(() =>
    expect(store.getState().prefs.desktopSendKey).toBe("mod-enter"),
  );
  typeDraft("Control sends");
  expect(enter()).toBe(true);
  expect(enter({ ctrlKey: true, keyCode: 229 })).toBe(true);
  expect(host.promptBodies).toHaveLength(1);
  await send("Control sends", { ctrlKey: true });
  typeDraft("Command sends");
  await send("Command sends", { metaKey: true });
});
