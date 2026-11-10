/**
 * attach-control: lets a local client attach to this live Pi and control it.
 *
 * Each session context publishes a small presence record (session, current
 * branch leaf, activity, model) and serves a private local socket. A client
 * that can read the record (same OS user) can send input, Stop, rename, change
 * model or thinking, all through Pi's public extension API. It adds no tools
 * or model context.
 *
 * Install: pi install /absolute/path/to/attach-control.ts
 * Disable for one process: PI_ATTACH_CONTROL=0
 */
import { execFile as execFileCallback } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { statSync } from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const ATTACH_CONTROL_HEARTBEAT_MS = 2_000;
export const ATTACH_CONTROL_STALE_MS = 8_000;
export const ATTACH_CONTROL_MODEL_READ_TIMEOUT_MS = 15_000;
const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const execFile = promisify(execFileCallback);

export type ThinkingLevel = ReturnType<ExtensionAPI["getThinkingLevel"]>;

/** Process birth identity; a PID alone can be recycled. */
export async function processIdentity(pid: number): Promise<string> {
  if (!Number.isSafeInteger(pid) || pid < 1)
    throw new Error("Invalid process ID");
  if (process.platform === "linux") {
    const [stat, boot] = await Promise.all([
      readFile(`/proc/${pid}/stat`, "utf8"),
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const fields = stat
      .slice(stat.lastIndexOf(")") + 2)
      .trim()
      .split(/\s+/u);
    if (!fields[19] || fields[0] === "Z" || fields[0] === "X")
      throw Object.assign(new Error("Process has exited"), { code: "ESRCH" });
    return `linux:${boot.trim()}:${fields[19]}`;
  }
  if (process.platform === "darwin") {
    const { stdout } = await execFile(
      "/bin/ps",
      ["-p", String(pid), "-o", "lstart="],
      {
        encoding: "utf8",
        timeout: 1_500,
        maxBuffer: 4_096,
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
      },
    );
    if (!stdout.trim()) throw new Error("Process birth is unavailable");
    return `darwin:${stdout.trim()}`;
  }
  if (process.platform === "win32") {
    const env = (name: string) => {
      const key = Object.keys(process.env)
        .filter((key) => key.toLowerCase() === name)
        .sort()[0];
      return key ? process.env[key] : undefined;
    };
    let command = win32.join(
      env("programfiles") || "C:\\Program Files",
      "PowerShell",
      "7",
      "pwsh.exe",
    );
    for (const directory of (env("path") || "").match(/(?:[^;"]|"[^"]*")+/gu) ||
      []) {
      const candidate = win32.join(
        directory.replace(/^"|"$/gu, ""),
        "pwsh.exe",
      );
      try {
        if (statSync(candidate).isFile()) {
          command = candidate;
          break;
        }
      } catch {
        /* next PATH directory */
      }
    }
    const { stdout } = await execFile(
      command,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[System.Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToUniversalTime().Ticks`,
      ],
      {
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 4_096,
        windowsHide: true,
      },
    );
    if (!/^\d+$/u.test(stdout.trim()))
      throw new Error("Process birth is unavailable");
    return `win32:${stdout.trim()}`;
  }
  throw new Error("Process birth is unavailable on this platform");
}

/** Shared by every Pi process of this OS user, independent of any client. */
export function attachControlDirectory(): string {
  const home = homedir();
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || process.env.APPDATA;
    return join(
      local && isAbsolute(local) ? local : join(home, "AppData", "Local"),
      "pi-attach-control",
    );
  }
  if (process.platform === "darwin")
    return join(home, "Library", "Caches", "pi-attach-control");
  const runtime = process.env.XDG_RUNTIME_DIR;
  if (runtime && isAbsolute(runtime)) return join(runtime, "pi-attach-control");
  const cache = process.env.XDG_CACHE_HOME;
  return join(
    cache && isAbsolute(cache) ? cache : join(home, ".cache"),
    "pi-attach-control",
  );
}

export function attachControlEndpoint(directory: string, id: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\pi-attach-control-${id}`
    : join(directory, `${id}.sock`);
}

export interface TaskResult {
  id: string;
  outcome: "completed" | "failed" | "aborted";
  settledAt: number;
}
export interface TaskRuns {
  instanceId: string;
  activeRunId: string | null;
  settled: TaskResult[];
}

/** Picker metadata only: no provider endpoints, headers or credentials. */
export interface ModelOption {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  virtual?: boolean;
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>;
}
export interface ModelSelection {
  model: ModelOption | null;
  thinkingLevel: ThinkingLevel;
}
export interface ModelCatalog extends ModelSelection {
  models: ModelOption[];
}

export type AttachControlActivity = "working" | "blocked" | "idle";

export interface AttachControlRecord {
  version: 1;
  /** Random per session context; changes on reload and session replacement. */
  instanceId: string;
  pid: number;
  processIdentity: string;
  mode: string;
  cwd: string;
  sessionId: string;
  sessionFile: string;
  sessionName?: string;
  leafId: string | null;
  activity: AttachControlActivity;
  updatedAt: number;
  /** Optional client label from `PI_ATTACH_CONTROL_TAG`, e.g. a launcher's
   * own worker identity. */
  tag?: string;
  endpoint: string;
  token: string;
  taskRuns: TaskRuns;
  modelSelection: ModelSelection;
}

export interface ImageReference {
  path: string;
  mimeType: string;
}

export type AttachControlOperation =
  | { op: "state" }
  | {
      op: "prompt";
      message: string;
      behavior?: "steer" | "followUp";
      images?: ImageReference[];
    }
  | { op: "abort" }
  | { op: "shutdown" }
  | { op: "ui_response"; response: Record<string, unknown> }
  | { op: "rename"; name: string }
  | { op: "models" }
  | { op: "set_model"; provider: string; modelId: string }
  | { op: "set_thinking"; level: ThinkingLevel };

export type AttachControlRequest = AttachControlOperation & {
  token: string;
  /** Rejects the operation if the session context changed since discovery. */
  sessionFile?: string;
  /** The displayed branch must still be an ancestor of the live position. */
  expectedLeafId?: string | null;
};

export interface AttachControlState {
  sessionId: string;
  sessionFile: string;
  leafId: string | null;
  activity: AttachControlActivity;
  taskRuns: TaskRuns;
  modelSelection: ModelSelection;
  /** Pending standard RPC dialogs, when the launcher retains their channel. */
  uiRequests?: Record<string, unknown>[];
}

export type AttachControlResponse =
  | {
      ok: true;
      state: AttachControlState;
      models?: ModelOption[];
    }
  | { ok: false; code: string; error: string };

const THINKING_LEVELS: readonly string[] = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

export class AttachControlError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function modelOption(
  model: NonNullable<ExtensionContext["model"]>,
): ModelOption {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    ...(model.api === "pi-virtual" ? { virtual: true } : {}),
    ...(model.thinkingLevelMap
      ? { thinkingLevelMap: model.thinkingLevelMap }
      : {}),
  };
}

/** Send one request and read its single-line response. */
export function requestAttachControl<Response = AttachControlResponse>(
  endpoint: string,
  request: AttachControlRequest,
  timeoutMs = 20_000,
): Promise<Response> {
  return new Promise((resolvePromise, reject) => {
    const socket = connect(endpoint);
    let buffer = "";
    let settled = false;
    const finish = (error: Error | null, value?: Response) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolvePromise(value!);
    };
    const timer = setTimeout(
      () =>
        finish(
          new AttachControlError("TIMEOUT", "The Pi did not answer in time."),
        ),
      timeoutMs,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_RESPONSE_BYTES)
        return finish(
          new AttachControlError("TOO_LARGE", "Response exceeds the limit."),
        );
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, end)));
      } catch {
        finish(new AttachControlError("INVALID_RESPONSE", "Invalid response."));
      }
    });
    socket.on("error", (error) => finish(error));
    socket.on("close", () =>
      finish(new AttachControlError("CLOSED", "The Pi closed the connection.")),
    );
  });
}

/** A user install and a launcher's explicit copy publish one record per Pi. */
const shared = ((globalThis as Record<symbol, unknown>)[
  Symbol.for("pi.attachControl")
] ??= {
  owners: new WeakMap<object, ExtensionAPI>(),
}) as {
  owners: WeakMap<object, ExtensionAPI>;
};

export default function attachControl(pi: ExtensionAPI) {
  if (process.env.PI_ATTACH_CONTROL === "0") return;

  let context: ExtensionContext | undefined;
  let record: AttachControlRecord | undefined;
  let recordPath: string | undefined;
  let server: Server | undefined;
  const sockets = new Set<Socket>();
  let timer: ReturnType<typeof setInterval> | undefined;
  let identity: string | undefined;
  let lifecycle = 0;
  let running = false;
  let waiting = false;
  let writes = Promise.resolve();
  let activeRunId: string | null = null;
  let taskOutcome: TaskResult["outcome"] = "completed";
  let settledTasks: TaskResult[] = [];
  let catalogEpoch = 0;
  const catalogReads = new Set<AbortController>();
  // Optional launcher-side relay for a Pi started in native RPC mode. TUI
  // instances keep their ordinary terminal dialogs.
  const rpcUi = (() => {
    try {
      const value = JSON.parse(process.env.PI_ATTACH_CONTROL_RPC_UI ?? "null");
      // Child tools may launch their own Pi with inherited environment. Only
      // the launcher's direct child can expose this RPC question channel.
      return value &&
        value.parentPid === process.ppid &&
        typeof value.endpoint === "string" &&
        typeof value.token === "string"
        ? (value as { endpoint: string; token: string })
        : null;
    } catch {
      return null;
    }
  })();
  const relayUi = async (operation: AttachControlOperation) => {
    if (!rpcUi)
      throw new AttachControlError(
        "UNSUPPORTED",
        "This Pi has no retained RPC UI channel.",
      );
    const result = await requestAttachControl<
      | { ok: true; requests?: Record<string, unknown>[] }
      | { ok: false; error: string; code: string }
    >(rpcUi.endpoint, { ...operation, token: rpcUi.token });
    if (!result.ok) throw new AttachControlError(result.code, result.error);
    return result.requests ?? [];
  };

  const selection = (ctx: ExtensionContext): ModelSelection => ({
    model: ctx.model ? modelOption(ctx.model) : null,
    thinkingLevel: pi.getThinkingLevel(),
  });

  const activity = (ctx: ExtensionContext): AttachControlActivity =>
    waiting ? "blocked" : running || !ctx.isIdle() ? "working" : "idle";

  const currentState = (ctx: ExtensionContext): AttachControlState => ({
    sessionId: ctx.sessionManager.getSessionId(),
    sessionFile: resolve(ctx.cwd, ctx.sessionManager.getSessionFile() ?? ""),
    leafId: ctx.sessionManager.getLeafId(),
    activity: activity(ctx),
    taskRuns: {
      instanceId: record?.instanceId ?? "",
      activeRunId,
      settled: settledTasks,
    },
    modelSelection: selection(ctx),
  });

  const publish = (): Promise<void> => {
    const ctx = context;
    const base = record;
    const path = recordPath;
    if (!ctx || !base || !path) return writes;
    try {
      if (!ctx.sessionManager.getSessionFile()) return writes;
      const state = currentState(ctx);
      record = {
        ...base,
        sessionId: state.sessionId,
        sessionFile: state.sessionFile,
        sessionName: ctx.sessionManager.getSessionName(),
        leafId: state.leafId,
        activity: state.activity,
        taskRuns: state.taskRuns,
        modelSelection: state.modelSelection,
        updatedAt: Date.now(),
      };
    } catch {
      // A stale context after replacement is not a reason to fail a turn.
      return writes;
    }
    const snapshot = JSON.stringify(record);
    const temporary = `${path}.tmp`;
    writes = writes
      .then(async () => {
        await writeFile(temporary, snapshot, { mode: 0o600 });
        await rename(temporary, path);
      })
      .catch(async () => {
        await rm(temporary, { force: true }).catch(() => {});
      });
    return writes;
  };

  const stop = async (): Promise<void> => {
    lifecycle += 1;
    for (const read of catalogReads)
      read.abort(new Error("Pi changed session"));
    catalogReads.clear();
    if (timer) clearInterval(timer);
    timer = undefined;
    const closing = server;
    server = undefined;
    context = undefined;
    running = false;
    waiting = false;
    activeRunId = null;
    settledTasks = [];
    await writes;
    const path = recordPath;
    const endpoint = record?.endpoint;
    record = undefined;
    recordPath = undefined;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((done) =>
      closing ? closing.close(() => done()) : done(),
    );
    if (path) await rm(path, { force: true }).catch(() => {});
    if (endpoint && process.platform !== "win32")
      await rm(endpoint, { force: true }).catch(() => {});
  };

  const readModels = async (ctx: ExtensionContext): Promise<ModelOption[]> => {
    const epoch = catalogEpoch;
    const controller = new AbortController();
    const { signal } = controller;
    catalogReads.add(controller);
    const deadline = setTimeout(
      () => controller.abort(new Error("Model discovery timed out")),
      ATTACH_CONTROL_MODEL_READ_TIMEOUT_MS,
    );
    try {
      await ctx.modelRegistry.refresh({ signal });
      signal.throwIfAborted();
      if (epoch !== catalogEpoch) throw new Error("Model discovery cancelled");
      return (await ctx.modelRegistry.getAvailable()).map(modelOption);
    } finally {
      clearTimeout(deadline);
      catalogReads.delete(controller);
    }
  };

  const perform = async (
    request: AttachControlRequest,
    ctx: ExtensionContext,
  ): Promise<AttachControlResponse> => {
    const generation = lifecycle;
    // Pi hands each event a fresh context object; the session lifecycle,
    // not object identity, says whether this is still the same session.
    const unchanged = () => generation === lifecycle && context !== undefined;
    const assertBranch = () => {
      const expected = request.expectedLeafId;
      if (
        expected !== undefined &&
        expected !== null &&
        ctx.sessionManager.getLeafId() !== expected &&
        !ctx.sessionManager.getBranch().some((entry) => entry.id === expected)
      )
        throw new AttachControlError(
          "BRANCH_CHANGED",
          "Pi moved to another branch. Review the current conversation before retrying.",
        );
    };
    assertBranch();
    let models: ModelOption[] | undefined;
    let uiRequests: Record<string, unknown>[] | undefined;
    switch (request.op) {
      case "state":
        if (rpcUi) uiRequests = await relayUi({ op: "state" });
        break;
      case "ui_response":
        await relayUi(request);
        uiRequests = await relayUi({ op: "state" });
        break;
      case "prompt": {
        if (
          typeof request.message !== "string" ||
          (request.behavior !== undefined &&
            request.behavior !== "steer" &&
            request.behavior !== "followUp")
        )
          throw new AttachControlError("INVALID", "Invalid prompt.");
        const images = request.images ?? [];
        if (!Array.isArray(images) || images.length > 8)
          throw new AttachControlError("INVALID", "Invalid image references.");
        const content: Parameters<ExtensionAPI["sendUserMessage"]>[0] = [
          { type: "text", text: request.message },
        ];
        let total = 0;
        for (const image of images) {
          if (
            !image ||
            typeof image.path !== "string" ||
            !isAbsolute(image.path) ||
            !IMAGE_TYPES.includes(image.mimeType)
          )
            throw new AttachControlError("INVALID", "Invalid image reference.");
          const info = await lstat(image.path);
          total += info.size;
          if (
            !info.isFile() ||
            info.size > 16 * 2 ** 20 ||
            total > 20 * 2 ** 20
          )
            throw new AttachControlError(
              "TOO_LARGE",
              "Images exceed the budget.",
            );
          content.push({
            type: "image",
            mimeType: image.mimeType,
            data: (await readFile(image.path)).toString("base64"),
          });
        }
        if (!unchanged())
          throw new AttachControlError("CHANGED", "Pi changed session.");
        assertBranch();
        if (waiting)
          throw new AttachControlError(
            "BLOCKED",
            "Pi is waiting for an answer in its terminal.",
          );
        pi.sendUserMessage(images.length ? content : request.message, {
          deliverAs: request.behavior ?? "steer",
          expandPromptTemplates: true,
        });
        break;
      }
      case "shutdown": {
        const state = currentState(ctx);
        setImmediate(() => {
          ctx.shutdown();
          // Wake native signal shutdown too: an idle RPC loop otherwise only
          // observes the extension shutdown flag on its next stdin command.
          process.emit("SIGTERM", "SIGTERM");
        });
        return { ok: true, state };
      }
      case "abort":
        catalogEpoch += 1;
        for (const read of catalogReads) read.abort(new Error("Stopped"));
        ctx.abort();
        break;
      case "rename":
        if (typeof request.name !== "string")
          throw new AttachControlError("INVALID", "Invalid name.");
        pi.setSessionName(request.name);
        break;
      case "models":
        models = await readModels(ctx);
        break;
      case "set_model": {
        const model = ctx.modelRegistry.find(request.provider, request.modelId);
        if (!model)
          throw new AttachControlError(
            "UNKNOWN_MODEL",
            "That model is not registered in this Pi.",
          );
        if (!(await pi.setModel(model)))
          throw new AttachControlError(
            "NO_AUTH",
            "Authentication is not configured for that model's provider.",
          );
        break;
      }
      case "set_thinking":
        if (!THINKING_LEVELS.includes(request.level))
          throw new AttachControlError("INVALID", "Invalid thinking level.");
        pi.setThinkingLevel(request.level);
        break;
      default:
        throw new AttachControlError("UNSUPPORTED", "Unsupported operation.");
    }
    if (!unchanged() || !context)
      throw new AttachControlError("CHANGED", "Pi changed session.");
    void publish();
    return {
      ok: true,
      state: {
        ...currentState(context),
        ...(uiRequests ? { uiRequests } : {}),
      },
      ...(models ? { models } : {}),
    };
  };

  const serve = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let buffer = "";
    socket.setEncoding("utf8");
    const reply = (response: AttachControlResponse) => {
      if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
    };
    socket.on("error", () => {});
    socket.on("data", (chunk: string) => {
      if (buffer.includes("\n")) return;
      buffer += chunk;
      if (buffer.length > MAX_REQUEST_BYTES) {
        socket.destroy();
        return;
      }
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let request: AttachControlRequest;
      try {
        request = JSON.parse(buffer.slice(0, end));
      } catch {
        reply({ ok: false, code: "INVALID", error: "Invalid request." });
        return;
      }
      const ctx = context;
      const expected = record?.token;
      const given = Buffer.from(String(request?.token ?? ""));
      if (
        !ctx ||
        !expected ||
        given.length !== Buffer.byteLength(expected) ||
        !timingSafeEqual(given, Buffer.from(expected))
      ) {
        reply({ ok: false, code: "UNAUTHORIZED", error: "Not authorized." });
        return;
      }
      if (
        request.sessionFile !== undefined &&
        request.sessionFile !== record?.sessionFile
      ) {
        reply({ ok: false, code: "CHANGED", error: "Pi changed session." });
        return;
      }
      perform(request, ctx).then(reply, (error: unknown) =>
        reply({
          ok: false,
          code: error instanceof AttachControlError ? error.code : "FAILED",
          error: error instanceof Error ? error.message : "Request failed.",
        }),
      );
    });
  };

  pi.on("session_start", async (_event, ctx) => {
    const owner = shared.owners.get(ctx.sessionManager);
    if (owner && owner !== pi) return;
    shared.owners.set(ctx.sessionManager, pi);
    await stop();
    const generation = lifecycle;
    identity ??= await processIdentity(process.pid).catch(() => undefined);
    if (generation !== lifecycle || !identity) return;
    const directory = attachControlDirectory();
    const instanceId = randomUUID();
    const endpoint = attachControlEndpoint(directory, instanceId);
    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const listening = createServer(serve);
      await new Promise<void>((done, fail) => {
        listening.once("error", fail);
        listening.listen(endpoint, () => done());
      });
      listening.unref();
      if (generation !== lifecycle) {
        listening.close();
        return;
      }
      server = listening;
    } catch {
      // Presence without control is still useful to clients.
    }
    context = ctx;
    running = !ctx.isIdle();
    if (running) activeRunId = randomUUID();
    recordPath = join(directory, `${process.pid}-${instanceId}.json`);
    record = {
      version: 1,
      instanceId,
      pid: process.pid,
      processIdentity: identity,
      mode: ctx.mode,
      cwd: ctx.cwd,
      sessionId: "",
      sessionFile: "",
      leafId: null,
      activity: "idle",
      updatedAt: 0,
      ...(process.env.PI_ATTACH_CONTROL_TAG
        ? { tag: process.env.PI_ATTACH_CONTROL_TAG.slice(0, 200) }
        : {}),
      endpoint: server ? endpoint : "",
      token: randomBytes(24).toString("base64url"),
      taskRuns: { instanceId, activeRunId, settled: [] },
      modelSelection: selection(ctx),
    };
    await publish();
    if (generation !== lifecycle) return;
    timer = setInterval(() => void publish(), ATTACH_CONTROL_HEARTBEAT_MS);
    timer.unref();
  });

  const track = (ctx: ExtensionContext) => {
    if (!context) return false;
    context = ctx;
    return true;
  };
  pi.on("agent_start", (_event, ctx) => {
    if (!track(ctx)) return;
    running = true;
    activeRunId ??= randomUUID();
    taskOutcome = "completed";
    void publish();
  });
  pi.on("message_end", (event, ctx) => {
    if (!track(ctx)) return;
    if (event.message.role === "assistant") {
      const reason = event.message.stopReason;
      taskOutcome =
        reason === "aborted"
          ? "aborted"
          : reason === "error" || reason === "length"
            ? "failed"
            : "completed";
    }
    void publish();
  });
  pi.on("agent_before_settle", (event) => {
    if (event.outcome === "error") taskOutcome = "failed";
    else if (event.outcome === "aborted") taskOutcome = "aborted";
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!track(ctx)) return;
    running = false;
    if (activeRunId)
      settledTasks = [
        ...settledTasks.filter(
          (task) => task.settledAt > Date.now() - 15 * 60_000,
        ),
        {
          id: activeRunId,
          outcome: event.aborted ? ("aborted" as const) : taskOutcome,
          settledAt: Date.now(),
        },
      ].slice(-16);
    activeRunId = null;
    void publish();
  });
  pi.on("session_tree", (_event, ctx) => {
    if (track(ctx)) void publish();
  });
  pi.on("model_select", (_event, ctx) => {
    if (track(ctx)) void publish();
  });
  pi.on("thinking_level_select", (_event, ctx) => {
    if (track(ctx)) void publish();
  });
  pi.on("ui_prompt_start", (_event, ctx) => {
    if (!track(ctx)) return;
    waiting = true;
    void publish();
  });
  pi.on("ui_prompt_end", (_event, ctx) => {
    if (!track(ctx)) return;
    waiting = false;
    void publish();
  });
  pi.on("session_shutdown", (_event, ctx) => {
    if (shared.owners.get(ctx.sessionManager) === pi)
      shared.owners.delete(ctx.sessionManager);
    return stop();
  });
}
