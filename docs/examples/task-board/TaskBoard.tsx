import { useEffect, useRef } from "react";
import type { TaskAction, TaskItem } from "./types";
import "./task-board.css";

export interface TaskBoardProps {
  tasks: readonly TaskItem[];
  selectedId: string | null;
  pending: boolean;
  error: string | null;
  canAct: (task: TaskItem, action: TaskAction) => boolean;
  onSelect: (id: string | null) => void;
  onAction: (task: TaskItem, action: TaskAction) => void;
}

/** Reusable list/detail presentation; the author owns data, actions and placement. */
export function TaskBoard({
  tasks,
  selectedId,
  pending,
  error,
  canAct,
  onSelect,
  onAction,
}: TaskBoardProps) {
  const task = tasks.find((task) => task.id === selectedId);
  const back = useRef<HTMLButtonElement>(null),
    list = useRef<HTMLUListElement>(null),
    previous = useRef<string | null>(null);
  const taskId = task?.id ?? null;
  useEffect(() => {
    if (taskId) back.current?.focus();
    else if (previous.current)
      Array.from(
        list.current?.querySelectorAll<HTMLButtonElement>("button") ?? [],
      )
        .find((button) => button.dataset.taskId === previous.current)
        ?.focus();
    previous.current = taskId;
  }, [taskId]);
  return (
    <section
      className="task-board"
      aria-label="Demo task board"
      aria-busy={pending}
    >
      {task ? (
        <>
          <button
            type="button"
            className="button button--quiet"
            ref={back}
            onClick={() => onSelect(null)}
          >
            Back to tasks
          </button>
          <h2>{task.name}</h2>
          <p className="task-board__status">{task.status}</p>
          <p>{task.summary}</p>
          <p>{task.details}</p>
          <h3>Notes</h3>
          <p className="task-board__notes">{task.notes || "No notes yet."}</p>
          <div className="task-board__actions">
            {(["stop", "retry", "open"] as const)
              .filter((action) => task.capabilities[action])
              .map((action) => (
                <button
                  key={action}
                  type="button"
                  className="button button--quiet"
                  disabled={pending || !canAct(task, action)}
                  onClick={() => onAction(task, action)}
                >
                  {action === "open"
                    ? "Open notes"
                    : action === "stop"
                      ? "Stop"
                      : "Retry"}
                </button>
              ))}
          </div>
        </>
      ) : (
        <>
          <h2>Demo tasks</h2>
          {tasks.length ? (
            <ul ref={list} className="task-board__list">
              {tasks.map((task) => (
                <li key={task.id}>
                  <button
                    type="button"
                    data-task-id={task.id}
                    onClick={() => onSelect(task.id)}
                  >
                    <strong>{task.name}</strong>
                    <span className="task-board__status">{task.status}</span>
                    <span>{task.summary}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p>
              No task snapshot is loaded. Use Show tasks to read the extension's
              current state.
            </p>
          )}
        </>
      )}
      {error ? (
        <p className="dialog__error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
