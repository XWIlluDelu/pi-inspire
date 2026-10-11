// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Transcript } from "../../src/components/Transcript";
import { store } from "../../src/store";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("message actions", () => {
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
      await waitFor(() =>
        expect(writeText).toHaveBeenCalledWith("**user source**"),
      );
      expect(
        within(userTurn).getByRole("button", { name: "Message copied" }),
      ).toBeInTheDocument();

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
          assistantRoundDisplay="divider"
        />,
      );

      fireEvent.click(screen.getByRole("button", { name: "Copy response" }));
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith(
          "first response\n\nsecond response",
        ),
      );

      fireEvent.click(
        screen.getByRole("button", { name: "Copy thinking block" }),
      );
      await waitFor(() =>
        expect(writeText).toHaveBeenLastCalledWith("private reasoning"),
      );

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
      fireEvent.click(
        toolCard.querySelector(".card__header-spacer") as HTMLElement,
      );
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
