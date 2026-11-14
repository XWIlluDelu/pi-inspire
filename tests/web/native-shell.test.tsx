// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BashExecution } from "../../src/components/BashExecution";
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

  it("stream updates retain model state and replace the same live shell row", () => {
    const message = {
      role: "bashExecution",
      timestamp: 1,
      command: "pwd",
      output: "",
      __inspireLiveId: "shell-live",
      __inspireBashRunning: true,
    };
    let reduced = reduceEvent(
      { ...emptyEventSlice(), streaming: true },
      {
        type: "message_start",
        message,
        shellExecution: true,
        bashRunning: true,
      },
    );
    expect(reduced.slice).toMatchObject({
      bashRunning: true,
      streaming: true,
    });
    reduced = reduceEvent(reduced.slice, {
      type: "message_end",
      shellExecution: true,
      bashRunning: false,
      message: {
        ...message,
        output: "/project",
        exitCode: 0,
        __inspireBashRunning: false,
      },
    });
    expect(reduced.slice.messages).toHaveLength(1);
    expect(reduced.slice).toMatchObject({
      bashRunning: false,
      streaming: true,
    });
    expect(reduced.slice.messages[0]).toMatchObject({
      __inspireLiveId: "shell-live",
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

it("reads stored shell output literally and trusts only the structured full-log reference", () => {
  const output =
    "# literal heading\n<script>literal script</script>\nFull output: /tmp/stdout-is-not-metadata.log\n\n```js\nraw code\n```";
  const message = {
    role: "bashExecution",
    command: "printf output",
    output,
    exitCode: 0,
    truncated: true,
  };
  const { rerender } = render(<BashExecution message={message} history />);
  const preview = screen.getByRole("region", { name: "Shell record preview" });
  expect(preview.querySelector(".shell-execution__output")?.textContent).toBe(
    output,
  );
  expect(preview.querySelector("script")).toBeNull();
  expect(screen.getByText("Exit 0")).toBeVisible();
  expect(
    screen.queryByRole("button", { name: "View full shell output" }),
  ).toBeNull();
  rerender(
    <BashExecution
      message={{ ...message, fullOutputPath: "/tmp/logs/native shell.log" }}
      history
    />,
  );
  expect(
    screen.getByRole("button", { name: "View full shell output" }),
  ).toHaveAttribute("data-file-path", "/tmp/logs/native%20shell.log");
});
