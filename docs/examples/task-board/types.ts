export const TASK_BOARD_TYPE = "example-task-board";
export type TaskAction = "stop" | "retry" | "open";
export const taskCommands = {
  show: "demo-tasks-show",
  start: "demo-tasks-start",
  stop: "demo-tasks-stop",
  retry: "demo-tasks-retry",
  open: "demo-tasks-open",
} as const;
export interface TaskItem {
  id: string;
  name: string;
  status: "running" | "completed" | "stopped";
  summary: string;
  details: string;
  notes: string;
  capabilities: Record<TaskAction, boolean>;
}
export interface TaskBoardData {
  version: 1;
  tasks: TaskItem[];
}

/** Decode only this example's public data shape, never arbitrary message props. */
export function readTaskBoard(value: unknown): TaskBoardData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Partial<TaskBoardData>;
  if (data.version !== 1 || !Array.isArray(data.tasks)) return null;
  if (
    !data.tasks.every(
      (task) =>
        task &&
        typeof task === "object" &&
        typeof task.id === "string" &&
        /^[a-z0-9-]+$/i.test(task.id) &&
        typeof task.name === "string" &&
        ["running", "completed", "stopped"].includes(task.status) &&
        typeof task.summary === "string" &&
        typeof task.details === "string" &&
        typeof task.notes === "string" &&
        task.capabilities &&
        ["stop", "retry", "open"].every(
          (action) =>
            typeof task.capabilities[action as TaskAction] === "boolean",
        ),
    )
  )
    return null;
  return data as TaskBoardData;
}
