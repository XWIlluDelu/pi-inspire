import { Loader2, SquareTerminal } from "lucide-react";
import { memo } from "react";
import { stripTerminalSequences } from "../ansi";
import type { ChatMessage } from "../events";
import { CopyAction } from "./CopyAction";

/** Pi's direct shell result is user activity, not an assistant tool call. */
export const BashExecution = memo(function BashExecution({
  message,
}: {
  message: ChatMessage;
}) {
  const running = message.__inspireBashRunning === true;
  const error = message.__inspireBashError;
  const interrupted = message.__inspireBashInterrupted === true;
  const contextLabel = message.excludeFromContext
    ? "Excluded from context"
    : error
      ? "Context unconfirmed"
      : "Included in context";
  const failed =
    Boolean(error) ||
    (!running &&
      !message.cancelled &&
      message.exitCode !== undefined &&
      message.exitCode !== 0);
  const status = running
    ? "Running"
    : interrupted
      ? "Interrupted"
      : error
        ? "Failed"
        : message.cancelled
          ? "Cancelled"
          : message.exitCode !== undefined
            ? `Exit ${message.exitCode}`
            : "Finished";
  const command = `${message.excludeFromContext ? "!!" : "!"}${message.command ?? ""}`;
  const output = stripTerminalSequences(message.output ?? "");
  const previewTruncated =
    (running || interrupted) && message.__inspireBashPreviewTruncated;
  const copy = [
    command,
    message.output ?? "",
    status,
    contextLabel,
    message.truncated ? "Output truncated" : "",
    message.fullOutputPath ?? "",
    error ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <section
      className={`turn shell-execution card${failed ? " card--failed" : " card--tool"}`}
      aria-label="Shell command"
    >
      <div className="shell-execution__header">
        {running ? (
          <Loader2 size={14} className="spin" aria-hidden />
        ) : (
          <SquareTerminal size={14} aria-hidden />
        )}
        <span>Shell</span>
        <span className="shell-execution__status" role="status">
          {status}
        </span>
        <span className="shell-execution__context">{contextLabel}</span>
        <CopyAction
          text={copy}
          label="shell result"
          className="shell-execution__copy"
        />
      </div>
      <pre className="shell-execution__command">
        <code>{command}</code>
      </pre>
      {output ? (
        <pre className="shell-execution__output">
          <code>{output}</code>
        </pre>
      ) : null}
      {previewTruncated || message.truncated ? (
        <p className="shell-execution__note">
          {previewTruncated
            ? "Showing the latest streamed output."
            : "Pi truncated the recorded output."}
          {message.fullOutputPath ? (
            <>
              {" "}
              <button
                type="button"
                className="tool-notice__action"
                data-file-path={message.fullOutputPath}
                title={`Preview ${message.fullOutputPath}`}
              >
                View full output
              </button>
            </>
          ) : null}
        </p>
      ) : null}
      {error ? <p className="shell-execution__error">{error}</p> : null}
    </section>
  );
});
