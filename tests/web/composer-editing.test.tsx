// @vitest-environment jsdom
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Composer } from "../../src/components/Composer";
import { ComposerInput } from "../../src/components/ComposerInput";
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
        socket.emit({
          type: "snapshot",
          data: activeSnapshot({
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
        }),
      );

      render(<Composer />);
      const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
      typeDraft("compose while the session runs");
      textarea.focus();
      textarea.setSelectionRange(8, 13);

      act(() =>
        socket.emit({
          type: "snapshot",
          data: activeSnapshot({
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
        }),
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
        socket.emit({
          type: "snapshot",
          data: activeSnapshot({
            transcriptPage: {
              viewId: "image-history-view",
              incarnation: "image-history-projection",
              effectiveLeafId: "image-history-leaf",
            },
          }),
        }),
      );

      render(<Composer />);
      await waitFor(() =>
        expect(host.historyRequests).toBeGreaterThan(requestsBefore),
      );
      const hydratedRequests = host.historyRequests;
      for (let index = 1; index <= 20; index += 1) {
        await act(async () => {
          socket.emit({
            type: "snapshot",
            data: activeSnapshot({
              transcriptPage: {
                viewId: "image-history-view",
                incarnation: "image-history-projection",
                effectiveLeafId: `assistant-leaf-${index}`,
                revision: index + 1,
              },
            }),
          });
        });
      }
      expect(host.historyRequests).toBe(hydratedRequests);
      await act(async () => {
        historyResponse.resolve();
      });
      host.historyGate = null;
      await attachFile();
      expect(await screen.findByText("notes.txt")).toBeInTheDocument();
      const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(
        await screen.findByRole("button", { name: "Remove attached image" }),
      ).toBeInTheDocument();
      expect(screen.getByText("report.pdf")).toBeInTheDocument();
      expect(screen.getByText("source.ts")).toBeInTheDocument();
      expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();

      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      await waitFor(() => expect(textarea).toHaveValue(""));
      expect(screen.getByText("notes.txt")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Remove attached image" }),
      ).not.toBeInTheDocument();

      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(
        await screen.findByRole("button", { name: "Remove attached image" }),
      ).toBeInTheDocument();
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
            effectiveLeafId: "assistant-leaf-20",
            imageReferences: ["pi-history-image://entry-4/1"],
            fileReferences: [
              "pi-history-file://entry-4/0",
              "pi-history-file://entry-4/1",
            ],
          },
        }),
      );
      host.historyEntries = [
        { text: "new user prompt", images: [], files: [] },
      ];
      await act(async () => {
        socket.emit({
          type: "snapshot",
          data: activeSnapshot({
            transcriptPage: {
              viewId: "image-history-view",
              incarnation: "image-history-projection",
              effectiveLeafId: "new-user-leaf",
              revision: 22,
              composerHistoryVersion: "history-2",
            },
          }),
        });
      });
      expect(host.historyRequests).toBe(hydratedRequests + 1);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() => expect(textarea).toHaveValue("new user prompt"));
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

      act(() => store.setDesktopSendKey("mod-enter"));
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

  it("subtracts composer controls from the visual viewport when the keyboard leaves main layout tall", async () => {
    const viewport = Object.assign(new EventTarget(), { height: 900 });
    vi.stubGlobal("visualViewport", viewport);
    vi.stubGlobal("innerHeight", 900);
    vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(1200);
    vi.spyOn(Element.prototype, "clientHeight", "get").mockImplementation(
      function (this: HTMLElement) {
        return Number.parseFloat(this.style.height) || 24;
      },
    );
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(
      function (this: HTMLElement) {
        const input = this.matches("textarea")
          ? this
          : this.querySelector<HTMLTextAreaElement>("textarea");
        const editor = Number.parseFloat(input?.style.height ?? "") || 24;
        const height = this.matches("main")
          ? 900
          : this.matches(".composer__toolbar")
            ? 80
            : this.matches(".composer-dock")
              ? editor + 120
              : this.matches(".composer")
                ? editor + 80
                : editor;
        return new DOMRect(0, 0, 800, height);
      },
    );
    function VisualViewportComposer() {
      const [sizeActionSlot, setSizeActionSlot] =
        useState<HTMLSpanElement | null>(null);
      return (
        <main>
          <div className="composer-dock">
            <div className="composer">
              <ComposerInput
                value={"long wrapped text\n".repeat(60)}
                onChange={vi.fn()}
                commands={[]}
                label="Message"
                placeholder="Message Pi…"
                sizeActionSlot={sizeActionSlot}
              />
              <div className="composer__toolbar">
                <span ref={setSizeActionSlot} />
              </div>
            </div>
          </div>
        </main>
      );
    }
    render(<VisualViewportComposer />);
    const input = screen.getByRole("textbox") as HTMLTextAreaElement;
    expect(input.style.height).toBe("360px");
    fireEvent.click(screen.getByRole("button", { name: "Expand editor" }));
    expect(input.style.height).toBe("716px");
    viewport.height = 400;
    viewport.dispatchEvent(new Event("resize"));
    await waitFor(() => expect(input.style.height).toBe("216px"));
    expect(screen.getByRole("main").getBoundingClientRect().height).toBe(900);
    expect(input.clientHeight + 120 + 64).toBeLessThanOrEqual(viewport.height);
    fireEvent.click(screen.getByRole("button", { name: "Collapse editor" }));
    expect(input.style.height).toBe("160px");
    expect(screen.getByRole("button", { name: "Expand editor" })).toBeVisible();
  });
});
