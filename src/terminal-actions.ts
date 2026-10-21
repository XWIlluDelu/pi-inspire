const MAX_PENDING_INSERTIONS = 20;
const MAX_TOTAL_INSERTION_CHARS = 200_000;

export type TerminalUiAction =
  | "new"
  | "next"
  | "previous"
  | "take-control"
  | "close"
  | "restart"
  | "focus"
  | "settings";

export interface TerminalActionIntent {
  action: TerminalUiAction;
  projectCwd: string;
}

type TerminalInsertionListener = () => void;
type TerminalActionListener = (intent: TerminalActionIntent) => boolean;

const pending: Array<{ projectCwd: string; text: string }> = [];
const pendingActions: TerminalActionIntent[] = [];
const listeners = new Set<TerminalInsertionListener>();
const actionListeners = new Set<TerminalActionListener>();

/** Queue text for the currently active project terminal. Delivery is local to
 * this browser and deliberately inserts without an Enter key. */
export function queueTerminalInsertion(
  text: string,
  projectCwd: string | null,
): void {
  if (!text || !projectCwd) return;
  pending.push({
    projectCwd,
    text: text.slice(0, MAX_TOTAL_INSERTION_CHARS),
  });
  while (
    pending.length > MAX_PENDING_INSERTIONS ||
    pending.reduce((total, value) => total + value.text.length, 0) >
      MAX_TOTAL_INSERTION_CHARS
  )
    pending.shift();
  for (const listener of listeners) listener();
}

export function takeTerminalInsertion(projectCwd: string): string | null {
  const index = pending.findIndex((item) => item.projectCwd === projectCwd);
  if (index < 0) return null;
  return pending.splice(index, 1)[0]?.text ?? null;
}

export function hasTerminalInsertion(projectCwd: string): boolean {
  return pending.some((item) => item.projectCwd === projectCwd);
}

export function subscribeTerminalInsertion(
  listener: TerminalInsertionListener,
): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function clearTerminalInsertions(): void {
  pending.length = 0;
}

export function queueTerminalAction(
  action: TerminalUiAction,
  projectCwd: string | null,
): void {
  if (!projectCwd) return;
  const intent = { action, projectCwd };
  for (const listener of actionListeners) {
    if (listener(intent)) return;
  }
  // Only opening surfaces may wait for lazy mounting. Terminal operations
  // must resolve a concrete target synchronously or end without a request.
  if (action !== "new" && action !== "focus" && action !== "settings") return;
  pendingActions.push(intent);
  if (pendingActions.length > MAX_PENDING_INSERTIONS) pendingActions.shift();
}

export function subscribeTerminalActions(
  listener: TerminalActionListener,
): () => void {
  actionListeners.add(listener);
  for (let index = 0; index < pendingActions.length; ) {
    if (listener(pendingActions[index]!)) pendingActions.splice(index, 1);
    else index += 1;
  }
  return () => actionListeners.delete(listener);
}

export function clearTerminalActions(): void {
  pendingActions.length = 0;
}
