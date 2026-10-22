/**
 * Optional Pi activity/presence reporter with native actions in Herdr TUI sessions.
 * Enable explicitly with: pi install /absolute/path/to/this/file.ts
 * Reporting adds no tools or model context. No service listener or new credentials.
 * Native actions use the existing Herdr terminal transport and Pi public APIs,
 * never user keybindings.
 */
import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve, win32 } from "node:path";
import { promisify } from "node:util";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionStartEvent,
} from "@earendil-works/pi-coding-agent";

export const ACTIVITY_HEARTBEAT_MS = 2_000;
export const ACTIVITY_STALE_MS = 8_000;
export const NATIVE_MODEL_READ_TIMEOUT_MS = 15_000;
const execFile = promisify(execFileCallback);

/** Shared by the reporter and its reader; a PID alone can be recycled.
 * Kept here so the optional extension remains a single, copyable file. */
export async function piActivityProcessIdentity(pid: number): Promise<string> {
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
        /* next named PATH directory */
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

/** Independent of the launcher and Pi agent directory, shared by this OS user. */
export function piActivityDirectory(): string {
  const home = homedir();
  if (process.platform === "win32") {
    const cache = process.env.LOCALAPPDATA || process.env.APPDATA;
    return join(
      cache && isAbsolute(cache) ? cache : join(home, "AppData", "Local"),
      "Inspire",
      "Cache",
      "pi-activity",
    );
  }
  if (process.platform === "darwin")
    return join(home, "Library", "Caches", "Inspire", "pi-activity");
  const cache = process.env.XDG_CACHE_HOME;
  return join(
    cache && isAbsolute(cache) ? cache : join(home, ".cache"),
    "inspire",
    "pi-activity",
  );
}

export interface NativeTaskResult {
  id: string;
  outcome: "completed" | "failed" | "aborted";
  settledAt: number;
}
export interface NativeTaskRuns {
  receiverId: string;
  activeRunId: string | null;
  settled: NativeTaskResult[];
}

/** Picker metadata only: no provider endpoints, headers or credentials. */
export interface NativeModelOption {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  virtual?: boolean;
  thinkingLevelMap?: Partial<
    Record<ReturnType<ExtensionAPI["getThinkingLevel"]>, string | null>
  >;
}
export interface NativeModelSelection {
  model: NativeModelOption | null;
  thinkingLevel: ReturnType<ExtensionAPI["getThinkingLevel"]>;
}
export interface NativeModelCatalog extends NativeModelSelection {
  models: NativeModelOption[];
}
function modelOption(
  model: NonNullable<ExtensionContext["model"]>,
): NativeModelOption {
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

export interface PiActivityRecord {
  version: 1;
  pid: number;
  /** Optional only for reports from the earlier activity-only extension. */
  processIdentity?: string;
  /** Activity observation has stopped; this is not a writer-release proof. */
  inactive?: boolean;
  /** Legacy activity teardown hint. Older reporters emitted this before disposal. */
  released?: boolean;
  sessionId: string;
  sessionFile: string;
  activity: "working" | "blocked" | "idle";
  updatedAt: number;
  taskRuns?: NativeTaskRuns;
  nativeActions?: {
    version: 2;
    receiverId: string;
    images?: true;
    models?: true;
    modelSelection?: NativeModelSelection;
  };
}

/** Host-managed image files; bytes stay outside the bounded action envelope. */
export interface NativeImageReference {
  path: string;
  mimeType: string;
}

export type NativeAction =
  | {
      type: "prompt";
      message: string;
      behavior?: "steer" | "followUp";
      images?: NativeImageReference[];
    }
  | { type: "abort" }
  | { type: "rename"; name: string }
  | { type: "get_models" }
  | { type: "set_model"; provider: string; modelId: string }
  | {
      type: "set_thinking";
      level: ReturnType<ExtensionAPI["getThinkingLevel"]>;
    };
export interface NativeActionRequest {
  receiverId: string;
  operationId: string;
  pid: number;
  processIdentity: string;
  sessionId: string;
  sessionFile: string;
  action: NativeAction;
  modelState?: NativeModelSelection | NativeModelCatalog;
  result?: NativeActionResult;
}
interface NativeActionResult {
  operationId: string;
  status: "invoked" | "rejected";
  code?: string;
  message?: string;
}
const ACTION_PREFIX = "\x1b]777;inspire-native;";
export function nativeActionFrame(
  receiverId: string,
  operationId: string,
): string {
  return `${ACTION_PREFIX}${receiverId};${operationId}\x07`;
}
export function nativeActionPath(
  directory: string,
  operationId: string,
): string {
  return join(directory, "actions", operationId + ".json");
}

const fileKey = Symbol.for("inspire.piSessionPresence.files");
function reportFiles(): WeakMap<object, string> {
  const state = globalThis as typeof globalThis & {
    [fileKey]?: WeakMap<object, string>;
  };
  return (state[fileKey] ??= new WeakMap<object, string>());
}

interface Handoff {
  file: string;
  from: string;
  to: string;
  reason: "new" | "resume" | "fork";
}
const handoffKey = Symbol.for("inspire.piSessionPresence.handoffs");
function handoffs(): Map<string, Handoff> {
  const state = globalThis as typeof globalThis & {
    [handoffKey]?: Map<string, Handoff>;
  };
  return (state[handoffKey] ??= new Map<string, Handoff>());
}

function reportFile(
  manager: ExtensionContext["sessionManager"],
  event: SessionStartEvent,
  cwd: string,
): string {
  const files = reportFiles();
  let file = files.get(manager);
  const current = manager.getSessionFile();
  if (!file && current && event.previousSessionFile) {
    const from = resolve(cwd, event.previousSessionFile);
    const to = resolve(cwd, current);
    const matches = [...handoffs().values()].filter(
      (handoff) =>
        handoff.reason === event.reason &&
        handoff.from === from &&
        handoff.to === to,
    );
    // A fresh native session_start follows completion of the outgoing shutdown
    // handlers and disposal. Rebind the same producer atomically, never on the
    // earlier session_shutdown event. Ambiguous SDK handoffs retain old fences.
    if (matches.length === 1) file = matches[0]!.file;
  }
  if (!file)
    file = join(piActivityDirectory(), `${process.pid}-${randomUUID()}.json`);
  handoffs().delete(file);
  files.set(manager, file);
  return file;
}

export default function (pi: ExtensionAPI) {
  let file: string | undefined;
  let context: ExtensionContext | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running = false;
  let waiting = false;
  let writes = Promise.resolve();
  let lastRecord: PiActivityRecord | undefined;
  let identity: string | undefined;
  let retired = false;
  let lifecycle = 0;
  let receiverId: string | undefined;
  const catalogReads = new Set<AbortController>();
  let catalogEpoch = 0;
  let activeRunId: string | null = null;
  let taskOutcome: NativeTaskResult["outcome"] = "completed";
  let settledTasks: NativeTaskResult[] = [];
  let unsubscribe: (() => void) | undefined;
  const invocations = new Map<string, Promise<void>>();

  const write = (record: PiActivityRecord): Promise<void> => {
    if (!file) return writes;
    const target = file;
    const temporary = `${target}.tmp`;
    lastRecord = record;
    // Capture each publication before queuing it, including session replacement.
    writes = writes
      .then(async () => {
        await mkdir(piActivityDirectory(), { recursive: true, mode: 0o700 });
        await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
        await rename(temporary, target);
      })
      .catch(async () => {
        // Telemetry failure must never fail a Pi turn.
        await rm(temporary, { force: true }).catch(() => {});
      });
    return writes;
  };

  const selection = (ctx: ExtensionContext): NativeModelSelection => ({
    model: ctx.model ? modelOption(ctx.model) : null,
    thinkingLevel: pi.getThinkingLevel(),
  });

  const publish = (): Promise<void> => {
    if (!context) return writes;
    try {
      const sessionFile = context.sessionManager.getSessionFile();
      if (!sessionFile) return writes;
      return write({
        version: 1,
        pid: process.pid,
        ...(identity ? { processIdentity: identity } : {}),
        sessionId: context.sessionManager.getSessionId(),
        sessionFile: resolve(context.cwd, sessionFile),
        activity: waiting
          ? "blocked"
          : running || !context.isIdle()
            ? "working"
            : "idle",
        updatedAt: Date.now(),
        ...(receiverId
          ? {
              taskRuns: { receiverId, activeRunId, settled: settledTasks },
              nativeActions: {
                version: 2,
                receiverId,
                images: true,
                models: true,
                modelSelection: selection(context),
              },
            }
          : {}),
      });
    } catch {
      // Invalidated context is not evidence that the owning process exited.
      return writes;
    }
  };

  const stop = async (markInactive: boolean): Promise<void> => {
    unsubscribe?.();
    unsubscribe = undefined;
    receiverId = undefined;
    for (const read of catalogReads)
      read.abort(new Error("The native action receiver changed"));
    catalogReads.clear();
    activeRunId = null;
    settledTasks = [];
    invocations.clear();
    if (timer) clearInterval(timer);
    timer = undefined;
    context = undefined;
    running = false;
    waiting = false;
    await writes;
    if (markInactive && lastRecord && !lastRecord.inactive) {
      await write({
        ...lastRecord,
        inactive: true,
        activity: "idle",
        updatedAt: Date.now(),
      });
    }
  };

  const readModels = async (
    ctx: ExtensionContext,
    path: string,
    epoch: number,
  ) => {
    if (epoch !== catalogEpoch)
      throw new Error("Model discovery cancelled by Stop");
    const controller = new AbortController();
    const { signal } = controller;
    catalogReads.add(controller);
    const deadline = setTimeout(
      () => controller.abort(new Error("Native model discovery timed out")),
      NATIVE_MODEL_READ_TIMEOUT_MS,
    );
    // Removing the private request cancels an abandoned Host read. This never
    // admits work: only the terminal frame above can start discovery.
    const abandoned = setInterval(() => {
      void lstat(path).catch(() =>
        controller.abort(new Error("Native model discovery was cancelled")),
      );
    }, 250);
    let onAbort!: () => void;
    try {
      return await Promise.race([
        (async () => {
          await ctx.modelRegistry.refresh({ signal });
          signal.throwIfAborted();
          const models = await ctx.modelRegistry.getAvailable();
          signal.throwIfAborted();
          return models.map(modelOption);
        })(),
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason);
          signal.addEventListener("abort", onAbort, { once: true });
          if (signal.aborted) onAbort();
        }),
      ]);
    } finally {
      clearTimeout(deadline);
      clearInterval(abandoned);
      signal.removeEventListener("abort", onAbort);
      catalogReads.delete(controller);
    }
  };

  // Payload files are transport data, not a polled execution queue. Only an
  // explicit frame on the existing Herdr channel invokes a native action.
  const receive = (data: string): { consume: true } | undefined => {
    if (data.startsWith("\x1b[200~") && data.endsWith("\x1b[201~"))
      data = data.slice(6, -6);
    if (!data.startsWith(ACTION_PREFIX)) return;
    const match = /^([0-9a-f-]{36});([0-9a-f-]{36})\x07$/.exec(
      data.slice(ACTION_PREFIX.length),
    );
    if (!match || !context || !receiverId) return { consume: true };
    const receiver = receiverId,
      ctx = context,
      generation = lifecycle;
    const operationId = match[2]!;
    const readEpoch = catalogEpoch;
    if (match[1] !== receiver) return { consume: true };
    if (!invocations.has(operationId)) {
      const run = async () => {
        const result: NativeActionResult = { operationId, status: "rejected" };
        const path = nativeActionPath(piActivityDirectory(), operationId);
        let request: NativeActionRequest | undefined;
        try {
          const info = await lstat(path);
          if (!info.isFile() || info.size > 4 * 1024 * 1024)
            throw new Error("Invalid action payload");
          request = JSON.parse(await readFile(path, "utf8"));
          if (
            generation !== lifecycle ||
            receiverId !== receiver ||
            !context ||
            !request ||
            request.receiverId !== receiver ||
            request.operationId !== operationId ||
            request.pid !== process.pid ||
            request.processIdentity !== identity ||
            request.sessionId !== ctx.sessionManager.getSessionId() ||
            request.sessionFile !==
              resolve(ctx.cwd, ctx.sessionManager.getSessionFile() ?? "")
          )
            throw new Error("The native action target changed");
          const action = request.action;
          if (action.type === "prompt") {
            if (
              typeof action.message !== "string" ||
              (action.behavior !== undefined &&
                action.behavior !== "steer" &&
                action.behavior !== "followUp")
            )
              throw new Error("Invalid prompt action");
            if (waiting) {
              result.code = "NATIVE_INPUT_BLOCKED";
              throw new Error(
                "Pi is waiting for an answer in its terminal. Answer there before sending another message.",
              );
            }
            const images = action.images ?? [];
            if (!Array.isArray(images) || images.length > 8)
              throw new Error("Invalid image references");
            let imageBytes = 0;
            const content: Parameters<ExtensionAPI["sendUserMessage"]>[0] = [
              { type: "text", text: action.message },
            ];
            for (const image of images) {
              if (
                !image ||
                typeof image.path !== "string" ||
                !isAbsolute(image.path) ||
                ![
                  "image/png",
                  "image/jpeg",
                  "image/gif",
                  "image/webp",
                ].includes(image.mimeType)
              )
                throw new Error("Invalid image reference");
              const info = await lstat(image.path);
              imageBytes += info.size;
              if (
                !info.isFile() ||
                info.size > 16 * 1024 * 1024 ||
                imageBytes > 20 * 1024 * 1024
              )
                throw new Error("Image references exceed the prompt budget");
              content.push({
                type: "image",
                mimeType: image.mimeType,
                data: (await readFile(image.path)).toString("base64"),
              });
            }
            // Loading images is asynchronous: recheck the captured receiver and
            // native dialog before invoking Pi. Ordinary editor drafts stay intact.
            if (generation !== lifecycle || receiverId !== receiver)
              throw new Error("The native action target changed");
            if (waiting) {
              result.code = "NATIVE_INPUT_BLOCKED";
              throw new Error(
                "Pi is waiting for an answer in its terminal. Answer there before sending another message.",
              );
            }
            pi.sendUserMessage(images.length ? content : action.message, {
              deliverAs: action.behavior ?? "steer",
              expandPromptTemplates: true,
            });
          } else if (action.type === "abort") {
            catalogEpoch++;
            for (const read of catalogReads)
              read.abort(new Error("Model discovery cancelled by Stop"));
            ctx.abort();
          } else if (
            action.type === "rename" &&
            typeof action.name === "string"
          )
            pi.setSessionName(action.name);
          else if (
            action.type === "get_models" ||
            action.type === "set_model" ||
            action.type === "set_thinking"
          ) {
            if (action.type === "set_model") {
              const model = ctx.modelRegistry.find(
                action.provider,
                action.modelId,
              );
              if (!model)
                throw new Error("That model is not registered in this Pi.");
              if (!(await pi.setModel(model)))
                throw new Error(
                  "Authentication is not configured for that model's provider.",
                );
            } else if (action.type === "set_thinking") {
              if (
                ![
                  "off",
                  "minimal",
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                  "max",
                ].includes(action.level)
              )
                throw new Error("Invalid thinking level");
              pi.setThinkingLevel(action.level);
            }
            // Setters report their result without re-running unrelated provider
            // discovery. Catalog refresh is a separate, read-only action.
            const models =
              action.type === "get_models"
                ? await readModels(ctx, path, readEpoch)
                : undefined;
            if (generation !== lifecycle || receiverId !== receiver)
              throw new Error("The native action target changed");
            // Keep catalog data outside the small presence record. Reuse this
            // invocation's private payload; r+ cannot recreate a retired request.
            request.modelState = {
              ...selection(ctx),
              ...(models ? { models } : {}),
            };
          } else throw new Error("Unsupported native action");
          // Invocation is not queue admission, completion or persistence.
          // Pi owns the ensuing work and reports asynchronous native errors.
          result.status = "invoked";
        } catch (error) {
          result.message =
            error instanceof Error ? error.message : "Native action rejected";
        }
        if (generation === lifecycle && receiverId === receiver && request) {
          // Each invocation owns its receipt; concurrent Stop and discovery
          // cannot overwrite one another in the presence record.
          request.result = result;
          let response = JSON.stringify(request);
          if (Buffer.byteLength(response) > 4 * 1024 * 1024) {
            delete request.modelState;
            request.result = {
              operationId,
              status: "rejected",
              message:
                "The native model catalog exceeds the action payload limit",
            };
            response = JSON.stringify(request);
          }
          try {
            const payload = await open(path, "r+");
            try {
              await payload.truncate(0);
              await payload.writeFile(response);
            } finally {
              await payload.close();
            }
          } catch {
            // The Host may have retired this request. Never recreate it.
          }
          await publish();
        }
      };
      invocations.set(operationId, run());
      if (invocations.size > 32)
        invocations.delete(invocations.keys().next().value!);
    } else void invocations.get(operationId)!.then(() => publish());
    return { consume: true };
  };

  pi.on("session_start", async (event, ctx) => {
    const generation = ++lifecycle;
    retired = false;
    await stop(false);
    if (lifecycle !== generation) return;
    // Reload reuses the manager; completed replacements transfer its producer.
    file = reportFile(ctx.sessionManager, event, ctx.cwd);
    const bridgeCommand = process.env.INSPIRE_BRANCH_COMMAND;
    if (
      ctx.mode === "rpc" &&
      bridgeCommand &&
      pi.getCommands().some((command) => command.name === bridgeCommand)
    ) {
      await stop(true);
      return;
    }
    lastRecord = undefined;
    const birth = await piActivityProcessIdentity(process.pid).catch(
      () => undefined,
    );
    if (lifecycle !== generation) return;
    identity = birth;
    context = ctx;
    running = !ctx.isIdle();
    if (
      ctx.mode === "tui" &&
      identity &&
      process.env.HERDR_ENV === "1" &&
      process.env.HERDR_PANE_ID &&
      process.env.HERDR_SOCKET_PATH
    ) {
      receiverId = randomUUID();
      if (running) activeRunId = randomUUID();
      unsubscribe = ctx.ui.onTerminalInput(receive);
    }
    await publish();
    if (lifecycle !== generation) return;
    timer = setInterval(() => {
      void publish();
    }, ACTIVITY_HEARTBEAT_MS);
    timer.unref();
  });
  pi.on("before_agent_start", (_event, ctx) => {
    if (!context) return;
    context = ctx;
    running = true;
    activeRunId ??= randomUUID();
    return publish();
  });
  pi.on("agent_start", (_event, ctx) => {
    if (!context) return;
    context = ctx;
    running = true;
    activeRunId ??= randomUUID();
    taskOutcome = "completed";
    return publish();
  });
  pi.on("message_end", (event) => {
    if (!context || event.message.role !== "assistant") return;
    const message = event.message;
    taskOutcome =
      message.stopReason === "aborted" ||
      (message.stopReason === "error" &&
        message.errorMessage?.trim() === "This operation was aborted")
        ? "aborted"
        : message.stopReason === "error" || message.stopReason === "length"
          ? "failed"
          : "completed";
  });
  pi.on("agent_before_settle", (event) => {
    if (event.outcome === "error") taskOutcome = "failed";
    else if (event.outcome === "aborted") taskOutcome = "aborted";
  });
  pi.on("agent_settled", (event, ctx) => {
    if (!context) return;
    context = ctx;
    running = false;
    if (activeRunId) {
      settledTasks = [
        ...settledTasks.filter(
          (item) => item.settledAt > Date.now() - 15 * 60_000,
        ),
        {
          id: activeRunId,
          outcome: event.aborted ? ("aborted" as const) : taskOutcome,
          settledAt: Date.now(),
        },
      ].slice(-16);
      activeRunId = null;
    }
    return publish();
  });
  pi.on("ui_prompt_start", () => {
    if (!context) return;
    waiting = true;
    return publish();
  });
  pi.on("ui_prompt_end", () => {
    if (!context) return;
    waiting = false;
    return publish();
  });
  pi.on("session_shutdown", (event, ctx) => {
    if (retired) return writes;
    retired = true;
    lifecycle++;
    if (
      file &&
      lastRecord &&
      event.targetSessionFile &&
      (event.reason === "new" ||
        event.reason === "resume" ||
        event.reason === "fork")
    ) {
      handoffs().set(file, {
        file,
        from: lastRecord.sessionFile,
        to: resolve(ctx.cwd, event.targetSessionFile),
        reason: event.reason,
      });
      // The outgoing manager may later be reused by an independent SDK runtime.
      // It must not share the transferred producer with the replacement.
      const files = reportFiles();
      const manager = ctx.sessionManager;
      if (files.get(manager) === file) files.delete(manager);
    }
    // A shutdown event starts cleanup; it does not confirm a drained writer.
    // Quit without a completed replacement remains fenced until process exit.
    return stop(event.reason !== "reload");
  });
}
