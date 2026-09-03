import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createInspireServer } from "../../server/app.js";
import { AttachmentStore } from "../../server/attachments.js";
import { MockCatalog, MockRuntime } from "../../server/mock.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore } from "../../server/resources.js";
import type {
  TerminalAttachment,
  TerminalAttachmentSink,
  TerminalAttachOptions,
  TerminalService,
} from "../../server/terminal-service.js";
import type {
  TerminalCatalogResponse,
  TerminalDescriptor,
  TerminalServiceSettings,
} from "../../shared/terminal-contracts.js";
import { encodeTerminalInputFrame } from "../../shared/terminal-contracts.js";

const token = "terminal-transport-token";
const terminal: TerminalDescriptor = {
  catalogEpoch: "catalog-1",
  catalogRevision: 1,
  id: "terminal-1",
  projectCwd: "/tmp/project",
  title: "Bash",
  titleSource: "automatic",
  profileId: "bash",
  shellLabel: "Bash",
  currentCwd: "/tmp/project",
  currentCommand: "bash",
  commandRunning: false,
  status: "running",
  exitCode: null,
  signal: null,
  cols: 100,
  rows: 30,
  resizeRevision: 0,
  outputEpoch: "epoch-1",
  firstOutputOffset: 0,
  nextOutputOffset: 0,
  viewerCount: 0,
  hasOwner: false,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

class FakeTerminalService implements TerminalService {
  readonly input = vi.fn();
  readonly controls = vi.fn();
  readonly detach = vi.fn();
  readonly close = vi.fn(async () => {});
  attachedOptions: TerminalAttachOptions | null = null;

  list(): TerminalCatalogResponse {
    return {
      catalogEpoch: "catalog-1",
      revision: 1,
      terminals: [terminal],
      profiles: [],
    };
  }
  async create() {
    return terminal;
  }
  async rename() {
    return terminal;
  }
  async reorder() {
    return this.list();
  }
  async restart() {
    return terminal;
  }
  async remove() {
    return { catalogEpoch: "catalog-1", revision: 2 };
  }
  getSettings(): TerminalServiceSettings {
    return { persistOutput: false, historyRetentionDays: 30 };
  }
  async updateSettings() {
    return this.getSettings();
  }
  async clearHistory() {}
  async attach(
    options: TerminalAttachOptions,
    sink: TerminalAttachmentSink,
  ): Promise<TerminalAttachment> {
    this.attachedOptions = options;
    sink.sendControl({
      type: "attached",
      terminal,
      attachmentId: "attachment-1",
      writable: true,
      ownerToken: "owner-1",
      nextInputSequence: 1,
      replay: "snapshot",
    });
    sink.sendControl({ type: "replay_complete", nextOutputOffset: 0 });
    return {
      id: "attachment-1",
      terminalId: terminal.id,
      writeInput: this.input,
      control: this.controls,
      detach: this.detach,
    };
  }
}

describe("terminal HTTP and WebSocket transport", () => {
  let temporary: string;
  let application: ReturnType<typeof createInspireServer>;
  let terminalService: FakeTerminalService;
  let baseUrl: string;

  beforeEach(async () => {
    temporary = await mkdtemp(join(tmpdir(), "inspire-terminal-transport-"));
    terminalService = new FakeTerminalService();
    application = createInspireServer({
      token,
      runtime: new MockRuntime(),
      catalog: new MockCatalog(),
      attachments: new AttachmentStore(join(temporary, "uploads")),
      preferences: new PreferencesStore(join(temporary, "preferences.json")),
      resources: new ResourceStore(),
      git: {
        status: async () => ({ kind: "not-repository" }),
        diff: async (_cwd, path, side) => ({
          kind: "empty",
          path: {
            id: path,
            display: path,
            utf8Path: path,
            workspacePath: path,
          },
          side,
          reason: "no-changes",
        }),
      },
      terminal: terminalService,
      mock: true,
      version: "test",
      piVersion: "test",
      distDir: join(temporary, "missing-dist"),
    });
    await new Promise<void>((resolve) =>
      application.server.listen(0, "127.0.0.1", resolve),
    );
    const address = application.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await application.close();
    await rm(temporary, { recursive: true, force: true });
  });

  it("keeps terminal APIs authenticated", async () => {
    await request(application.server).get("/api/terminals").expect(401);
    const response = await request(application.server)
      .get("/api/terminals")
      .set("Authorization", `Bearer ${token}`)
      .expect(200);
    expect(response.body.terminals).toEqual([terminal]);
    await request(application.server).get("/api/terminal-settings").expect(401);
    await request(application.server)
      .get("/api/terminal-settings")
      .set("Authorization", `Bearer ${token}`)
      .expect(200, { persistOutput: false, historyRetentionDays: 30 });
    await request(application.server)
      .patch("/api/terminal-settings")
      .set("Authorization", `Bearer ${token}`)
      .send({ historyRetentionDays: 0 })
      .expect(400);
    await request(application.server)
      .delete(`/api/terminals/${terminal.id}`)
      .set("Authorization", `Bearer ${token}`)
      .expect(200, { catalogEpoch: "catalog-1", revision: 2 });
  });

  it("requires a paired cookie and one-use ticket before forwarding bytes", async () => {
    const queryOnly = new WebSocket(
      `${baseUrl.replace("http", "ws")}/terminal?token=${token}`,
    );
    const rejectedCode = await new Promise<number>((resolve) => {
      queryOnly.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      queryOnly.once("error", () => undefined);
    });
    expect(rejectedCode).toBe(401);

    const paired = await request(application.server)
      .post("/api/auth/pair")
      .set("Origin", baseUrl)
      .send({ token })
      .expect(204);
    const cookie = String(paired.headers["set-cookie"]).split(";", 1)[0]!;
    const ticketResponse = await request(application.server)
      .post(`/api/terminals/${terminal.id}/attach-ticket`)
      .set("Cookie", cookie)
      .set("Origin", baseUrl)
      .expect(200);
    const missingOrigin = new WebSocket(
      `${baseUrl.replace("http", "ws")}/terminal`,
      { headers: { Cookie: cookie } },
    );
    const missingOriginStatus = await new Promise<number>((resolve) => {
      missingOrigin.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      missingOrigin.once("error", () => undefined);
    });
    expect(missingOriginStatus).toBe(401);

    const wrongScheme = new WebSocket(
      `${baseUrl.replace("http", "ws")}/terminal`,
      {
        headers: { Cookie: cookie },
        origin: baseUrl.replace("http:", "https:"),
      },
    );
    const wrongSchemeStatus = await new Promise<number>((resolve) => {
      wrongScheme.once("unexpected-response", (_request, response) =>
        resolve(response.statusCode ?? 0),
      );
      wrongScheme.once("error", () => undefined);
    });
    expect(wrongSchemeStatus).toBe(401);

    const socket = new WebSocket(`${baseUrl.replace("http", "ws")}/terminal`, {
      headers: { Cookie: cookie },
      origin: baseUrl,
    });
    const messages: Array<Record<string, unknown>> = [];
    socket.on("message", (raw, isBinary) => {
      if (!isBinary) messages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        type: "attach",
        ticket: ticketResponse.body.ticket,
        clientId: "browser-a",
        cols: 100,
        rows: 30,
      }),
    );
    await vi.waitFor(() =>
      expect(
        messages.some((message) => message.type === "replay_complete"),
      ).toBe(true),
    );
    socket.send(encodeTerminalInputFrame(1, Buffer.from("echo hello\r")));
    socket.send(JSON.stringify({ type: "resize", cols: 110, rows: 35 }));
    await vi.waitFor(() => expect(terminalService.input).toHaveBeenCalled());

    expect(terminalService.attachedOptions).toMatchObject({
      terminalId: terminal.id,
      clientId: "browser-a",
    });
    expect(terminalService.input).toHaveBeenCalledWith(
      1,
      Buffer.from("echo hello\r"),
    );
    expect(terminalService.controls).toHaveBeenCalledWith({
      type: "resize",
      cols: 110,
      rows: 35,
    });

    const replay = new WebSocket(`${baseUrl.replace("http", "ws")}/terminal`, {
      headers: { Cookie: cookie },
      origin: baseUrl,
    });
    const replayMessages: Array<Record<string, unknown>> = [];
    replay.on("message", (raw, isBinary) => {
      if (!isBinary) replayMessages.push(JSON.parse(raw.toString()));
    });
    await new Promise<void>((resolve, reject) => {
      replay.once("open", resolve);
      replay.once("error", reject);
    });
    replay.send(
      JSON.stringify({
        type: "attach",
        ticket: ticketResponse.body.ticket,
        clientId: "browser-b",
        cols: 100,
        rows: 30,
      }),
    );
    await vi.waitFor(() =>
      expect(
        replayMessages.some(
          (message) => message.code === "terminal_ticket_invalid",
        ),
      ).toBe(true),
    );
    expect(terminalService.attachedOptions?.clientId).toBe("browser-a");
    replay.close();
    socket.close();
    await vi.waitFor(() => expect(terminalService.detach).toHaveBeenCalled());
  });
});
