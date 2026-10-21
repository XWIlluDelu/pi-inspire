// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ATTACHMENT_CONTEXT_HEADING } from "../../shared/attachment-context";
import { Transcript } from "../../src/components/Transcript";
import { store } from "../../src/store";
import { captureClipboardSource } from "./fixtures/clipboard-source";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("message actions", () => {
  it("presents referenced filenames instead of transport instructions, and copies the exact source", async () => {
    const path =
      "/cache/123-1792213034751-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb-AGENTS 1.md";
    const source = `Inspect this\n\n${ATTACHMENT_CONTEXT_HEADING}\n- ${JSON.stringify(path)}\n- "/workspace/design.md"`;
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    render(
      <Transcript
        messages={[
          { role: "user", content: source, __inspireEntryId: "input-files" },
        ]}
        sessionId="s"
        viewId="v"
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(await screen.findByText("Inspect this")).toBeInTheDocument();
    const files = screen.getByRole("list", { name: "Referenced files" });
    expect(
      files.compareDocumentPosition(screen.getByText("Inspect this")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(files).getByText("AGENTS 1.md").closest("li"),
    ).toHaveAttribute("title", path);
    expect(within(files).getByText("design.md")).toBeInTheDocument();
    expect(
      screen.queryByText(ATTACHMENT_CONTEXT_HEADING),
    ).not.toBeInTheDocument();
    const search = screen.getByRole("searchbox", {
      name: "Search conversation",
    });
    fireEvent.change(search, { target: { value: "AGENTS" } });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("1 match");
    fireEvent.change(search, { target: { value: "JSON paths" } });
    expect(
      screen.getByLabelText("Transcript search matches"),
    ).toHaveTextContent("0 matches");
    fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(source));
    expect(
      screen.getByRole("button", { name: "Fork session from this input" }),
    ).toBeInTheDocument();
  });

  it("keeps a file-only user turn visible as an attachment", async () => {
    render(
      <Transcript
        messages={[
          {
            role: "user",
            content: `${ATTACHMENT_CONTEXT_HEADING}\n- "/workspace/report.pdf"`,
          },
        ]}
        sessionId="s"
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(
      await screen.findByRole("list", { name: "Referenced files" }),
    ).toHaveTextContent("report.pdf");
    expect(
      screen.queryByText(ATTACHMENT_CONTEXT_HEADING),
    ).not.toBeInTheDocument();
  });
  it.each([false, true])(
    "hides image dimension notes while keeping attachments and exact Copy (with files: %s)",
    async (withFiles) => {
      const sourceText = [
        "inspect",
        ...(withFiles
          ? [`${ATTACHMENT_CONTEXT_HEADING}\n- "/workspace/report.md"`]
          : []),
        "[Image: original 2560x133, displayed at 2000x104. Multiply coordinates by 1.28 to map to original image.]",
      ].join("\n\n");
      const { written } = captureClipboardSource();
      vi.spyOn(store, "loadEmbeddedImage").mockResolvedValue(
        new Blob(["png"], { type: "image/png" }),
      );
      render(
        <Transcript
          messages={[
            {
              role: "user",
              __inspireMessageIndex: 0,
              content: [
                { type: "text", text: sourceText },
                { type: "image", mimeType: "image/png" },
              ],
            },
          ]}
          sessionId="s"
          viewId="v"
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="collapsed"
        />,
      );
      expect(await screen.findByText("inspect")).toBeInTheDocument();
      expect(
        screen.queryByText(/Multiply coordinates/),
      ).not.toBeInTheDocument();
      if (withFiles) {
        const files = screen.getByRole("list", { name: "Referenced files" });
        const images = screen.getByRole("group", { name: "Attached images" });
        expect(files).toHaveTextContent("report.md");
        expect(
          images.compareDocumentPosition(files) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
          files.compareDocumentPosition(screen.getByText("inspect")) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(
          screen.queryByText(ATTACHMENT_CONTEXT_HEADING),
        ).not.toBeInTheDocument();
      }
      expect(
        screen.getByRole("group", { name: "Attached images" }),
      ).toBeInTheDocument();
      const search = screen.getByRole("searchbox", {
        name: "Search conversation",
      });
      fireEvent.change(search, { target: { value: "Multiply coordinates" } });
      expect(
        screen.getByLabelText("Transcript search matches"),
      ).toHaveTextContent("0 matches");
      fireEvent.change(search, { target: { value: "inspect" } });
      expect(
        screen.getByLabelText("Transcript search matches"),
      ).toHaveTextContent("1 match");
      fireEvent.click(screen.getByRole("button", { name: "Copy message" }));
      await waitFor(() =>
        expect(written).toHaveBeenCalledWith(
          expect.objectContaining({ text: sourceText }),
        ),
      );
    },
  );

  it("copies each conversation message and forks through its authoritative entry id", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const originalFork = store.forkFromEntry;
    const fork = vi.fn(async () => true);
    store.forkFromEntry = fork;
    try {
      render(
        <Transcript
          sessionId="s1"
          messages={[
            {
              role: "user",
              content: "**user source**",
              timestamp: 1,
              __inspireEntryId: "entry-user",
            },
            {
              role: "assistant",
              content: [{ type: "text", text: "assistant source" }],
              timestamp: 2,
            },
          ]}
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="collapsed"
        />,
      );

      const userTurn = (await screen.findByText("user source")).closest(
        ".turn",
      ) as HTMLElement;
      fireEvent.click(
        within(userTurn).getByRole("button", { name: "Copy message" }),
      );
      expect(
        await within(userTurn).findByRole("button", {
          name: "Message copied",
        }),
      ).toBeInTheDocument();
      expect(writeText).toHaveBeenCalledWith("**user source**");

      fireEvent.click(
        within(userTurn).getByRole("button", {
          name: "Fork session from this input",
        }),
      );
      await waitFor(() => expect(fork).toHaveBeenCalledWith("entry-user"));

      const assistantTurn = screen
        .getByText("assistant source")
        .closest(".turn") as HTMLElement;
      const responseActions = assistantTurn.querySelector(
        ".turn__actions--response",
      ) as HTMLElement;
      expect(
        assistantTurn.querySelector(".assistant-doc")?.nextElementSibling,
      ).toBe(responseActions);
      fireEvent.click(
        within(responseActions).getByRole("button", { name: "Copy response" }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith("assistant source"),
      );
      expect(
        within(assistantTurn).queryByRole("button", { name: /Fork session/ }),
      ).not.toBeInTheDocument();
    } finally {
      store.forkFromEntry = originalFork;
    }
  });

  it("keeps response and activity-block clipboard projections separate", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const originalOpenResource = store.openResource;
    const openResource = vi.fn(async () => undefined);
    store.openResource = openResource;
    const generic = {
      type: "custom",
      extensionName: "Web search",
      payload: { count: 2 },
    };
    try {
      render(
        <Transcript
          messages={[
            {
              role: "assistant",
              timestamp: 1,
              content: [
                { type: "thinking", thinking: "private reasoning" },
                { type: "text", text: "first response" },
                {
                  type: "toolCall",
                  id: "copy-tool",
                  name: "read",
                  arguments: { path: "src/a.ts" },
                },
                { type: "text", text: "second response" },
                generic,
              ],
            },
            {
              role: "toolResult",
              toolCallId: "copy-tool",
              content: "file body",
              timestamp: 2,
            },
            {
              role: "custom",
              customType: "intercom_message",
              content: "custom payload",
              details: { channel: "local" },
              display: true,
              timestamp: 3,
            },
          ]}
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="collapsed"
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(
          "first response\n\nsecond response",
        ),
      );

      expect(
        screen.queryByRole("button", { name: "Copy thinking block" }),
      ).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Expand Thinking" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Copy thinking block" }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith("private reasoning"),
      );

      expect(
        screen.queryByRole("button", { name: "Copy read tool block" }),
      ).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Expand read tool" }));
      fireEvent.click(
        screen.getByRole("button", { name: "Copy read tool block" }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(
          [
            "read",
            "Arguments",
            JSON.stringify({ path: "src/a.ts" }, null, 2),
            "Result",
            "file body",
          ].join("\n\n"),
        ),
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Collapse read tool" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Expand Web search" }),
      );
      fireEvent.click(
        screen.getByRole("button", { name: "Copy web search block" }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(
          JSON.stringify(generic, null, 2),
        ),
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Copy intercom message block" }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(
          [
            "Intercom message",
            "Type: intercom_message",
            "Content",
            "custom payload",
            "Details",
            JSON.stringify({ channel: "local" }, null, 2),
          ].join("\n\n"),
        ),
      );

      const toolCard = screen
        .getByText("read", { selector: ".card__tool-name" })
        .closest(".card") as HTMLElement;
      const disclosure = within(toolCard).getByRole("button", {
        name: "Expand read tool",
      });
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      fireEvent.click(
        within(toolCard).getByRole("button", { name: "src/a.ts" }),
      );
      await waitFor(() => expect(openResource).toHaveBeenCalledTimes(1));
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      // The native disclosure owns the header hit area via its CSS pseudo-element.
      fireEvent.click(disclosure);
      expect(disclosure).toHaveAttribute("aria-expanded", "true");
      expect(openResource).toHaveBeenCalledTimes(1);
      fireEvent.click(disclosure);
      expect(disclosure).toHaveAttribute("aria-expanded", "false");
      expect(openResource).toHaveBeenCalledTimes(1);
    } finally {
      store.openResource = originalOpenResource;
    }
  });
});
