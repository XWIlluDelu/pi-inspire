// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Transcript, findLiteralMatches } from "../../src/components/Transcript";
import { store } from "../../src/store";

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
});

describe("settled transcript search", () => {
  it("keeps the compact floating search and filters all, user, or model text", () => {
    render(
      <Transcript
        sessionId="scoped"
        messages={[
          { role: "user", content: "shared phrase from user", timestamp: 1 },
          { role: "assistant", content: "shared phrase from model", timestamp: 2 },
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );

    const search = screen.getByRole("search", { name: "Search settled transcript" });
    const input = screen.getByRole("searchbox", { name: "Search conversation" });
    const log = screen.getByRole("log");
    expect(search.parentElement).toHaveClass("transcript-wrap");
    expect(search.nextElementSibling).toBe(log);
    expect(search).not.toHaveClass("transcript-search--active");

    fireEvent.change(input, { target: { value: "shared" } });
    expect(search).toHaveClass("transcript-search--active");
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("2 matches");

    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "User" }));
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("1 match");

    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "Model" }));
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("1 match");
    fireEvent.change(screen.getByRole("searchbox", { name: "Search conversation" }), { target: { value: "user" } });
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("No matches");

    fireEvent.click(screen.getByRole("combobox", { name: "Search scope" }));
    fireEvent.click(screen.getByRole("option", { name: "All" }));
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("1 match");

    fireEvent.change(input, { target: { value: "" } });
    expect(search).not.toHaveClass("transcript-search--active");
  });

  it("finds case-insensitive literal occurrences only in settled user and assistant text", () => {
    expect(findLiteralMatches("Alpha alpha alphabet", "ALPHA", 3)).toEqual([
      { rowIndex: 3, offset: 0 },
      { rowIndex: 3, offset: 6 },
      { rowIndex: 3, offset: 12 },
    ]);

    const messages = [
      { role: "user", content: "Alpha alpha", timestamp: 1 },
      {
        role: "assistant",
        timestamp: 2,
        content: [
          { type: "text", text: "BETA beta" },
          { type: "thinking", thinking: "hidden needle" },
          { type: "toolCall", id: "tool-1", name: "search", arguments: { query: "needle" } },
        ],
      },
      { role: "assistant", timestamp: 3, content: [{ type: "text", text: "live beta" }], __inspireLiveId: "assistant-live" },
      { role: "user", content: "unsettled beta", timestamp: 4, __inspireLiveId: "user-live" },
    ];
    const { rerender } = render(
      <Transcript
        sessionId="s1"
        messages={messages}
        streaming
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    const input = screen.getByRole("searchbox", { name: "Search conversation" });

    fireEvent.change(input, { target: { value: "beta" } });
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("2 matches");
    fireEvent.click(screen.getByRole("button", { name: "Next transcript match" }));
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("1 of 2");
    fireEvent.click(screen.getByRole("button", { name: "Previous transcript match" }));
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("2 of 2");
    expect(screen.getByRole("button", { name: "Jump to latest" })).toBeInTheDocument();

    fireEvent.change(input, { target: { value: "needle" } });
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("No matches");

    fireEvent.change(input, { target: { value: "beta" } });
    rerender(
      <Transcript
        sessionId="s1"
        messages={[
          { role: "user", content: "older beta", timestamp: 0 },
          ...messages.map((message) => message.timestamp === 3 ? { ...message, __inspireSettled: true } : message),
        ]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(screen.getByLabelText("Transcript search matches")).toHaveTextContent("4 matches");

    rerender(
      <Transcript
        sessionId="s2"
        messages={[{ role: "user", content: "beta in another session", timestamp: 10 }]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
      />,
    );
    expect(screen.getByRole("searchbox", { name: "Search conversation" })).toHaveValue("");
  });
});

describe("transcript density preferences", () => {
  const assistant = {
    role: "assistant",
    model: "gpt-test",
    stopReason: "toolUse",
    timestamp: 2,
    content: [
      { type: "toolCall", id: "tool-a", name: "ffgrep", arguments: { query: "alpha" } },
      { type: "toolCall", id: "tool-b", name: "read", arguments: { path: "src/a.ts" } },
      { type: "text", text: "between tool runs" },
      { type: "toolCall", id: "tool-c", name: "bash", arguments: { command: "npm test" } },
    ],
  };
  const results = [
    { role: "toolResult", toolCallId: "tool-a", toolName: "ffgrep", content: "alpha result", timestamp: 3 },
    { role: "toolResult", toolCallId: "tool-b", toolName: "read", content: "read result", timestamp: 4 },
    { role: "toolResult", toolCallId: "tool-c", toolName: "bash", content: "failed result", isError: true, timestamp: 5 },
  ];

  it("replaces only the assistant attribution row with a divider", () => {
    const { container, rerender } = render(
      <Transcript
        messages={[assistant]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        assistantRoundDisplay="divider"
      />,
    );
    expect(container.querySelectorAll(".turn__divider")).toHaveLength(1);
    expect(screen.queryByText("Pi")).not.toBeInTheDocument();
    expect(screen.queryByText("gpt-test")).not.toBeInTheDocument();
    expect(screen.queryByText("toolUse")).not.toBeInTheDocument();

    rerender(
      <Transcript
        messages={[assistant]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        assistantRoundDisplay="details"
      />,
    );
    expect(container.querySelector(".turn__divider")).toBeNull();
    expect(screen.getByText("Pi")).toBeInTheDocument();
    expect(screen.getByText("gpt-test")).toBeInTheDocument();
    expect(screen.getByText("toolUse")).toBeInTheDocument();
  });

  it("lays only adjacent tool calls across a row and reveals one downward detail panel", () => {
    const { container } = render(
      <Transcript
        messages={[assistant, ...results]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="compact"
        assistantRoundDisplay="divider"
      />,
    );
    const strips = container.querySelectorAll(".tool-strip");
    expect(strips).toHaveLength(2);
    expect(strips[0]!.querySelectorAll(".tool-strip__item")).toHaveLength(2);
    expect(strips[1]!.querySelectorAll(".tool-strip__item")).toHaveLength(1);

    const read = screen.getByRole("button", { name: /read: finished/i });
    fireEvent.click(read);
    expect(read).toHaveAttribute("aria-expanded", "true");
    const detail = strips[0]!.querySelector(".tool-strip__detail");
    expect(detail).not.toBeNull();
    expect(strips[0]!.querySelector(".tool-strip__items")?.nextElementSibling).toContainElement(detail as HTMLElement);
    expect(within(detail as HTMLElement).getByText("read result")).toBeInTheDocument();

    const ffgrep = screen.getByRole("button", { name: /ffgrep: finished/i });
    fireEvent.click(ffgrep);
    expect(container.querySelectorAll(".tool-strip__detail")).toHaveLength(1);
    expect(screen.queryByText("read result")).not.toBeInTheDocument();
    expect(screen.getByText("alpha result")).toBeInTheDocument();

    fireEvent.click(ffgrep);
    expect(strips[0]!.querySelector(".tool-strip__reveal")).toHaveAttribute("aria-hidden", "true");
    expect(screen.getByText("alpha result")).toBeInTheDocument();
    return waitFor(() => expect(screen.queryByText("alpha result")).not.toBeInTheDocument());
  });
});

describe("persisted user images", () => {
  it("loads a stable embedded-image reference and opens a keyboard-accessible preview", async () => {
    const originalLoad = store.loadEmbeddedImage;
    const load = vi.fn(async () => new Blob(["png"], { type: "image/png" }));
    store.loadEmbeddedImage = load;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:persisted-image") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    try {
      render(
        <Transcript
          sessionId="s-images"
          viewId="view-images"
          messages={[{
            role: "user",
            content: [{ type: "image", mimeType: "image/png" }, { type: "text", text: "caption" }],
            timestamp: 1,
            __inspireMessageIndex: 4,
          }]}
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="collapsed"
        />,
      );
      const thumbnail = await screen.findByRole("button", { name: "Preview attached image" });
      expect(load).toHaveBeenCalledWith("s-images", "view-images", "pi-embedded://4/0", expect.any(AbortSignal));
      expect(screen.getByText("caption")).toBeInTheDocument();
      const thumbnailImage = within(thumbnail).getByRole("img", { name: "Attached image" });
      expect(thumbnailImage).toHaveAttribute("draggable", "false");
      expect(fireEvent.dragStart(thumbnailImage)).toBe(false);

      fireEvent.click(thumbnail);
      const preview = screen.getByRole("dialog", { name: "Image preview" });
      const previewImage = within(preview).getByRole("img", { name: "Attached image" });
      expect(previewImage).toHaveAttribute("draggable", "false");
      expect(fireEvent.dragStart(previewImage)).toBe(false);

      const zoom = within(preview).getByRole("button", { name: "Zoom image" });
      fireEvent.click(zoom);
      expect(within(preview).getByRole("button", { name: "Fit image to window" })).toHaveAttribute("aria-pressed", "true");

      fireEvent.pointerDown(zoom, { pointerId: 1, button: 0, clientX: 10, clientY: 10 });
      fireEvent.pointerMove(zoom, { pointerId: 1, clientX: 20, clientY: 10 });
      expect(zoom).toHaveClass("image-lightbox__canvas--panning");
      fireEvent.pointerUp(zoom, { pointerId: 1, clientX: 20, clientY: 10 });
      fireEvent.click(zoom);
      expect(zoom).toHaveAttribute("aria-pressed", "true");

      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("dialog", { name: "Image preview" })).not.toBeInTheDocument());
    } finally {
      store.loadEmbeddedImage = originalLoad;
    }
  });
});

describe("message actions", () => {
  it("copies each conversation message and forks through its authoritative entry id", async () => {
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const originalFork = store.forkFromEntry;
    const fork = vi.fn(async () => true);
    store.forkFromEntry = fork;
    try {
      render(
        <Transcript
          sessionId="s1"
          messages={[
            { role: "user", content: "**user source**", timestamp: 1, __inspireEntryId: "entry-user" },
            { role: "assistant", content: [{ type: "text", text: "assistant source" }], timestamp: 2 },
          ]}
          streaming={false}
          thinkingVisibility="collapsed"
          toolVisibility="collapsed"
        />,
      );

      const userTurn = screen.getByText("user source").closest(".turn") as HTMLElement;
      fireEvent.click(within(userTurn).getByRole("button", { name: "Copy message" }));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("**user source**"));
      expect(within(userTurn).getByRole("button", { name: "Message copied" })).toBeInTheDocument();

      fireEvent.click(within(userTurn).getByRole("button", { name: "Fork session from this input" }));
      await waitFor(() => expect(fork).toHaveBeenCalledWith("entry-user"));

      const assistantTurn = screen.getByText("assistant source").closest(".turn") as HTMLElement;
      fireEvent.click(within(assistantTurn).getByRole("button", { name: "Copy message" }));
      await waitFor(() => expect(writeText).toHaveBeenLastCalledWith("assistant source"));
      expect(within(assistantTurn).queryByRole("button", { name: /Fork session/ })).not.toBeInTheDocument();
    } finally {
      store.forkFromEntry = originalFork;
    }
  });
});

describe("transient conversation projections", () => {
  it("renders separate ordered pending queues without cancellation or cross-queue chronology", () => {
    render(
      <Transcript
        messages={[{ role: "user", content: "persisted", timestamp: 1 }]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="collapsed"
        queue={{ steering: ["steer first", "steer second"], followUp: ["follow first", "follow second"] }}
      />,
    );
    const steering = screen.getByRole("region", { name: "Pending steering" });
    const followUp = screen.getByRole("region", { name: "Pending follow-up" });
    expect(within(steering).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["steer first", "steer second"]);
    expect(within(followUp).getAllByRole("listitem").map((item) => item.textContent)).toEqual(["follow first", "follow second"]);
    expect(screen.queryByRole("button", { name: /cancel/i })).not.toBeInTheDocument();
  });

  it("renders one attributable inspectable generic extension surface", () => {
    render(
      <Transcript
        messages={[]}
        streaming={false}
        thinkingVisibility="collapsed"
        toolVisibility="hidden"
        extensionDisplays={[
          { id: "setWidget:plan", method: "setWidget", attribution: "extensions/plan.ts · plan", payload: { widgetLines: ["one"] } },
          { id: "showPanel:build", method: "showPanel", attribution: "extensions/build.ts · build", payload: { status: "passing" } },
        ]}
      />,
    );
    const surface = screen.getByRole("region", { name: "Extension display content" });
    expect(within(surface).getByText("extensions/plan.ts · plan")).toBeInTheDocument();
    expect(within(surface).getByText("extensions/build.ts · build")).toBeInTheDocument();
    fireEvent.click(within(surface).getByText("extensions/plan.ts · plan"));
    expect(within(surface).getByText(/widgetLines/)).toBeInTheDocument();
  });
});
