import { useState } from "react";
import { shallowEqual, store, useAppState } from "../../../src/store";
import { TaskBoard } from "./TaskBoard";
import {
  readTaskBoard,
  TASK_BOARD_TYPE,
  type TaskAction,
  type TaskItem,
  taskCommands,
} from "./types";

/** Mount this boundary, not the inner view, so session/view changes clear local UI. */
export function TaskBoardAdapter() {
  const owner = useAppState(
    (s) => `${s.transportGeneration}:${s.sessionId}:${s.transcriptViewId}`,
  );
  return <SessionTaskBoard key={owner} />;
}

function SessionTaskBoard() {
  const state = useAppState(
    (s) => ({
      sessionId: s.sessionId,
      messages: s.messages,
      commands: s.commands,
      readOnly: Boolean(s.readOnlyReason),
    }),
    shallowEqual,
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  let tasks: TaskItem[] = [];
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index]!;
    if (message.role !== "custom" || message.customType !== TASK_BOARD_TYPE)
      continue;
    const data = readTaskBoard(message.details);
    if (data) {
      tasks = data.tasks;
      break;
    }
  }
  const available = (name: string) =>
    Boolean(
      state.sessionId &&
        !state.readOnly &&
        state.commands.some(
          (command) => command.name === name && command.source === "extension",
        ),
    );
  const send = async (command: string) => {
    const name = command.split(" ", 1)[0]!;
    if (pending || !available(name)) return;
    setPending(true);
    setError(null);
    try {
      // Prepared actions leave the current Composer draft and artifacts alone.
      if (!(await store.sendPreparedCommand(`/${command}`)))
        setError(
          "The command was not accepted. Check the session's command feedback.",
        );
    } catch (error) {
      setError(error instanceof Error ? error.message : "Command failed");
    } finally {
      setPending(false);
    }
  };
  const canAct = (task: TaskItem, action: TaskAction) =>
    task.capabilities[action] && available(taskCommands[action]);
  return (
    <>
      <div className="task-board__actions">
        <button
          type="button"
          className="button button--quiet"
          disabled={pending || !available(taskCommands.show)}
          onClick={() => void send(taskCommands.show)}
        >
          Show tasks
        </button>
        <button
          type="button"
          className="button button--quiet"
          disabled={pending || !available(taskCommands.start)}
          onClick={() => void send(taskCommands.start)}
        >
          Start demo
        </button>
      </div>
      <TaskBoard
        tasks={tasks}
        selectedId={selectedId}
        pending={pending}
        error={error}
        canAct={canAct}
        onSelect={setSelectedId}
        onAction={(task, action) =>
          void send(`${taskCommands[action]} ${task.id}`)
        }
      />
    </>
  );
}
