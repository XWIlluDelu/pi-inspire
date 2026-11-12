// @vitest-environment jsdom
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  HistoryShellPreview,
  historyShellContent,
} from "../../src/components/HistoryShellPreview";
import { Transcript } from "../../src/components/Transcript";
import { emptyEventSlice, reduceEvent } from "../../src/events";

describe("native shell transcript", () => {
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
  });
});

describe("shell records in History", () => {
  const command = "!printf 'shell history'";
  const record = (output: string) =>
    ["```", command, "```", "", "````", output, "````", "", "Exit 0"].join(
      "\n",
    );

  it("reads shell stdout literally and copies it with the command and Host outcome", async ({
    onTestFinished,
  }) => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    onTestFinished(() => {
      vi.unstubAllGlobals();
    });
    const output =
      "# literal heading\n  column A\tcolumn B\n<script>literal script</script>\n\nExit 99\n\n```js\nraw code\n```";
    render(<HistoryShellPreview text={record(output)} complete />);
    const preview = screen.getByRole("region", {
      name: "Shell record preview",
    });
    expect(preview.querySelector(".history-shell__output")?.textContent).toBe(
      output,
    );
    expect(preview.querySelector("script")).toBeNull();
    expect(screen.getByText("Exit 0")).toBeVisible();

    fireEvent.click(
      screen.getByRole("button", { name: "Copy loaded shell content" }),
    );
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(
        [command, output, "Exit 0"].join("\n\n"),
      ),
    );
  });

  it("recognizes only a complete Host-projected full-log reference", () => {
    const output = "Full output: /tmp/stdout-is-not-metadata.log";
    const path = "/tmp/logs/native shell.log";
    const text = `${record(output)}\n\nOutput truncated\n\nFull output: ${path}`;
    expect(historyShellContent(record(output), true).fullOutputPath).toBeNull();
    expect(historyShellContent(text, false).fullOutputPath).toBeNull();
    render(<HistoryShellPreview text={text} complete />);
    expect(
      screen.getByRole("button", { name: "View full shell output" }),
    ).toHaveAttribute("data-file-path", "/tmp/logs/native%20shell.log");
  });
});
