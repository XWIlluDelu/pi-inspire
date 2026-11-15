const MAX_PENDING_INSERTIONS = 20;
const MAX_TOTAL_INSERTION_CHARS = 200_000;

export const terminalActions = {
  new: { title: "New terminal", acceptsDeferred: true },
  next: { title: "Next terminal" },
  previous: { title: "Previous terminal" },
  "take-control": { title: "Take control of terminal" },
  restart: { title: "Restart terminal" },
  close: { title: "Close terminal" },
  focus: { title: "Toggle terminal focus", acceptsDeferred: true },
  settings: { title: "Terminal settings", acceptsDeferred: true },
} as const;

export type TerminalUiAction = keyof typeof terminalActions;

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
  if (!("acceptsDeferred" in terminalActions[action])) return;
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
