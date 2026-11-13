import type { SavedShellDetails } from "../shared/contracts";

export function shellCommand(
  shell: Pick<SavedShellDetails, "command" | "excludeFromContext">,
) {
  return `${shell.excludeFromContext ? "!!" : "!"}${shell.command ?? ""}`;
}

export function shellCopyText(
  shell: SavedShellDetails,
  output: string,
  status = shell.cancelled
    ? "Cancelled"
    : shell.exitCode !== undefined
      ? `Exit ${shell.exitCode}`
      : "Finished",
  context = shell.excludeFromContext
    ? "Excluded from context"
    : "Included in context",
) {
  return [
    shellCommand(shell),
    output,
    status,
    context,
    shell.truncated ? "Output truncated" : "",
    shell.fullOutputPath ? `Full output: ${shell.fullOutputPath}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
