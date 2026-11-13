import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createInspireServer } from "../../server/app.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";
import { TerminalServiceError } from "../../server/terminal-service.js";
import {
  decodeTerminalServerDataFrame,
  encodeTerminalInputFrame,
  type TerminalDescriptor,
} from "../../shared/terminal-contracts.js";
import {
  TERMINAL_OPERATIONS_PATH,
  type TerminalIntent,
} from "../../shared/terminal-operations.js";
import { hostServices } from "../fixtures/host-services.js";
import { pairedBrowser, socketAdmission } from "./fixtures/host-api.js";
import { closeWithoutPeerAck, rawWebSocket } from "./fixtures/raw-websocket.js";
import { terminalDaemonFixture } from "./fixtures/terminal-daemon.js";

const token = "terminal-transport-token";

function attachRequest(ticket: string) {
  return { type: "attach", ticket, clientId: "browser", cols: 100, rows: 30 };
}

async function expectUpgradeRefused(url: string, origin?: string) {
  const socket = new WebSocket(url, { origin });
  const [, response] = await once(socket, "unexpected-response");
  response.resume();
  expect(response.statusCode).toBe(401);
}

describe("terminal Host and daemon transport", () => {
  let backend: Awaited<ReturnType<typeof terminalDaemonFixture>>;
  let application: ReturnType<typeof createInspireServer>;
  let baseUrl: string;

  beforeEach(async () => {
    backend = await terminalDaemonFixture();
    const { directory } = backend;
    application = createInspireServer({
      token,
      ...hostServices(directory),
      preferences: new PreferencesStore(join(directory, "preferences.json")),
      resources: new ResourceStore(),
      git: {
        status: async () => ({ kind: "not-repository" }),
        diff: async (_cwd, path) => ({
          kind: "empty",
          path: {
            id: path,
            display: path,
            utf8Path: path,
            workspacePath: path,
          },
          reason: "no-changes",
        }),
      },
      terminal: backend.client,
      version: "test",
      piVersion: "test",
      distDir: join(directory, "missing-dist"),
    });
    application.server.listen(0, "127.0.0.1");
    await once(application.server, "listening");
    baseUrl = `http://127.0.0.1:${(application.server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await application?.close();
    await backend?.close();
  });

  const headers = (bearer: string) => ({
    Authorization: `Bearer ${bearer}`,
    Origin: baseUrl,
  });
  const browser = () => pairedBrowser(application.server, baseUrl, token);
  const attachTicket = async (
    bearer: string,
    terminalId: string,
  ): Promise<string> => {
    const response = await request(application.server)
      .post(`/api/terminals/${terminalId}/attach-ticket`)
      .set(headers(bearer))
      .expect(200);
    return response.body.ticket;
  };
  const terminalUrl = async (bearer: string) =>
    `${baseUrl}/terminal?ticket=${await socketAdmission(application.server, baseUrl, bearer, "terminal")}`;

  it("validates every terminal mutation before dispatching it to the daemon", async () => {
    const { bearer } = await browser();
    const api = request.agent(application.server).set(headers(bearer));
    const dispatch = vi.spyOn(backend.manager, "operate");
    const epoch = await backend.client.operationEpoch();
    const invalid = [
      { command: "create", params: { request: {} } },
      { command: "rename", params: { id: "tab", title: 42 } },
      {
        command: "reorder",
        params: { projectCwd: backend.directory, ids: ["bad/id"] },
      },
      { command: "restart", params: { id: "bad id" } },
      { command: "remove", params: { id: "tab", force: "true" } },
      {
        command: "updateSettings",
        params: { patch: { historyRetentionDays: 0 } },
      },
      { command: "clearHistory", params: { unexpected: true } },
    ];
    await api
      .post(TERMINAL_OPERATIONS_PATH)
      .send({ intent: invalid[0] })
      .expect(400);
    for (const intent of invalid) {
      const operationId = randomUUID();
      const executor = { kind: "terminal", epoch };
      const rejected = await api
        .post(TERMINAL_OPERATIONS_PATH)
        .send({ operationId, executor, intent })
        .expect(400);
      expect(rejected.body).toMatchObject({
        operationId,
        executor,
        command: intent.command,
        state: "rejected",
      });
    }
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drains attached and not-yet-attached peers without waiting for close ACKs", async () => {
    const { bearer } = await browser();
    const terminal = await backend.manager.create({ cwd: backend.directory });
    const attached = await rawWebSocket(await terminalUrl(bearer), {
      Origin: baseUrl,
    });
    let waiting: Awaited<ReturnType<typeof rawWebSocket>> | undefined;
    try {
      attached.send(attachRequest(await attachTicket(bearer, terminal.id)));
      await vi.waitFor(() =>
        expect(attached.messages).toContainEqual(
          expect.objectContaining({ type: "replay_complete" }),
        ),
      );
      waiting = await rawWebSocket(await terminalUrl(bearer), {
        Origin: baseUrl,
      });
      let shutdown: Promise<void> | undefined;
      const close = () => (shutdown ??= application.close());
      await Promise.all([
        closeWithoutPeerAck(close, attached),
        closeWithoutPeerAck(close, waiting),
      ]);
      expect(application.server.listening).toBe(false);
      await vi.waitFor(() =>
        expect(backend.manager.list().terminals).toMatchObject([
          { id: terminal.id, viewerCount: 0, status: "running" },
        ]),
      );
    } finally {
      attached.destroy();
      waiting?.destroy();
    }
  });

  it("replays terminal operations and streams bytes through the daemon to the owned PTY", async () => {
    for (const path of ["/api/terminals", "/api/terminal-settings"])
      await request(application.server).get(path).expect(401);
    const { bearer } = await browser();
    const api = request.agent(application.server).set(headers(bearer));
    await api
      .get("/api/terminal-settings")
      .expect(200, { persistOutput: false, historyRetentionDays: 30 });
    const {
      body: { epoch },
    } = await api.get("/api/terminal-operations").expect(200);
    const executor = { kind: "terminal", epoch };
    const operation = (
      intent: TerminalIntent,
      operationId: string = randomUUID(),
    ) =>
      api
        .post(TERMINAL_OPERATIONS_PATH)
        .send({ executor, operationId, intent });
    const create = (id: string, cwd = backend.directory) =>
      operation(
        { command: "create", params: { request: { cwd, cols: 90, rows: 28 } } },
        id,
      );
    const createPty = vi.spyOn(backend.manager, "create");
    const invalidId = randomUUID();
    const refusal = () => create(invalidId, "relative/project").expect(400);
    const relative = await refusal();
    expect(relative.body).toMatchObject({
      state: "rejected",
      error: { code: "invalid_cwd" },
    });
    expect((await refusal()).body).toEqual(relative.body);
    expect(createPty).toHaveBeenCalledOnce();

    const creationId = randomUUID();
    const accepted = () => create(creationId).expect(200);
    const created = await accepted();
    expect(created.body).toMatchObject({
      executor,
      operationId: creationId,
      command: "create",
      state: "completed",
    });
    expect((await accepted()).body).toEqual(created.body);
    const mismatch = await create(
      creationId,
      join(backend.directory, "another-project"),
    ).expect(409);
    expect(mismatch.body).toMatchObject({ state: "unknown" });
    expect(createPty).toHaveBeenCalledTimes(2);

    const terminal = created.body.result as TerminalDescriptor;
    expect(terminal).toMatchObject({ profileId: "bash", cols: 90, rows: 28 });
    vi.spyOn(backend.manager, "restart").mockRejectedValueOnce(
      new TerminalServiceError(
        "terminal_stop_timeout",
        503,
        "Exit unconfirmed",
      ),
    );
    const restart = await operation({
      command: "restart",
      params: { id: terminal.id },
    }).expect(503);
    expect(restart.body).toMatchObject({ state: "unknown" });
    const catalog = await api.get("/api/terminals").expect(200);
    expect(catalog.body.terminals).toMatchObject([
      { id: terminal.id, status: "running" },
    ]);
    const settings = await operation({
      command: "updateSettings",
      params: { patch: { historyRetentionDays: 14 } },
    }).expect(200);
    expect(settings.body).toMatchObject({
      state: "completed",
      result: { persistOutput: false, historyRetentionDays: 14 },
    });

    const socketUrl = (url: string) => url.replace("http:", "ws:");
    await expectUpgradeRefused(socketUrl(`${baseUrl}/terminal?token=${token}`));
    const admitted = socketUrl(await terminalUrl(bearer));
    await expectUpgradeRefused(admitted);
    await expectUpgradeRefused(admitted, baseUrl.replace("http:", "https:"));

    const sockets: WebSocket[] = [];
    const connect = async (url: string) => {
      const socket = new WebSocket(url, { origin: baseUrl });
      sockets.push(socket);
      const messages: Array<Record<string, unknown>> = [];
      const output: string[] = [];
      socket.on("message", (raw, isBinary) => {
        if (!isBinary) messages.push(JSON.parse(String(raw)));
        else
          output.push(
            Buffer.from(
              decodeTerminalServerDataFrame(raw as Buffer).data,
            ).toString(),
          );
      });
      await once(socket, "open");
      return { socket, messages, output };
    };
    const send = (socket: WebSocket, message: unknown) =>
      socket.send(JSON.stringify(message));
    try {
      vi.spyOn(backend.manager, "attach").mockRejectedValueOnce(
        new TerminalServiceError(
          "terminal_busy",
          409,
          "Terminal is restarting",
        ),
      );
      const refused = await connect(admitted);
      send(
        refused.socket,
        attachRequest(await attachTicket(bearer, terminal.id)),
      );
      await vi.waitFor(() =>
        expect(refused.messages).toContainEqual(
          expect.objectContaining({
            type: "error",
            code: "terminal_busy",
            message: "Terminal is restarting",
          }),
        ),
      );

      const attached = await connect(socketUrl(await terminalUrl(bearer)));
      const ticket = await attachTicket(bearer, terminal.id);
      send(attached.socket, attachRequest(ticket));
      await vi.waitFor(() =>
        expect(attached.messages).toContainEqual(
          expect.objectContaining({
            type: "replay_complete",
          }),
        ),
      );
      expect(attached.messages).toContainEqual(
        expect.objectContaining({
          type: "attached",
          writable: true,
          nextInputSequence: 1,
          replay: "snapshot",
          terminal: expect.objectContaining({
            id: terminal.id,
            cols: 100,
            rows: 30,
          }),
        }),
      );
      const pty = backend.spawns[0]!.pty;
      const input = Buffer.from("echo hello\r");
      attached.socket.send(encodeTerminalInputFrame(1, input));
      attached.socket.send(
        encodeTerminalInputFrame(1, Buffer.from("repeated")),
      );
      send(attached.socket, { type: "resize", cols: 110, rows: 35 });
      await vi.waitFor(() => {
        expect(
          attached.messages.filter(({ type }) => type === "input_ack"),
        ).toEqual([
          { type: "input_ack", sequence: 1 },
          { type: "input_ack", sequence: 1 },
        ]);
        expect(pty.writes).toEqual([input]);
        expect(pty.resizes.at(-1)).toEqual([110, 35]);
      });
      pty.emitData("daemon output\r\n");
      await vi.waitFor(() =>
        expect(attached.output.join("")).toContain("daemon output\r\n"),
      );

      const replay = await connect(socketUrl(await terminalUrl(bearer)));
      send(replay.socket, attachRequest(ticket));
      await vi.waitFor(() =>
        expect(replay.messages).toContainEqual(
          expect.objectContaining({
            type: "error",
            code: "terminal_ticket_invalid",
          }),
        ),
      );
      const viewer = await connect(socketUrl(await terminalUrl(bearer)));
      send(viewer.socket, {
        ...attachRequest(await attachTicket(bearer, terminal.id)),
        clientId: "second-browser",
      });
      await vi.waitFor(() =>
        expect(viewer.messages).toContainEqual(
          expect.objectContaining({ type: "attached", writable: false }),
        ),
      );
      viewer.socket.send(encodeTerminalInputFrame(1, Buffer.from("blocked")));
      await vi.waitFor(() =>
        expect(viewer.messages).toContainEqual(
          expect.objectContaining({
            type: "error",
            code: "terminal_read_only",
          }),
        ),
      );

      send(viewer.socket, { type: "take_control", cols: 130, rows: 50 });
      await vi.waitFor(() =>
        expect(attached.messages).toContainEqual(
          expect.objectContaining({
            type: "ownership",
            writable: false,
            reason: "taken",
          }),
        ),
      );
      const viewerInput = Buffer.from("echo from second browser\r");
      viewer.socket.send(encodeTerminalInputFrame(1, viewerInput));
      await vi.waitFor(() => {
        expect(pty.writes).toEqual([input, viewerInput]);
        expect(pty.resizes.at(-1)).toEqual([130, 50]);
      });
    } finally {
      for (const socket of sockets) socket.terminate();
    }
  });
});
