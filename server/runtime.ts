import { EventEmitter } from "node:events";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { ActiveSnapshot, PromptRequest, RunState } from "../shared/contracts.js";
import { addAttachmentContext, AttachmentStore, resolveProjectFiles } from "./attachments.js";
import { PiRpcProcess } from "./pi-rpc.js";
import type { SessionCatalogLike } from "./session-catalog.js";

const REDACTED = "[redacted]";
const SENSITIVE_KEY = /(api[-_]?key|authorization|cookie|credential|password|private[-_]?key|secret|token)$/i;

export function safeProjection(value: unknown, depth = 0): unknown {
  if (depth > 20) return "[depth limited]";
  if (typeof value === "string") return value.length > 250_000 ? `${value.slice(0, 250_000)}\n…[truncated]` : value;
  if (Array.isArray(value)) return value.slice(0, 10_000).map((item) => safeProjection(item, depth + 1));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, child]) => [
      key,
      SENSITIVE_KEY.test(key) ? REDACTED : safeProjection(child, depth + 1),
    ]),
  );
}

export interface RuntimeLike {
  readonly activeCwd: string | null;
  on(event: "event", listener: (event: unknown) => void): this;
  openSession(id: string): Promise<ActiveSnapshot>;
  newSession(cwdInput: string, name?: string): Promise<ActiveSnapshot>;
  prompt(request: PromptRequest): Promise<void>;
  abort(): Promise<void>;
  compact(customInstructions?: string): Promise<unknown>;
  rename(name: string): Promise<void>;
  setModel(provider: string, modelId: string): Promise<unknown>;
  setThinkingLevel(level: string): Promise<void>;
  extensionUiResponse(response: Record<string, unknown>): Promise<void>;
  snapshot(): Promise<ActiveSnapshot>;
  close(): Promise<void>;
}

export class RuntimeController extends EventEmitter implements RuntimeLike {
  private process: PiRpcProcess | null = null;
  private cwd: string | null = null;
  private runState: RunState = "idle";
  private switchQueue: Promise<void> = Promise.resolve();
  private switching = false;
  private availableModels: unknown[] | null = null;
  private commands: unknown[] | null = null;

  constructor(
    private readonly catalog: SessionCatalogLike,
    private readonly attachments: AttachmentStore,
  ) {
    super();
  }

  get activeCwd(): string | null {
    return this.cwd;
  }

  private handleEvent = (event: unknown): void => {
    const record = event && typeof event === "object" ? (event as Record<string, unknown>) : {};
    switch (record.type) {
      case "agent_start":
        this.runState = "running";
        break;
      case "compaction_start":
        this.runState = "compacting";
        break;
      case "auto_retry_start":
        this.runState = "retrying";
        break;
      case "agent_settled":
        if (!(["aborted", "failed"] as RunState[]).includes(this.runState)) this.runState = "idle";
        this.catalog.invalidate();
        break;
      case "message_end": {
        const stopReason = (record.message as Record<string, unknown> | undefined)?.stopReason;
        if (stopReason === "aborted") this.runState = "aborted";
        if (stopReason === "error") this.runState = "failed";
        break;
      }
    }
    this.emit("event", safeProjection(event));
  };

  private enqueueSwitch<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.switchQueue.then(async () => {
      this.switching = true;
      try {
        return await operation();
      } finally {
        this.switching = false;
      }
    });
    this.switchQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async replace(cwd: string, args: string[]): Promise<void> {
    const current = this.process;
    if (current) {
      const state = await current.request<{ isStreaming?: boolean }>({ type: "get_state" });
      if (state.isStreaming) throw Object.assign(new Error("The active Pi session is still running"), { status: 409 });
      await current.stop();
      this.process = null;
      this.cwd = null;
    }

    const next = new PiRpcProcess({ cwd, args });
    next.on("event", this.handleEvent);
    next.on("exit", (error: Error) => {
      if (this.process !== next) return;
      this.process = null;
      this.cwd = null;
      this.runState = "failed";
      this.emit("event", { type: "runtime_error", error: error.message });
    });
    try {
      await next.start();
    } catch (error) {
      await next.stop();
      throw error;
    }
    this.process = next;
    this.cwd = cwd;
    this.runState = "idle";
    this.availableModels = null;
    this.commands = null;
    this.catalog.invalidate();
    this.emit("event", { type: "runtime_ready" });
  }

  async openSession(id: string): Promise<ActiveSnapshot> {
    return this.enqueueSwitch(async () => {
      const session = await this.catalog.get(id);
      if (!session) throw Object.assign(new Error("Session not found"), { status: 404 });
      await this.replace(session.cwd || process.cwd(), ["--session", session.path]);
      return this.snapshot();
    });
  }

  async newSession(cwdInput: string, name?: string): Promise<ActiveSnapshot> {
    return this.enqueueSwitch(async () => {
      const cwd = resolve(cwdInput);
      let details;
      try {
        details = await stat(cwd);
      } catch {
        throw Object.assign(new Error("Project path does not exist"), { status: 400 });
      }
      if (!details.isDirectory()) throw Object.assign(new Error("Project path is not a directory"), { status: 400 });
      const args = name?.trim() ? ["--name", name.trim().slice(0, 160)] : [];
      await this.replace(cwd, args);
      return this.snapshot();
    });
  }

  private requireProcess(): PiRpcProcess {
    if (this.switching) throw Object.assign(new Error("A session switch is in progress"), { status: 409 });
    if (!this.process) throw Object.assign(new Error("Open or create a session first"), { status: 409 });
    return this.process;
  }

  async prompt(request: PromptRequest): Promise<void> {
    const rpc = this.requireProcess();
    const message = request.message.trim();
    const resolved = await this.attachments.resolveForPrompt(request.attachmentIds);
    const projectFiles = await resolveProjectFiles(this.cwd ?? globalThis.process.cwd(), request.projectFiles);
    const fullMessage = addAttachmentContext(message, resolved.files, projectFiles);
    if (!fullMessage && resolved.images.length === 0) throw new Error("Message or attachment is required");
    const command: Record<string, unknown> = {
      type: "prompt",
      message: fullMessage,
      ...(resolved.images.length > 0 ? { images: resolved.images } : {}),
      ...(request.behavior ? { streamingBehavior: request.behavior } : {}),
    };
    await rpc.request(command);
  }

  async abort(): Promise<void> {
    await this.requireProcess().request({ type: "abort" });
  }

  async compact(customInstructions?: string): Promise<unknown> {
    return this.requireProcess().request({ type: "compact", customInstructions }, 180_000);
  }

  async rename(name: string): Promise<void> {
    await this.requireProcess().request({ type: "set_session_name", name: name.trim().slice(0, 160) });
    this.catalog.invalidate();
  }

  async setModel(provider: string, modelId: string): Promise<unknown> {
    return this.requireProcess().request({ type: "set_model", provider, modelId });
  }

  async setThinkingLevel(level: string): Promise<void> {
    await this.requireProcess().request({ type: "set_thinking_level", level });
  }

  async extensionUiResponse(response: Record<string, unknown>): Promise<void> {
    this.requireProcess().sendExtensionUiResponse(response);
  }

  async snapshot(): Promise<ActiveSnapshot> {
    if (!this.process || !this.cwd) return { active: null, runState: this.runState };
    const process = this.process;
    const [state, messages, stats, models, commands] = await Promise.all([
      process.request<Record<string, unknown>>({ type: "get_state" }),
      process.request<{ messages: unknown[] }>({ type: "get_messages" }),
      process.request({ type: "get_session_stats" }).catch(() => undefined),
      this.availableModels
        ? Promise.resolve(this.availableModels)
        : process.request<{ models: unknown[] }>({ type: "get_available_models" }).then(
            (result) => (this.availableModels = result.models),
            () => [],
          ),
      this.commands
        ? Promise.resolve(this.commands)
        : process.request<{ commands: unknown[] }>({ type: "get_commands" }).then(
            (result) => (this.commands = result.commands),
            () => [],
          ),
    ]);
    return safeProjection({
      active: {
        sessionId: String(state.sessionId ?? ""),
        sessionFile: typeof state.sessionFile === "string" ? state.sessionFile : undefined,
        sessionName: typeof state.sessionName === "string" ? state.sessionName : undefined,
        cwd: this.cwd,
        model: state.model,
        thinkingLevel: String(state.thinkingLevel ?? "off"),
        isStreaming: Boolean(state.isStreaming),
        isCompacting: Boolean(state.isCompacting),
        messages: messages.messages,
        stats,
        availableModels: models,
        commands,
      },
      runState: this.runState,
    }) as ActiveSnapshot;
  }

  async close(): Promise<void> {
    await this.switchQueue;
    await this.process?.stop();
    this.process = null;
    this.cwd = null;
  }
}
