import type { TerminalDescriptor } from "../../../shared/terminal-contracts.js";

export function terminalDescriptor(
  id: string,
  projectCwd: string,
  overrides: Partial<Omit<TerminalDescriptor, "id" | "projectCwd">> = {},
): TerminalDescriptor {
  const timestamp = "2026-01-01T00:00:00.000Z";
  return {
    catalogEpoch: "daemon-1",
    catalogRevision: 1,
    id,
    projectCwd,
    title: id,
    titleSource: "automatic",
    profileId: "bash",
    shellLabel: "Bash",
    currentCwd: projectCwd,
    currentCommand: "bash",
    commandRunning: false,
    status: "running",
    exitCode: null,
    signal: null,
    cols: 80,
    rows: 24,
    resizeRevision: 0,
    outputEpoch: "output-1",
    nextOutputOffset: 0,
    viewerCount: 1,
    hasOwner: true,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}
