import { SquareTerminal } from "lucide-react";
import { memo } from "react";
import {
  fileResourceReference,
  isResourceReferenceText,
} from "../../shared/resource-references";
import { stripTerminalSequences } from "../ansi";
import { copyLoader } from "../content-copy";
import type { ChatMessage } from "../events";
import {
  shellCommand,
  shellContext,
  shellCopyText,
  shellStatus,
} from "../shell-record";
import { CodeView } from "./CodeView";
import { PiLoader } from "./PiLoader";
import { ActivityHeader, ActivityText } from "./transcript-activity-visibility";

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
  const failed =
    Boolean(error) ||
    (!running &&
      !message.cancelled &&
      message.exitCode !== undefined &&
      message.exitCode !== 0);
  const output = stripTerminalSequences(message.output ?? "");
  const previewTruncated =
    (running || interrupted) && message.__inspireBashPreviewTruncated;
  const fullOutput = message.fullOutputPath;
  return (
    <section
      className="activity-surface shell-execution"
      aria-label={history ? "Shell record preview" : "Shell command"}
    >
      <ActivityHeader
        className="shell-execution__header"
        icon={
          running ? (
            <PiLoader size={14} aria-hidden />
          ) : (
            <SquareTerminal size={14} aria-hidden />
          )
        }
        copy={
          history
            ? undefined
            : {
                getContent: copyLoader(async () =>
                  shellCopyText(message, message.output ?? ""),
                ),
                label: "shell result",
              }
        }
      >
        <span>Shell</span>
        <span
          className="shell-execution__status"
          data-error={failed || undefined}
          role="status"
        >
          {shellStatus(message)}
        </span>
        <span className="shell-execution__context">
          {shellContext(message)}
        </span>
      </ActivityHeader>
      <CodeView
        className="activity-reader shell-execution__command"
        text={shellCommand(message)}
      />
      {output ? (
        <ActivityText
          className="shell-execution__output"
          scrollable={!history}
          label="Shell output"
          text={output}
        />
      ) : null}
      {previewTruncated || message.truncated ? (
        <div className="tool-notice">
          {previewTruncated
            ? "Showing the latest streamed output."
            : "Pi truncated the recorded output."}
          {fullOutput && isResourceReferenceText(fullOutput) && (
            <button
              type="button"
              className="tool-notice__action"
              data-file-path={fileResourceReference(fullOutput)}
              title={`Preview ${fullOutput}`}
              aria-label={history ? "View full shell output" : undefined}
            >
              View full output
            </button>
          )}
        </div>
      ) : null}
      {error && <div className="tool-notice tool-notice--error">{error}</div>}
    </section>
  );
});
