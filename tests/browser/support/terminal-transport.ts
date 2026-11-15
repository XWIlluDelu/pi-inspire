import { expect, type Page, test, type WebSocket } from "@playwright/test";
import {
  decodeTerminalInputFrame,
  decodeTerminalServerDataFrame,
  type TerminalCatalogResponse,
  type TerminalDescriptor,
  type TerminalServerControlMessage,
} from "../../../shared/terminal-contracts";
import { browserWorkspace } from "../fixtures/workspace.mjs";
import { hostRequest } from "./host-request";
import { terminalOperation } from "./terminal-operations";

export function observeTerminalSocket(page: Page, terminalId: string) {
  let socket: WebSocket | undefined;
  let attached:
    | Extract<TerminalServerControlMessage, { type: "attached" }>
    | undefined;
  let terminal: TerminalDescriptor | undefined;
  let nextInputSequence = 1;
  const inputs: string[] = [];
  page.on("websocket", (candidate) => {
    if (new URL(candidate.url()).pathname !== "/terminal") return;
    candidate.on("framereceived", ({ payload }) => {
      if (typeof payload !== "string") {
        if (terminal && candidate === socket) {
          const frame = decodeTerminalServerDataFrame(payload);
          terminal.nextOutputOffset =
            frame.offset +
            (frame.kind === "output" ? frame.data.byteLength : 0);
          terminal.resizeRevision = frame.resizeRevision;
        }
        return;
      }
      const frame = JSON.parse(payload) as TerminalServerControlMessage;
      if (frame.type === "attached" && frame.terminal.id === terminalId) {
        socket = candidate;
        attached = frame;
        terminal = { ...frame.terminal };
        nextInputSequence = frame.nextInputSequence ?? 1;
      } else if (terminal && candidate === socket && frame.type === "resized") {
        Object.assign(terminal, {
          cols: frame.cols,
          rows: frame.rows,
          resizeRevision: frame.resizeRevision,
        });
      } else if (candidate === socket && frame.type === "input_ack") {
        nextInputSequence = frame.sequence + 1;
      }
    });
    candidate.on("framesent", ({ payload }) => {
      if (candidate === socket && typeof payload !== "string")
        inputs.push(
          new TextDecoder().decode(decodeTerminalInputFrame(payload).data),
        );
    });
  });
  return {
    inputs,
    attached: () => attached && { ...attached, nextInputSequence },
    descriptor: () => terminal,
  };
}

export async function terminalCatalog(page: Page, cwd = browserWorkspace) {
  const response = await hostRequest(page).get(
    `/api/terminals?cwd=${encodeURIComponent(cwd)}`,
  );
  expect(response.ok()).toBe(true);
  return (await response.json()) as TerminalCatalogResponse;
}

function terminalFixtures(page: Page) {
  const ids = new Set<string>();
  return {
    track(id: string) {
      ids.add(id);
    },
    async remove(id: string) {
      const response = await terminalOperation(page, {
        command: "remove",
        params: { id, force: true },
      });
      expect(response.ok()).toBe(true);
      ids.delete(id);
    },
    async create(title?: string) {
      const created = await terminalOperation(page, {
        command: "create",
        params: { request: { cwd: browserWorkspace } },
      });
      expect(created.ok()).toBe(true);
      const terminal = (await created.json()).result as TerminalDescriptor;
      ids.add(terminal.id);
      if (title !== undefined) {
        const renamed = await terminalOperation(page, {
          command: "rename",
          params: { id: terminal.id, title },
        });
        expect(renamed.ok()).toBe(true);
        return (await renamed.json()).result as TerminalDescriptor;
      }
      return terminal;
    },
    async close() {
      for (const id of ids) {
        const response = await terminalOperation(page, {
          command: "remove",
          params: { id, force: true },
        });
        expect(response.ok()).toBe(true);
      }
    },
  };
}

export const terminalTest = test.extend<{
  fixtures: ReturnType<typeof terminalFixtures>;
}>({
  fixtures: async ({ page }, use) => {
    const fixtures = terminalFixtures(page);
    try {
      await use(fixtures);
    } finally {
      await fixtures.close();
    }
  },
});
