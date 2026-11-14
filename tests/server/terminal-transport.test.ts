import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { TerminalServiceError } from "../../server/terminal-service.js";
import {
  decodeTerminalServerDataFrame,
  encodeTerminalInputFrame,
  type TerminalServerControlMessage,
} from "../../shared/terminal-contracts.js";
import { TERMINAL_OPERATIONS_PATH } from "../../shared/terminal-operations.js";
import {
  closeHostApiFixture,
  hostApiFixture,
  pairedBrowser,
  socketAdmission,
  token,
} from "./fixtures/host-api.js";
import { closeWithoutPeerAck, rawWebSocket } from "./fixtures/raw-websocket.js";
import { terminalDaemonFixture } from "./fixtures/terminal-daemon.js";

const attach = (ticket: string, clientId = "browser") => ({
  type: "attach",
  ticket,
  clientId,
  cols: 100,
  rows: 30,
});

async function terminalPeer(url: string, origin: string) {
  const socket = new WebSocket(url, { origin });
  const messages: TerminalServerControlMessage[] = [];
  const output: string[] = [];
  socket.on("message", (raw, binary) => {
    if (binary)
      output.push(
        Buffer.from(
          decodeTerminalServerDataFrame(raw as Buffer).data,
        ).toString(),
      );
    else messages.push(JSON.parse(String(raw)));
  });
  await once(socket, "open");
  return {
    socket,
    messages,
    output,
    send: (message: object) => socket.send(JSON.stringify(message)),
    input: (sequence: number, data: string) =>
      socket.send(encodeTerminalInputFrame(sequence, Buffer.from(data))),
    waitFor: (message: Partial<TerminalServerControlMessage>) =>
      vi.waitFor(() =>
        expect(messages).toContainEqual(expect.objectContaining(message)),
      ),
  };
}

describe("terminal Host and daemon transport", () => {
  let backend: Awaited<ReturnType<typeof terminalDaemonFixture>>;
  let host: Awaited<ReturnType<typeof hostApiFixture>>;

  beforeEach(async () => {
    backend = await terminalDaemonFixture();
    host = await hostApiFixture({ terminal: backend.client });
  });

  afterEach(async () => {
    try {
      if (host) await closeHostApiFixture(host);
    } finally {
      await backend?.close();
    }
  });

  async function browser() {
    const {
      application: { server },
      baseUrl,
    } = host;
    const { bearer } = await pairedBrowser(server, baseUrl);
    return {
      attachTicket: async (id: string) =>
        (
          await request(server)
            .post(`/api/terminals/${id}/attach-ticket`)
            .set("Origin", baseUrl)
            .set("Authorization", `Bearer ${bearer}`)
            .expect(200)
        ).body.ticket as string,
      url: async (audience = "terminal") => {
        const ticket = await socketAdmission(server, baseUrl, bearer, audience);
        return `${baseUrl.replace("http:", "ws:")}/terminal?ticket=${ticket}`;
      },
    };
  }

  it("validates the shared terminal intent before dispatch and returns the daemon receipt", async () => {
    const {
      application: { server },
      localRequest: api,
    } = host;
    for (const path of ["/api/terminals", "/api/terminal-settings"])
      await request(server).get(path).expect(401);
    const {
      body: { epoch },
    } = await api.get(TERMINAL_OPERATIONS_PATH).expect(200);
    const executor = { kind: "terminal", epoch };
    const send = (intent: object, operationId: string = randomUUID()) =>
      api
        .post(TERMINAL_OPERATIONS_PATH)
        .send({ executor, operationId, intent });
    const dispatch = vi.spyOn(backend.manager, "operate");
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
      expect((await send(intent, operationId).expect(400)).body).toMatchObject({
        operationId,
        executor,
        command: intent.command,
        state: "rejected",
      });
    }
    expect(dispatch).not.toHaveBeenCalled();

    const create = (cwd: string, id: string) =>
      send(
        { command: "create", params: { request: { cwd, cols: 90, rows: 28 } } },
        id,
      );
    const rejectedId = randomUUID();
    const refusal = await create("relative/project", rejectedId).expect(400);
    expect(refusal.body).toMatchObject({
      state: "rejected",
      error: { code: "invalid_cwd" },
    });
    expect(
      (await create("relative/project", rejectedId).expect(400)).body,
    ).toEqual(refusal.body);

    const operationId = randomUUID();
    const created = await create(backend.directory, operationId).expect(200);
    expect(created.body).toMatchObject({
      executor,
      operationId,
      command: "create",
      state: "completed",
      result: { cols: 90, rows: 28, status: "running" },
    });
    expect(
      (await create(backend.directory, operationId).expect(200)).body,
    ).toEqual(created.body);
    expect(
      (
        await create(
          join(backend.directory, "another-project"),
          operationId,
        ).expect(409)
      ).body,
    ).toMatchObject({ state: "unknown" });
    expect(backend.spawns).toHaveLength(1);
  });

  it("fences attachment and sends one sequenced input to the current writer", async () => {
    const terminal = await backend.manager.create({ cwd: backend.directory });
    const { baseUrl } = host;
    const browserClient = await browser();
    const admission = await browserClient.url();
    for (const [url, origin] of [
      [`${baseUrl.replace("http:", "ws:")}/terminal?token=${token}`, baseUrl],
      [admission, undefined],
      [admission, baseUrl.replace("http:", "https:")],
      [await browserClient.url("events"), baseUrl],
    ] as const) {
      const socket = new WebSocket(url, { origin });
      const [, response] = await once(socket, "unexpected-response");
      response.resume();
      expect(response.statusCode).toBe(401);
    }

    const peers: WebSocket[] = [];
    async function connect(url: string) {
      const peer = await terminalPeer(url, baseUrl);
      peers.push(peer.socket);
      return peer;
    }
    try {
      const ticket = await browserClient.attachTicket(terminal.id);
      vi.spyOn(backend.manager, "attach").mockRejectedValueOnce(
        new TerminalServiceError(
          "terminal_busy",
          409,
          "Terminal is restarting",
        ),
      );
      const refused = await connect(admission);
      refused.send(attach(ticket));
      await refused.waitFor({ type: "error", code: "terminal_busy" });

      const writer = await connect(await browserClient.url());
      const writerTicket = await browserClient.attachTicket(terminal.id);
      writer.send(attach(writerTicket));
      await writer.waitFor({ type: "replay_complete" });
      await writer.waitFor({
        type: "attached",
        writable: true,
        nextInputSequence: 1,
        replay: "snapshot",
      });
      writer.input(1, "echo once\r");
      writer.input(1, "duplicate");
      await vi.waitFor(() =>
        expect(
          writer.messages.filter(({ type }) => type === "input_ack"),
        ).toEqual(Array(2).fill({ type: "input_ack", sequence: 1 })),
      );
      const pty = backend.spawns[0]!.pty;
      expect(pty.writes.map(String)).toEqual(["echo once\r"]);
      pty.emitData("daemon output\r\n");
      await vi.waitFor(() =>
        expect(writer.output.join("")).toContain("daemon output"),
      );

      const viewer = await connect(await browserClient.url());
      viewer.send(attach(writerTicket, "viewer"));
      await viewer.waitFor({ type: "error", code: "terminal_ticket_invalid" });
      const contender = await connect(await browserClient.url());
      contender.send(
        attach(await browserClient.attachTicket(terminal.id), "viewer"),
      );
      await contender.waitFor({ type: "attached", writable: false });
      contender.input(1, "blocked");
      await contender.waitFor({ type: "error", code: "terminal_read_only" });
      contender.send({ type: "take_control", cols: 130, rows: 50 });
      await writer.waitFor({
        type: "ownership",
        writable: false,
        reason: "taken",
      });
      contender.input(1, "echo current\r");
      await contender.waitFor({ type: "input_ack", sequence: 1 });
      expect(pty.writes.map(String)).toEqual(["echo once\r", "echo current\r"]);
      expect(pty.resizes.at(-1)).toEqual([130, 50]);
    } finally {
      for (const peer of peers) peer.terminate();
    }
  });

  it("drains attached and preattach peers without waiting for close ACKs", async () => {
    const terminal = await backend.manager.create({ cwd: backend.directory });
    const { application, baseUrl } = host;
    const client = await browser();
    const attached = await rawWebSocket(await client.url(), {
      Origin: baseUrl,
    });
    let waiting: Awaited<ReturnType<typeof rawWebSocket>> | undefined;
    try {
      attached.send(attach(await client.attachTicket(terminal.id)));
      await vi.waitFor(() =>
        expect(attached.messages).toContainEqual(
          expect.objectContaining({ type: "replay_complete" }),
        ),
      );
      waiting = await rawWebSocket(await client.url(), { Origin: baseUrl });
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
});
