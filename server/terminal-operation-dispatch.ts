import type { TerminalMutationMethod } from "../shared/terminal-contracts.js";
import {
  type TerminalService,
  TerminalServiceError,
} from "./terminal-service.js";

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Terminal operation parameters must be an object");
  return value as Record<string, unknown>;
}

function stringParam(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  return value;
}

/** Shared wire-to-service mapping. Only a receipt-owning caller may dispatch an
 * identified operation here; ordinary service methods retain their behavior. */
export function dispatchTerminalMutation(
  terminals: TerminalService,
  method: TerminalMutationMethod,
  params: unknown,
): Promise<unknown> {
  const values = asRecord(params);
  switch (method) {
    case "create":
      return terminals.create(
        asRecord(values.request) as unknown as Parameters<
          TerminalService["create"]
        >[0],
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
        asRecord(values.patch) as Parameters<
          TerminalService["updateSettings"]
        >[0],
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
