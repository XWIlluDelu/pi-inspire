import { expect, type Page, type WebSocketRoute } from "@playwright/test";
import {
  decodeTerminalInputFrame,
  encodeTerminalServerDataFrame,
  type TerminalClientControlMessage,
  type TerminalDescriptor,
  type TerminalServerControlMessage,
} from "../../../shared/terminal-contracts";

/** Own the complete terminal stream; never mix fixture output with a native PTY. */
export async function terminalTransportFixture(
  page: Page,
  cwd: string,
  ids: string[],
) {
  const catalogEpoch = "browser-terminal-fixture";
  let revision = 1;
  const terminals = ids.map((id) => {
    const descriptor: TerminalDescriptor = {
      catalogEpoch,
      catalogRevision: revision,
      id,
      projectCwd: cwd,
      title: id,
      titleSource: "user",
      profileId: "fixture",
      shellLabel: "Fixture",
      currentCwd: cwd,
      currentCommand: "",
      commandRunning: false,
      status: "running",
      exitCode: null,
      signal: null,
      cols: 80,
      rows: 24,
      resizeRevision: 0,
      outputEpoch: `output-${id}`,
      firstOutputOffset: 0,
      nextOutputOffset: 0,
      viewerCount: 0,
      hasOwner: true,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const sockets = new Set<WebSocketRoute>();
    const output: Buffer[] = [];
    const inputs: string[] = [];
    const resizes: Array<{ cols: number; rows: number }> = [];
    const touch = () => {
      descriptor.catalogRevision = ++revision;
    };
    const send = (
      socket: WebSocketRoute,
      message: TerminalServerControlMessage,
    ) => socket.send(JSON.stringify(message));
    return {
      descriptor,
      sockets,
      output,
      inputs,
      resizes,
      nextInputSequence: 1,
      touch,
      send,
      write(text: string) {
        expect(sockets.size).toBeGreaterThan(0);
        const bytes = Buffer.from(text);
        const frame = Buffer.from(
          encodeTerminalServerDataFrame(
            "output",
            descriptor.resizeRevision,
            descriptor.nextOutputOffset,
            bytes,
          ),
        );
        output.push(bytes);
        descriptor.nextOutputOffset += bytes.length;
        touch();
        for (const socket of sockets) socket.send(frame);
      },
    };
  });
  const terminalById = (id: string) => {
    const terminal = terminals.find(({ descriptor }) => descriptor.id === id);
    if (!terminal) throw new Error(`Unknown fixture terminal: ${id}`);
    return terminal;
  };
  await page.route(/\/api\/terminals(?:\?|$)/, (route) =>
    route.fulfill({
      json: {
        catalogEpoch,
        revision,
        terminals: terminals.map(({ descriptor }) => descriptor),
        profiles: [],
      },
    }),
  );
  await page.route(/\/api\/terminals\/[^/]+\/attach-ticket$/, (route) => {
    const id = decodeURIComponent(
      new URL(route.request().url()).pathname.split("/").at(-2)!,
    );
    terminalById(id);
    return route.fulfill({
      json: { ticket: id, expiresAt: "2099-01-01T00:00:00.000Z" },
    });
  });
  await page.routeWebSocket(/\/terminal(?:\?|$)/, (socket) => {
    let terminal: (typeof terminals)[number] | undefined;
    socket.onMessage((data) => {
      if (typeof data !== "string") {
        if (!terminal) throw new Error("Terminal input before attachment");
        const frame = decodeTerminalInputFrame(data);
        terminal.inputs.push(new TextDecoder().decode(frame.data));
        terminal.nextInputSequence = frame.sequence + 1;
        terminal.send(socket, { type: "input_ack", sequence: frame.sequence });
        return;
      }
      const message = JSON.parse(data) as TerminalClientControlMessage;
      if (message.type === "attach") {
        terminal = terminalById(message.ticket);
        terminal.sockets.add(socket);
        terminal.descriptor.viewerCount = terminal.sockets.size;
        terminal.touch();
        terminal.send(socket, {
          type: "attached",
          terminal: terminal.descriptor,
          attachmentId: `attachment-${message.ticket}`,
          writable: true,
          ownerToken: `owner-${message.ticket}`,
          nextInputSequence: terminal.nextInputSequence,
          replay: "snapshot",
        });
        socket.send(
          Buffer.from(
            encodeTerminalServerDataFrame(
              "snapshot",
              terminal.descriptor.resizeRevision,
              terminal.descriptor.nextOutputOffset,
              Buffer.concat(terminal.output),
            ),
          ),
        );
        terminal.send(socket, {
          type: "replay_complete",
          nextOutputOffset: terminal.descriptor.nextOutputOffset,
        });
      } else if (message.type === "resize") {
        if (!terminal) throw new Error("Terminal resize before attachment");
        terminal.resizes.push({ cols: message.cols, rows: message.rows });
        const descriptor = terminal.descriptor;
        if (
          descriptor.cols !== message.cols ||
          descriptor.rows !== message.rows
        )
          descriptor.resizeRevision += 1;
        descriptor.cols = message.cols;
        descriptor.rows = message.rows;
        terminal.touch();
        terminal.send(socket, {
          type: "resized",
          cols: descriptor.cols,
          rows: descriptor.rows,
          resizeRevision: descriptor.resizeRevision,
        });
      } else if (message.type === "ping") {
        socket.send(JSON.stringify({ type: "heartbeat" }));
      }
    });
    socket.onClose(() => {
      if (!terminal) return;
      terminal.sockets.delete(socket);
      terminal.descriptor.viewerCount = terminal.sockets.size;
      terminal.touch();
    });
  });
  return terminals.map(({ descriptor, inputs, resizes, write }) => ({
    descriptor,
    inputs,
    resizes,
    write,
  }));
}
