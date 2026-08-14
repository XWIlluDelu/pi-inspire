export interface InspireCommandDescriptor {
  name: string;
  description: string;
  source: "inspire";
}

/** Host-owned slash commands. Keep this list beside the parser that owns
 * their prompt-boundary behavior so completion cannot drift from execution. */
export const INSPIRE_COMMANDS: readonly InspireCommandDescriptor[] = [
  {
    name: "compact",
    description: "Compact the current context",
    source: "inspire",
  },
];

/** Matches the host-owned `/compact [instructions]` command. Pi's RPC prompt
 * parses extension commands, not built-ins, so inspire routes this exact
 * command to the compact control. */
export function parseCompactCommand(
  message: string,
): { instructions?: string } | null {
  const match = /^\/compact(?:\s+([\s\S]+))?$/.exec(message.trim());
  if (!match) return null;
  const instructions = match[1]?.trim();
  return instructions ? { instructions } : {};
}
