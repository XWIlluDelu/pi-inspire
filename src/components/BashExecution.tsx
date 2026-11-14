import { SquareTerminal } from "lucide-react";
import { memo } from "react";
import {
  fileResourceReference,
  isResourceReferenceText,
} from "../../shared/resource-references";
import { stripTerminalSequences } from "../ansi";
import { copyLoader } from "../content-copy";
import type { ChatMessage } from "../events";
import { shellCommand, shellCopyText } from "../shell-record";
import { CodeView } from "./CodeView";
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
  const fullOutput = message.fullOutputPath;
  return (
    <section
      className={`activity-surface shell-execution${history ? " shell-execution--history" : ""}`}
      aria-label={history ? "Shell record preview" : "Shell command"}
    >
      <div className="activity-surface__head shell-execution__header">
        {running ? (
          <PiLoader size={14} aria-hidden />
        ) : (
          <SquareTerminal size={14} aria-hidden />
        )}
        <span>Shell</span>
        <span
          className="shell-execution__status"
          data-error={failed || undefined}
          role="status"
        >
          {status}
        </span>
        <span className="shell-execution__context">{contextLabel}</span>
        {!history && (
          <CopyAction
            getContent={copyLoader(async () =>
              [
                shellCopyText(
                  shell,
                  message.output ?? "",
                  status,
                  contextLabel,
                ),
                error,
              ]
                .filter(Boolean)
                .join("\n"),
            )}
            label="shell result"
            className="activity-copy"
          />
        )}
      </div>
      <CodeView className="activity-reader" text={command} />
      {output ? (
        <CodeView
          className="activity-reader shell-execution__output"
          text={output}
          tabIndex={history ? undefined : 0}
          role={history ? undefined : "group"}
          aria-label={history ? undefined : "Shell output"}
        />
      ) : null}
      {previewTruncated || message.truncated ? (
        <div className="tool-notice">
          {previewTruncated
            ? "Showing the latest streamed output."
            : "Pi truncated the recorded output."}
          {fullOutput && isResourceReferenceText(fullOutput) ? (
            <button
              type="button"
              className="tool-notice__action"
              data-file-path={fileResourceReference(fullOutput)}
              title={`Preview ${fullOutput}`}
              aria-label={history ? "View full shell output" : undefined}
            >
              View full output
            </button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <div className="tool-notice tool-notice--error">{error}</div>
      ) : null}
    </section>
  );
});
