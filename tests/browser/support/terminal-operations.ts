import { randomUUID } from "node:crypto";
import { expect, type Page } from "@playwright/test";
import {
  TERMINAL_OPERATIONS_PATH,
  type TerminalIntent,
} from "../../../shared/terminal-operations";
import { hostRequest } from "./host-request";

export async function terminalOperation(page: Page, intent: TerminalIntent) {
  const host = hostRequest(page);
  const response = await host.get(TERMINAL_OPERATIONS_PATH, { maxRetries: 1 });
  expect(response.ok()).toBe(true);
  const { epoch } = await response.json();
  return host.post(TERMINAL_OPERATIONS_PATH, {
    // A stale keep-alive connection can reset. Playwright resends the same
    // receipt ID when retrying, so this cannot issue a second terminal action.
    maxRetries: 1,
    data: {
      executor: { kind: "terminal", epoch },
      operationId: randomUUID(),
      intent,
    },
  });
}
