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

    it("browses Pi prompt history at visual-line boundaries and restores the draft", async () => {
      host.historyEntries = [
        { text: "latest prompt", images: [], files: [] },
        { text: "older prompt", images: [], files: [] },
      ];
      const requestsBefore = host.historyRequests;
      const socket = FakeWebSocket.instances.at(-1)!;
      act(() =>
        socket.emit({
          type: "snapshot",
          data: activeSnapshot({
            transcriptPage: {
              viewId: "history-view",
              incarnation: "history-projection",
            },
          }),
        }),
      );

      render(<Composer />);
      await waitFor(() =>
        expect(host.historyRequests).toBeGreaterThan(requestsBefore),
      );
      const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
      typeDraft("working draft");
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);

      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      expect(textarea).toHaveValue("working draft");
      expect(textarea.selectionStart).toBe(0);
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() => expect(textarea).toHaveValue("latest prompt"));
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() => expect(textarea).toHaveValue("older prompt"));
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      await waitFor(() => expect(textarea).toHaveValue("latest prompt"));
      fireEvent.keyDown(textarea, { key: "ArrowDown" });
      await waitFor(() => expect(textarea).toHaveValue("working draft"));

      typeDraft("newly sent prompt");
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() => expect(textarea).toHaveValue(""));
      fireEvent.keyDown(textarea, { key: "ArrowUp" });
      await waitFor(() => expect(textarea).toHaveValue("newly sent prompt"));
    });

    it("reuses history across assistant leaves and recalls artifacts under the current leaf", async () => {
      const historyResponse = deferred<void>();
      host.historyGate = historyResponse.promise;
      host.historyEntries = [
        {
          text: "",
          images: [
            {
              reference: "pi-embedded://4/1",
              mimeType: "image/png",
              size: 7,
            },
          ],
          files: [
            {
              reference: "pi-file://4/0",
              fileName: "report.pdf",
              kind: "attachment",
            },
            {
              reference: "pi-file://4/1",
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
      fireEvent.click(screen.getByRole("button", { name: "Send message" }));
      await waitFor(() =>
        expect(host.promptBodies.at(-1)).toMatchObject({
          sessionId: "s1",
          message: "",
          historyArtifacts: {
            viewId: "image-history-view",
            incarnation: "image-history-projection",
            effectiveLeafId: "assistant-leaf-20",
            imageReferences: ["pi-embedded://4/1"],
            fileReferences: ["pi-file://4/0", "pi-file://4/1"],
          },
        }),
      );
      await waitFor(() => expect(store.getState().sending).toBe(false));
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

    it("keeps software-keyboard Return as a line break on touch-first devices", async () => {
      const socket = FakeWebSocket.instances.at(-1)!;
      act(() => socket.emit({ type: "snapshot", data: activeSnapshot() }));
      const originalMatchMedia = window.matchMedia;
      Object.defineProperty(window, "matchMedia", {
        configurable: true,
        value: (query: string) => ({
          matches: query === "(hover: none) and (pointer: coarse)",
          media: query,
          onchange: null,
          addListener: () => {},
          removeListener: () => {},
          addEventListener: () => {},
          removeEventListener: () => {},
          dispatchEvent: () => false,
        }),
      });

      try {
        const promptsBefore = host.promptBodies.length;
        render(<Composer />);
        const textarea = screen.getByLabelText("Message");
        typeDraft("first line");
        expect(fireEvent.keyDown(textarea, { key: "Enter" })).toBe(true);
        expect(
          fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true }),
        ).toBe(true);
        expect(
          fireEvent.keyDown(textarea, { key: "Enter", metaKey: true }),
        ).toBe(true);
        await act(async () => Promise.resolve());
        expect(host.promptBodies).toHaveLength(promptsBefore);

        typeDraft("first line\nsecond line");
        fireEvent.click(screen.getByRole("button", { name: "Send message" }));
        await waitFor(() =>
          expect(host.promptBodies.at(-1)).toMatchObject({
            message: "first line\nsecond line",
          }),
        );
      } finally {
        Object.defineProperty(window, "matchMedia", {
          configurable: true,
          value: originalMatchMedia,
        });
      }
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
          : this.matches(".composer-dock")
            ? editor + 120
            : this.matches(".composer")
              ? editor + 80
              : editor;
        return new DOMRect(0, 0, 800, height);
      },
    );
    render(
      <main>
        <div className="composer-dock">
          <div className="composer">
            <ComposerInput
              value={"long wrapped text\n".repeat(60)}
              onChange={vi.fn()}
              commands={[]}
              label="Message"
              placeholder="Message Pi…"
            />
          </div>
        </div>
      </main>,
    );
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
