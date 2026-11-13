import { SquareTerminal } from "lucide-react";
import { memo } from "react";
import {
  fileResourceReference,
  isResourceReferenceText,
} from "../../shared/resource-references";
import { stripTerminalSequences } from "../ansi";
import { shellCommand, shellCopyText } from "../shell-record";
import type { ChatMessage } from "../events";
import { CopyAction } from "./CopyAction";
import { PiLoader } from "./PiLoader";

/** Pi's direct shell result is user activity, not an assistant tool call. */
export const BashExecution = memo(function BashExecution({
  message,
  history = false,
}: {
  message: ChatMessage;
  history?: boolean;
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
  const shell = { ...message, command: message.command ?? "" };
  const command = shellCommand(shell);
  const output = stripTerminalSequences(message.output ?? "");
  const previewTruncated =
    (running || interrupted) && message.__inspireBashPreviewTruncated;
  const copy = [
    shellCopyText(shell, message.output ?? "", status, contextLabel),
    error ?? "",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <section
      className={`turn shell-execution card${history ? " shell-execution--history" : ""}${failed ? " card--failed" : " card--tool"}`}
      aria-label={history ? "Shell record preview" : "Shell command"}
    >
      <div className="shell-execution__header">
        {running ? (
          <PiLoader size={14} aria-hidden />
        ) : (
          <SquareTerminal size={14} aria-hidden />
        )}
        <span>Shell</span>
        <span className="shell-execution__status" role="status">
          {status}
        </span>
        <span className="shell-execution__context">{contextLabel}</span>
        {!history && (
          <CopyAction
            text={copy}
            label="shell result"
            className="shell-execution__copy"
          />
        )}
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
          {message.fullOutputPath &&
          isResourceReferenceText(message.fullOutputPath) ? (
            <>
              {" "}
              <button
                type="button"
                className="tool-notice__action"
                data-file-path={fileResourceReference(message.fullOutputPath)}
                title={`Preview ${message.fullOutputPath}`}
                aria-label={history ? "View full shell output" : undefined}
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
