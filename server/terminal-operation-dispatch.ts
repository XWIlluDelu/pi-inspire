import type {
  TerminalCreateRequest,
  TerminalMutationMethod,
  TerminalServiceSettingsPatch,
} from "../shared/terminal-contracts.js";
import { TerminalServiceError } from "./terminal-service.js";
import type { TerminalSessionManager } from "./terminal-session-manager.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Terminal operation parameters must be an object");
  return value as Record<string, unknown>;
}

export function stringParam(
  record: Record<string, unknown>,
  key: string,
): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

/** Decode the mutation accepted by the PTY owner's receipt table. */
export function dispatchTerminalMutation(
  terminals: Pick<TerminalSessionManager, TerminalMutationMethod>,
  method: TerminalMutationMethod,
  params: unknown,
): Promise<unknown> {
  const values = asRecord(params);
  switch (method) {
    case "create":
      return terminals.create(
        asRecord(values.request) as unknown as TerminalCreateRequest,
      );
    case "rename": {
      const title = values.title;
      if (title !== null && typeof title !== "string")
        throw new Error("title must be a string or null");
      return terminals.rename(stringParam(values, "id"), { title });
    }
    case "reorder": {
      if (
        !Array.isArray(values.ids) ||
        !values.ids.every((id) => typeof id === "string")
      )
        throw new Error("ids must be an array of strings");
      return terminals.reorder(stringParam(values, "projectCwd"), values.ids);
    }
    case "restart":
      return terminals.restart(stringParam(values, "id"));
    case "remove": {
      if (typeof values.force !== "boolean")
        throw new Error("force must be a boolean");
      return terminals.remove(stringParam(values, "id"), values.force);
    }
    case "updateSettings":
      return terminals.updateSettings(
        asRecord(values.patch) as TerminalServiceSettingsPatch,
      );
    case "clearHistory":
      return terminals.clearHistory();
    default:
      throw new TerminalServiceError(
        "terminal_method_invalid",
        400,
        "Unknown terminal operation.",
      );
  }
}
