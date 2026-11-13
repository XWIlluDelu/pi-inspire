// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/components/Composer";
import { store } from "../../src/store";
import {
  attachFile,
  createComposerFixture,
  typeDraft,
} from "./fixtures/composer";
import { activeSnapshot, deferred, FakeWebSocket } from "./helpers";

let host: Awaited<ReturnType<typeof createComposerFixture>>;
beforeEach(async () => {
  host = await createComposerFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Composer editing and keyboard behavior", () => {
  describe("composer editing and retained history", () => {
    it("preserves focus and selection while streamed activity advances the branch leaf", () => {
      host.historyEntries = [];
      const socket = FakeWebSocket.instances.at(-1)!;
      act(() =>
        socket.emitSnapshot(
          activeSnapshot({
            isStreaming: true,
            durableLeafId: "leaf-a",
            effectiveLeafId: "leaf-a",
            transcriptPage: {
              revision: 10,
              appendFromRevision: 10,
              viewId: "streaming-view",
              incarnation: "streaming-projection",
              effectiveLeafId: "leaf-a",
            },
          }),
        ),
      );

      render(<Composer />);
      const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
      typeDraft("compose while the session runs");
      textarea.focus();
      textarea.setSelectionRange(8, 13);

      act(() =>
        socket.emitSnapshot(
          activeSnapshot({
            isStreaming: true,
            durableLeafId: "leaf-b",
            effectiveLeafId: "leaf-b",
            transcriptPage: {
              revision: 11,
              appendFromRevision: 10,
              viewId: "streaming-view",
              incarnation: "streaming-projection",
              effectiveLeafId: "leaf-b",
            },
          }),
        ),
      );

      const current = screen.getByLabelText("Message") as HTMLTextAreaElement;
      expect(current).toBe(textarea);
      expect(document.activeElement).toBe(textarea);
      expect(textarea.selectionStart).toBe(8);
      expect(textarea.selectionEnd).toBe(13);
    });

    it("reuses history across assistant leaves and recalls artifacts under the current leaf", async () => {
      const historyResponse = deferred<void>();
      host.historyGate = historyResponse.promise;
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
      ];
      const requestsBefore = host.historyRequests;
      const socket = FakeWebSocket.instances.at(-1)!;
      act(() =>
        socket.emitSnapshot(
          activeSnapshot({
            transcriptPage: {
              viewId: "image-history-view",
              incarnation: "image-history-projection",
              effectiveLeafId: "image-history-leaf",
            },
          }),
        ),
      );

      render(<Composer />);
      typeDraft("current draft");
      await attachFile();
      fireEvent.click(screen.getByRole("button", { name: "Input history" }));
      await waitFor(() =>
        expect(host.historyRequests).toBeGreaterThan(requestsBefore),
      );
      const hydratedRequests = host.historyRequests;
      act(() =>
        socket.emitSnapshot(
          activeSnapshot({
            transcriptPage: {
              viewId: "image-history-view",
              incarnation: "image-history-projection",
              effectiveLeafId: "assistant-leaf",
              revision: 2,
              appendFromRevision: 1,
            },
          }),
          { detailSessionId: "s1", detailRevision: 0 },
        ),
      );
      expect(host.historyRequests).toBe(hydratedRequests);
      await act(async () => {
        historyResponse.resolve();
      });
      host.historyGate = null;
      const textarea = screen.getByLabelText("Message");
      const chooseArtifacts = async () => {
        const history = within(
          screen.getByRole("dialog", { name: "Input history" }),
        );
        fireEvent.click(
          await history.findByRole("radio", { name: /3 attachments/ }),
        );
        return history;
      };
      fireEvent.keyDown(textarea, { key: "ArrowUp", altKey: true });
      const staleHistory = await chooseArtifacts();
      typeDraft("newer draft");
      fireEvent.click(
        staleHistory.getByRole("button", { name: "Use this input" }),
      );
      expect(staleHistory.getByRole("alert")).toHaveTextContent(
        "The draft changed",
      );
      expect(textarea).toHaveValue("newer draft");
      expect(screen.getByText("notes.txt")).toBeInTheDocument();
      fireEvent.click(staleHistory.getByRole("button", { name: "Cancel" }));

      fireEvent.keyDown(textarea, { key: "ArrowUp", altKey: true });
      const currentHistory = await chooseArtifacts();
      fireEvent.click(
        currentHistory.getByRole("button", { name: "Use this input" }),
      );
      expect(textarea).toHaveValue("");
      expect(
        screen.getByRole("button", { name: "Remove attached image" }),
      ).toBeInTheDocument();
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
      expect(screen.getByText("source.ts")).toBeInTheDocument();
      expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
      await act(async () =>
        fireEvent.click(screen.getByRole("button", { name: "Send message" })),
      );
      await waitFor(() =>
        expect(host.promptBodies.at(-1)).toMatchObject({
          sessionId: "s1",
          message: "",
          historyArtifacts: {
            viewId: "image-history-view",
            incarnation: "image-history-projection",
            effectiveLeafId: "assistant-leaf",
            imageReferences: ["pi-history-image://entry-4/1"],
            fileReferences: [
              "pi-history-file://entry-4/0",
              "pi-history-file://entry-4/1",
            ],
          },
        }),
      );
    });

    it("dispatches only the selected desktop send chord", async () => {
      render(<Composer />);
      const textarea = screen.getByLabelText("Message");
      const press = (modifiers: Partial<KeyboardEvent> = {}) =>
        fireEvent.keyDown(textarea, { key: "Enter", ...modifiers });
      const send = async (
        message: string,
        modifiers?: Partial<KeyboardEvent>,
      ) => {
        expect(press(modifiers)).toBe(false);
        await waitFor(() => expect(textarea).toHaveValue(""));
        expect(host.promptBodies.at(-1)).toMatchObject({ message });
      };

      typeDraft("ordinary Enter");
      for (const modifiers of [
        { ctrlKey: true },
        { metaKey: true },
        { shiftKey: true },
        { altKey: true },
      ])
        expect(press(modifiers)).toBe(true);
      expect(host.promptBodies).toEqual([]);
      await send("ordinary Enter");

      act(() => store.setPreference("desktopSendKey", "mod-enter"));
      await waitFor(() =>
        expect(store.getState().prefs.desktopSendKey).toBe("mod-enter"),
      );
      typeDraft("Control sends");
      expect(press()).toBe(true);
      expect(press({ ctrlKey: true, keyCode: 229 })).toBe(true);
      expect(host.promptBodies).toHaveLength(1);
      await send("Control sends", { ctrlKey: true });
      typeDraft("Command sends");
      await send("Command sends", { metaKey: true });
    });
  });

  it("keeps browser proofing marks out of technical and mixed-language prompts", () => {
    render(<Composer />);
    const input = screen.getByLabelText("Message");
    expect(input).toHaveAttribute("spellcheck", "false");
    expect(input).toHaveAttribute("autocorrect", "off");
  });
});
