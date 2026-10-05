// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { Transcript } from "../../src/components/Transcript";
import { emptyEventSlice, reduceEvent } from "../../src/events";
import { installFakeWebSocket, installFetch, jsonBody } from "./helpers";
import { baseRoutes, initStore } from "./store-fixture";

describe("native shell presentation and input", () => {
  beforeEach(() => {
    installFakeWebSocket();
  });

  it("renders native persisted Bash as user activity even with model tools hidden", () => {
    render(
      <Transcript
        sessionId="shell"
        streaming={false}
        thinkingVisibility="hidden"
        toolVisibility="hidden"
        messages={[
          {
            role: "bashExecution",
            command: "printf error",
            output: "\u001b[31merror\u001b[0m",
            timestamp: 1,
            exitCode: 3,
            cancelled: false,
            truncated: true,
            fullOutputPath: "/tmp/native-result.txt",
            excludeFromContext: true,
          },
        ]}
      />,
    );
    const shell = screen.getByRole("region", { name: "Shell command" });
    expect(within(shell).getByText("!!printf error")).toBeVisible();
    expect(within(shell).getByText("error")).toBeVisible();
    expect(within(shell).getByText("Exit 3")).toBeVisible();
    expect(within(shell).getByText("Excluded from context")).toBeVisible();
    expect(shell).toHaveTextContent("Pi truncated the recorded output");
    expect(
      within(shell).getByRole("button", { name: "View full output" }),
    ).toHaveAttribute("data-file-path", "/tmp/native-result.txt");
    expect(
      within(shell).getByRole("button", { name: /Copy shell result/ }),
    ).toBeVisible();
    expect(shell).toHaveClass("card--failed");
  });

  it("stream updates retain model state and hand off live-to-persisted identity without duplicate cards", () => {
    const settled = new Set<string>();
    const message = {
      role: "bashExecution",
      timestamp: 1,
      command: "pwd",
      output: "",
      __inspireLiveId: "shell-live",
      __inspireBashRunning: true,
    };
    let reduced = reduceEvent(
      { ...emptyEventSlice(), runState: "running", streaming: true },
      settled,
      {
        type: "message_start",
        message,
        shellExecution: true,
        bashRunning: true,
      },
    );
    expect(reduced.slice).toMatchObject({
      bashRunning: true,
      runState: "running",
      streaming: true,
    });
    reduced = reduceEvent(reduced.slice, settled, {
      type: "message_end",
      shellExecution: true,
      bashRunning: false,
      message: {
        ...message,
        output: "/project",
        exitCode: 0,
        __inspireMessageId: "durable:0",
        __inspireBashRunning: false,
      },
    });
    expect(reduced.slice.messages).toHaveLength(1);
    expect(reduced.slice).toMatchObject({
      bashRunning: false,
      runState: "running",
      streaming: true,
    });
    expect(reduced.slice.messages[0]).toMatchObject({
      __inspireMessageId: "durable:0",
      output: "/project",
    });
  });

  it("sends busy !/!! directly without steer/queue and recalls the accepted native input", async () => {
    let sent: Record<string, unknown> = {};
    installFetch((url, init) => {
      if (url === "/api/prompt") {
        sent = jsonBody(init);
        return {
          status: 202,
          body: {
            accepted: true,
            historyEntry: { text: "!!printf secret", images: [], files: [] },
          },
        };
      }
      return baseRoutes(url, init);
    });
    const { store, socket } = await initStore();
    socket.emit({ type: "agent_start" });
    expect(await store.sendPrompt("!!printf secret", "followUp")).toMatchObject(
      {
        accepted: true,
        historyEntry: { text: "!!printf secret", images: [], files: [] },
      },
    );
    expect(sent.message).toBe("!!printf secret");
    expect(sent.behavior).toBeUndefined();
    expect(store.getState().queue.followUp).toEqual([]);
  });

  it("rejects shell attachments without deleting them or sending a model prompt", async () => {
    let sent = false;
    installFetch((url, init) => {
      if (url === "/api/prompt") {
        sent = true;
        return { body: { accepted: true } };
      }
      if (url === "/api/attachments")
        return {
          body: {
            attachments: [
              {
                id: "image",
                kind: "image",
                fileName: "image.png",
                mimeType: "image/png",
                size: 3,
              },
            ],
          },
        };
      return baseRoutes(url, init);
    });
    const { store } = await initStore();
    await store.addFiles([
      new File(["img"], "image.png", { type: "image/png" }),
    ]);
    expect(await store.sendPrompt("!pwd")).toBe(false);
    expect(sent).toBe(false);
    expect(store.getState().attachments).toHaveLength(1);
  });

  it("shows a retired shell snapshot as interrupted, not running or a confirmed context result", () => {
    render(
      <Transcript
        sessionId="shell-interrupted"
        streaming={false}
        thinkingVisibility="hidden"
        toolVisibility="hidden"
        messages={[
          {
            role: "bashExecution",
            command: "sleep 30",
            output: "known partial output",
            timestamp: 1,
            __inspireBashRunning: false,
            __inspireBashInterrupted: true,
            __inspireBashError:
              "Pi worker retired before its shell result was confirmed",
          },
        ]}
      />,
    );
    const shell = screen.getByRole("region", { name: "Shell command" });
    expect(within(shell).getByText("Interrupted")).toBeVisible();
    expect(within(shell).getByText("known partial output")).toBeVisible();
    expect(within(shell).getByText("Context unconfirmed")).toBeVisible();
    expect(within(shell).queryByText("Running")).not.toBeInTheDocument();
    expect(
      within(shell).queryByText("Included in context"),
    ).not.toBeInTheDocument();
    expect(shell.querySelector(".spin")).toBeNull();
  });

  it("retains cancelled status on reopened native output", () => {
    render(
      <Transcript
        sessionId="shell-cancelled"
        streaming={false}
        thinkingVisibility="hidden"
        toolVisibility="hidden"
        messages={[
          {
            role: "bashExecution",
            command: "sleep 30",
            output: "before stop",
            timestamp: 1,
            cancelled: true,
            excludeFromContext: false,
          },
        ]}
      />,
    );
    expect(screen.getByText("Cancelled")).toBeVisible();
    expect(screen.getByText("Included in context")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /Copy shell result/ }));
  });
});
