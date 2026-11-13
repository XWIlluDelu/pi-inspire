import type { Route } from "@playwright/test";
import {
  type HostOperationCommand,
  type HostOperationError,
  type HostOperationResults,
  hostReceipt,
} from "../../../shared/host-operations";

export function completeOperation<Command extends HostOperationCommand>(
  route: Route,
  command: Command,
  result: HostOperationResults[Command],
) {
  return route.fulfill({
    status: command === "prompt" ? 202 : 200,
    json: {
      ...hostReceipt(command, route.request().postDataJSON()),
      state: "completed",
      result,
    },
  });
}

export function rejectOperation(
  route: Route,
  command: HostOperationCommand,
  error: HostOperationError,
) {
  return route.fulfill({
    status: error.status,
    json: {
      ...hostReceipt(command, route.request().postDataJSON()),
      state: "rejected",
      error,
    },
  });
}
