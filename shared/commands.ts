export type PiNativeCommandExecution =
  | "host"
  | "client"
  | "surface"
  | "terminal"
  | "informational";

interface PiNativeCommandDescriptor {
  name: string;
  description: string;
  argumentHint?: string;
  execution: PiNativeCommandExecution;
  /** Can be used while the retained session's project folder is unavailable. */
  availableWithoutWorkspace?: boolean;
}

/**
 * Pi's built-in interactive command surface, adapted for a persistent browser
 * client. Like Pi's interactive submit handler, built-ins own their names
 * before SDK/RPC resource dispatch. Namespaced runtime commands remain available.
 */
export const PI_NATIVE_COMMANDS = [
  {
    name: "settings",
    availableWithoutWorkspace: true,
    description: "Open INSΠRE and Pi runtime settings",
    execution: "surface",
  },
  {
    name: "model",
    description: "Choose or set the active model",
    argumentHint: "[provider/model]",
    execution: "client",
  },
  {
    name: "tree",
    availableWithoutWorkspace: true,
    description: "Open conversation history and branches",
    execution: "surface",
  },
  {
    name: "thinking",
    description: "Choose or set the thinking level",
    argumentHint: "[level]",
    execution: "client",
  },
  {
    name: "scoped-models",
    availableWithoutWorkspace: true,
    description: "Manage common models and their cycle order",
    execution: "surface",
  },
  {
    name: "export",
    description: "Export session HTML or current-branch JSONL",
    argumentHint: "[path.html|path.jsonl]",
    execution: "host",
  },
  {
    name: "import",
    description: "Import a session from a path in Pi's terminal flow",
    argumentHint: "<path>",
    execution: "terminal",
  },
  {
    name: "share",
    description: "Publish the session with Pi's share flow",
    execution: "terminal",
  },
  {
    name: "bug",
    description: "Review and report a bug in Pi's terminal flow",
    argumentHint: "[description]",
    execution: "terminal",
  },
  {
    name: "copy",
    availableWithoutWorkspace: true,
    description: "Copy the last assistant response",
    execution: "client",
  },
  {
    name: "name",
    description: "Show or set the session name",
    argumentHint: "[name]",
    execution: "client",
  },
  {
    name: "session",
    availableWithoutWorkspace: true,
    description: "Show session, usage, and cost information",
    execution: "informational",
  },
  {
    name: "changelog",
    availableWithoutWorkspace: true,
    description: "Read the installed Pi version's release notes",
    execution: "surface",
  },
  {
    name: "hotkeys",
    availableWithoutWorkspace: true,
    description: "Show browser keyboard shortcuts",
    execution: "informational",
  },
  {
    name: "fork",
    description: "Open History to fork from a user message",
    execution: "surface",
  },
  {
    name: "clone",
    description:
      "Clone the current branch into a new session without sending a prompt",
    execution: "client",
  },
  {
    name: "trust",
    description: "Manage project trust in Pi's terminal flow",
    execution: "terminal",
  },
  {
    name: "login",
    description: "Log in to a provider on this Host",
    argumentHint: "[provider]",
    execution: "surface",
  },
  {
    name: "logout",
    description: "Manage saved provider credentials on this Host",
    argumentHint: "[provider]",
    execution: "surface",
  },
  {
    name: "new",
    availableWithoutWorkspace: true,
    description: "Start a new session",
    execution: "surface",
  },
  {
    name: "compact",
    description: "Compact the current context",
    argumentHint: "[instructions]",
    execution: "host",
  },
  {
    name: "resume",
    availableWithoutWorkspace: true,
    description: "Find and resume another session",
    execution: "surface",
  },
  {
    name: "reload",
    description: "Reload Pi extensions, skills, prompts, and context files",
    execution: "host",
  },
  {
    name: "quit",
    availableWithoutWorkspace: true,
    description: "Explain how to leave the browser client",
    execution: "informational",
  },
] as const satisfies readonly PiNativeCommandDescriptor[];

const nativeByName = new Map<string, PiNativeCommandDescriptor>(
  PI_NATIVE_COMMANDS.map((command) => [command.name, command]),
);

interface CommandInvocation {
  name: string;
  argument: string;
  raw: string;
}

/** Pi's export path is one token, optionally enclosed in quotes. */
export function exportArgumentPath(argument?: string): string | undefined {
  const text = argument?.trim();
  if (!text) return undefined;
  if (text[0] === '"' || text[0] === "'") {
    const end = text.indexOf(text[0], 1);
    if (end < 0) return undefined;
    return text.slice(1, end) || undefined;
  }
  return text.split(/\s/u)[0] || undefined;
}

/** Parse ordinary command syntax or an exact name from Pi's loaded inventory. */
export function parseCommandInvocation(
  input: string,
  isKnownCommand?: (name: string) => boolean,
): CommandInvocation | null {
  const raw = input.trim();
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/u.exec(raw);
  if (!match) return null;
  const name = match[1]!;
  // Pi owns registered names. Inventory membership distinguishes punctuation
  // and Unicode commands from ordinary slash-prefixed filesystem paths.
  if (!/^[A-Za-z][A-Za-z0-9:_-]*$/u.test(name) && !isKnownCommand?.(name))
    return null;
  return {
    name,
    argument: (match[2] ?? "").trim(),
    raw,
  };
}

export function nativeCommand(
  name: string,
): PiNativeCommandDescriptor | undefined {
  return nativeByName.get(name);
}

export function parseNativeCommand(
  input: string,
): (CommandInvocation & { descriptor: PiNativeCommandDescriptor }) | null {
  const invocation = parseCommandInvocation(input);
  if (!invocation) return null;
  const descriptor = nativeCommand(invocation.name);
  return descriptor ? { ...invocation, descriptor } : null;
}
