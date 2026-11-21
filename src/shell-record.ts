import type { SavedShellDetails } from "../shared/contracts";
import type { ChatMessage } from "./events";

type ShellStatus = Pick<
  ChatMessage,
  | "__inspireBashRunning"
  | "__inspireBashInterrupted"
  | "__inspireBashError"
  | "cancelled"
  | "exitCode"
>;
type ShellContext = Pick<
  ChatMessage,
  "excludeFromContext" | "__inspireBashError"
>;

export function shellCommand(
  shell: Pick<ChatMessage, "command" | "excludeFromContext">,
) {
  return `${shell.excludeFromContext ? "!!" : "!"}${shell.command ?? ""}`;
}

export function shellStatus(shell: ShellStatus) {
  if (shell.__inspireBashRunning === true) return "Running";
  if (shell.__inspireBashInterrupted === true) return "Interrupted";
  if (shell.__inspireBashError) return "Failed";
  if (shell.cancelled) return "Cancelled";
  return shell.exitCode !== undefined ? `Exit ${shell.exitCode}` : "Finished";
}

export function shellContext(shell: ShellContext) {
  if (shell.excludeFromContext) return "Excluded from context";
  return shell.__inspireBashError
    ? "Not added to context"
    : "Included in context";
}

export function shellCopyText(
  shell: Partial<SavedShellDetails> & ShellStatus & ShellContext,
  output: string,
) {
  return [
    shellCommand(shell),
    output,
    shellStatus(shell),
    shellContext(shell),
    shell.truncated ? "Output truncated" : "",
    shell.fullOutputPath ? `Full output: ${shell.fullOutputPath}` : "",
    shell.__inspireBashError,
  ]
    .filter(Boolean)
    .join("\n");
}
