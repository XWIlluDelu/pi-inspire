import type { ProjectFileResult } from "./api";
import type { ResourceRow } from "./resources";

export interface FileRegistryEntry {
  key: string;
  /** Reference sent to the existing authenticated resource resolver. */
  reference: string;
  workspacePath?: string;
  name: string;
  workspace: boolean;
  referenced: boolean;
  recent: boolean;
  resource?: ResourceRow;
}

function referenceOf(row: ResourceRow): string {
  return row.reference ?? row.label;
}

function canonicalKey(reference: string, workspacePath?: string): string {
  return workspacePath
    ? `workspace:${workspacePath}`
    : `reference:${reference}`;
}

/**
 * Join project-index search results and conversation references by the
 * canonical workspace location returned by the Host. The same file can carry
 * several source flags, but it has one selection key and one open action.
 */
export function buildFileRegistry(
  workspaceFiles: readonly ProjectFileResult[],
  references: readonly ResourceRow[],
  resourceWorkspacePaths: Readonly<Record<string, string>>,
  recentCount: number,
): FileRegistryEntry[] {
  const entries = new Map<string, FileRegistryEntry>();
  const order: string[] = [];
  const remember = (entry: FileRegistryEntry) => {
    const previous = entries.get(entry.key);
    if (!previous) {
      entries.set(entry.key, entry);
      order.push(entry.key);
      return;
    }
    entries.set(entry.key, {
      ...previous,
      workspace: previous.workspace || entry.workspace,
      referenced: previous.referenced || entry.referenced,
      recent: previous.recent || entry.recent,
      resource: previous.resource ?? entry.resource,
      // Prefer the canonical workspace path as the resolver input whenever
      // the file is indexed there; it is stable across citation spellings.
      reference:
        previous.workspacePath ?? entry.workspacePath ?? previous.reference,
    });
  };

  for (const file of workspaceFiles) {
    const key = canonicalKey(file.path, file.path);
    remember({
      key,
      reference: file.path,
      workspacePath: file.path,
      name: file.name,
      workspace: true,
      referenced: false,
      recent: false,
    });
  }

  references.forEach((row, index) => {
    const reference = referenceOf(row);
    const workspacePath = resourceWorkspacePaths[reference];
    const key = canonicalKey(reference, workspacePath);
    remember({
      key,
      reference: workspacePath ?? reference,
      ...(workspacePath ? { workspacePath } : {}),
      name: row.name,
      workspace: Boolean(workspacePath),
      referenced: true,
      recent: index < recentCount,
      resource: row,
    });
  });

  return order.map((key) => entries.get(key)!);
}

export function selectedWorkspacePath(state: {
  selectedResourceReference: string | null;
  resourceWorkspacePaths: Readonly<Record<string, string>>;
  resourcePreview: null | {
    status: string;
    descriptor?: { workspacePath?: string };
  };
  workspaceSelectedPath?: string | null;
}): string | null {
  const selected = state.selectedResourceReference;
  if (!selected) return state.workspaceSelectedPath ?? null;
  return (
    state.resourcePreview?.descriptor?.workspacePath ??
    state.resourceWorkspacePaths[selected] ??
    selected
  );
}
