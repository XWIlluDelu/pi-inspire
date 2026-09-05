type PiNativeCommandExecution =
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
}

/**
 * Pi's built-in interactive command surface, adapted for a persistent browser
 * client. Runtime resources retain Pi's normal first-dispatch precedence;
 * `/compact` is the sole Host-owned collision exception.
 */
export const PI_NATIVE_COMMANDS = [
  {
    name: "settings",
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
    description: "Configure Pi's terminal model cycle",
    execution: "terminal",
  },
  {
    name: "export",
    description: "Export the current session to HTML",
    argumentHint: "[output.html]",
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
    name: "copy",
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
    description: "Show session, usage, and cost information",
    execution: "informational",
  },
  {
    name: "changelog",
    description: "Open installed Pi version and update details",
    execution: "surface",
  },
  {
    name: "hotkeys",
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
    description: "Clone the current branch into a new Pi session",
    execution: "terminal",
  },
  {
    name: "trust",
    description: "Manage project trust in Pi's terminal flow",
    execution: "terminal",
  },
  {
    name: "login",
    description: "Authenticate a provider in a trusted terminal",
    argumentHint: "[provider]",
    execution: "terminal",
  },
  {
    name: "logout",
    description: "Remove provider credentials in a trusted terminal",
    execution: "terminal",
  },
  {
    name: "new",
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

/** Parse one command-shaped line without deciding who owns the command. */
export function parseCommandInvocation(
  input: string,
): CommandInvocation | null {
  const raw = input.trim();
  const match = /^\/([A-Za-z][A-Za-z0-9:_-]*)(?:\s+([\s\S]*))?$/u.exec(raw);
  if (!match) return null;
  return {
    name: match[1]!,
    argument: (match[2] ?? "").trim(),
    raw,
  };
}

function nativeCommand(name: string): PiNativeCommandDescriptor | undefined {
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

/** Kept as the narrow server-side compatibility parser for existing callers. */
export function parseCompactCommand(
  input: string,
): { instructions?: string } | null {
  const command = parseNativeCommand(input);
  if (!command || command.name !== "compact") return null;
  return command.argument ? { instructions: command.argument } : {};
}
