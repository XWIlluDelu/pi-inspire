import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  readTaskBoard,
  TASK_BOARD_TYPE,
  type TaskItem,
  taskCommands,
} from "./types.js";

/** A working UI example with cancellable demo timers, not a subagent scheduler. */
export default function (pi: ExtensionAPI) {
  let tasks: TaskItem[] = [];
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const clearTimers = () => {
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
  const update = (task: TaskItem, status: TaskItem["status"]) => {
    task.status = status;
    task.summary =
      status === "running"
        ? "Demo timer is running"
        : status === "completed"
          ? "Demo timer finished"
          : "Demo timer stopped";
    task.capabilities = {
      stop: status === "running",
      retry: status !== "running",
      open: true,
    };
  };
  const publish = () =>
    pi.sendMessage(
      {
        customType: TASK_BOARD_TYPE,
        content: tasks
          .map((task) => `${task.name}: ${task.summary}`)
          .join("\n"),
        details: { version: 1, tasks: structuredClone(tasks) },
        display: true,
      },
      { triggerTurn: false },
    );
  const run = (task: TaskItem) => {
    const previous = timers.get(task.id);
    if (previous) clearTimeout(previous);
    update(task, "running");
    timers.set(
      task.id,
      setTimeout(() => {
        timers.delete(task.id);
        update(task, "completed");
        publish();
      }, 30_000),
    );
  };
  const restoreBranch = (ctx: ExtensionContext) => {
    clearTimers();
    tasks = [];
    for (const entry of ctx.sessionManager.getBranch()) {
      if (
        entry.type === "custom_message" &&
        entry.customType === TASK_BOARD_TYPE
      ) {
        const data = readTaskBoard(entry.details);
        if (data) tasks = structuredClone(data.tasks);
      }
    }
    // Reload or native branch navigation ends local demo work, not its saved notes.
    for (const task of tasks)
      if (task.status === "running") update(task, "stopped");
  };
  pi.on("session_start", (_, ctx) => restoreBranch(ctx));
  pi.on("session_tree", (_, ctx) => restoreBranch(ctx));
  pi.on("session_shutdown", clearTimers);
  const taskFor = (id: string, ctx: ExtensionContext) => {
    const task = tasks.find((task) => task.id === id.trim());
    if (!task) ctx.ui.notify("Choose an existing demo task", "warning");
    return task;
  };
  pi.registerCommand(taskCommands.show, {
    description: "Show the current demo task board",
    handler: async () => publish(),
  });
  pi.registerCommand(taskCommands.start, {
    description: "Start three cancellable demo tasks (no model calls)",
    handler: async (_, ctx) => {
      if (timers.size) {
        ctx.ui.notify("Stop or finish the current demo first", "warning");
        return;
      }
      tasks = ["Review input", "Check references", "Summarize findings"].map(
        (name, index) => ({
          id: `task-${index + 1}`,
          name,
          status: "stopped",
          summary: "Ready",
          details:
            "A thirty-second local demonstration timer. Replace run() with your own workflow; this example starts no agents or subprocesses.",
          notes: "",
          capabilities: { stop: false, retry: true, open: true },
        }),
      );
      for (const task of tasks) run(task);
      publish();
    },
  });
  pi.registerCommand(taskCommands.stop, {
    description: "Stop a demo task by id",
    handler: async (id, ctx) => {
      const task = taskFor(id, ctx);
      if (!task?.capabilities.stop) return;
      clearTimeout(timers.get(task.id));
      timers.delete(task.id);
      update(task, "stopped");
      publish();
    },
  });
  pi.registerCommand(taskCommands.retry, {
    description: "Run a stopped or completed demo task again",
    handler: async (id, ctx) => {
      const task = taskFor(id, ctx);
      if (!task?.capabilities.retry) return;
      run(task);
      publish();
    },
  });
  pi.registerCommand(taskCommands.open, {
    description: "Open a demo task's editable notes",
    handler: async (id, ctx) => {
      const task = taskFor(id, ctx);
      if (!task?.capabilities.open || !ctx.hasUI) return;
      const notes = await ctx.ui.editor(`${task.name}: notes`, task.notes);
      if (notes === undefined) return;
      task.notes = notes;
      publish();
    },
  });
}
