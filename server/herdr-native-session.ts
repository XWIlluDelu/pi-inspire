import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { parseNativeCommand } from "../shared/commands.js";
import type {
  ExternalSessionConnection,
  ExternalSessionState,
} from "./external-session.js";
import type { HerdrClient } from "./herdr-client.js";
import { HerdrApiError, HerdrServerChangedError } from "./herdr-control.js";
import { herdrProcessIsLive } from "./herdr-process-group.js";
import type { HerdrNativeWriter } from "./herdr-worker-observer.js";
import { PiNativeActions } from "./pi-native-actions.js";
import { requestError } from "./request-error.js";

type NativeClient = Pick<
  HerdrClient,
  "nativeAgentRequest" | "inspectPaneProcess"
>;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Herdr returned invalid native Pi state");
  return value as Record<string, unknown>;
}

/** Herdr addresses the existing Pi; its installed extension invokes public
 * native actions. No RPC impersonation or new session writer. */
export class HerdrNativeSession implements ExternalSessionConnection {
  readonly interruptionScope = "agent" as const;
  retirementReason?: "process-exit";
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: NativeClient,
    private readonly writer: HerdrNativeWriter,
    private readonly sessionId: string,
    private readonly sessionFile: string,
    private readonly hasCompletedRebind?: (target: {
      kind: "id" | "path";
      value: string;
    }) => Promise<boolean>,
    private readonly actions?: Pick<PiNativeActions, "invoke"> &
      Partial<Pick<PiNativeActions, "taskRuns">>,
  ) {}

  async read(): Promise<ExternalSessionState | null> {
    if (this.closed) return null;
    if (
      this.writer.processIdentity &&
      !(await herdrProcessIsLive(this.writer.processIdentity))
    ) {
      this.retirementReason = "process-exit";
      return null;
    }
    try {
      const state = await this.readCurrent();
      if (
        !state &&
        !this.closed &&
        this.writer.processIdentity &&
        (await herdrProcessIsLive(this.writer.processIdentity))
      )
        throw requestError(
          "The original Pi is still alive but its session ownership could not be verified.",
          409,
          { code: "SESSION_OWNER_UNAVAILABLE" },
        );
      return state;
    } catch (error) {
      if (
        error instanceof HerdrServerChangedError ||
        (error instanceof HerdrApiError &&
          ["agent_not_found", "pane_not_found"].includes(error.code))
      )
        throw requestError(
          "The original Pi connection is unavailable. Its process has not been confirmed stopped.",
          409,
          { code: "SESSION_OWNER_UNAVAILABLE" },
        );
      throw error;
    }
  }

  private async readCurrent(): Promise<ExternalSessionState | null> {
    const response = await this.client.nativeAgentRequest(
      this.writer.serverId,
      this.writer.paneId,
      "agent.get",
    );
    const agent = record(response.agent);
    if (agent.agent !== "pi" || agent.pane_id !== this.writer.paneId)
      return null;
    if (!agent.agent_session) return null;
    const ref = record(agent.agent_session);
    if (ref.source !== "herdr:pi" || ref.agent !== "pi") return null;
    if (ref.kind === "id" && typeof ref.value === "string") {
      if (ref.value !== this.sessionId) {
        if (await this.hasCompletedRebind?.({ kind: "id", value: ref.value }))
          this.closed = true;
        return null;
      }
    } else if (
      ref.kind === "path" &&
      typeof ref.value === "string" &&
      isAbsolute(ref.value)
    ) {
      const canonical = async (path: string) =>
        realpath(path).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return resolve(path);
          throw error;
        });
      if (
        (await canonical(ref.value)) !== (await canonical(this.sessionFile))
      ) {
        if (await this.hasCompletedRebind?.({ kind: "path", value: ref.value }))
          this.closed = true;
        return null;
      }
    } else return null;
    const process = await this.client.inspectPaneProcess(
      this.writer.serverId,
      this.writer.paneId,
    );
    if (
      !process.foregroundProcessGroupId ||
      !process.foregroundProcesses.some(
        (item) =>
          item.pid === this.writer.pid &&
          item.name === "pi" &&
          item.argv?.[0] === "pi",
      )
    )
      return null;
    const status = agent.agent_status;
    const identity = this.writer.processIdentity;
    const actions =
      this.actions ??
      new PiNativeActions(
        this.writer.pid,
        this.sessionId,
        this.sessionFile,
        identity ? `linux:${identity.boot}:${identity.birth}` : undefined,
      );
    const taskRuns = await actions.taskRuns?.().catch(() => undefined);
    return {
      ...(taskRuns ? { taskRuns } : {}),
      ...(status === "error" ? { outcome: "failed" as const } : {}),
      status:
        status === "working" || status === "blocked"
          ? status
          : status === "idle" || status === "done" || status === "error"
            ? "idle"
            : "unknown",
    };
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  private action(
    action: import("../docs/examples/session-activity.js").NativeAction,
    beforeSend?: () => void,
  ): Promise<void> {
    return this.serialize(async () => {
      const state = await this.read();
      if (!state || this.closed)
        throw requestError(
          "The Pi terminal connection has ended. Reselect the session.",
          409,
        );
      if (action.type === "prompt" && state.status === "blocked")
        throw requestError(
          "Pi is waiting for an answer in its terminal. Answer there before sending another message.",
          409,
        );
      const identity = this.writer.processIdentity;
      const actions =
        this.actions ??
        new PiNativeActions(
          this.writer.pid,
          this.sessionId,
          this.sessionFile,
          identity ? `linux:${identity.boot}:${identity.birth}` : undefined,
        );
      await actions.invoke(
        action,
        (frame) =>
          this.client.nativeAgentRequest(
            this.writer.serverId,
            this.writer.paneId,
            "pane.send_text",
            { text: frame },
          ),
        () => {
          if (this.closed)
            throw requestError("The Pi terminal connection has ended.", 409);
          beforeSend?.();
        },
      );
    });
  }

  prompt(
    message: string,
    behavior?: "steer" | "followUp",
    beforeSend?: () => void,
  ): Promise<void> {
    const entered = message.trim();
    if (entered.startsWith("!") || parseNativeCommand(entered))
      return Promise.reject(
        requestError(
          "Run terminal shell and built-in commands in the original Pi terminal, or use the matching Inspire command surface.",
          409,
          { code: "NATIVE_ACTION_UNSUPPORTED" },
        ),
      );
    return this.action({ type: "prompt", message, behavior }, beforeSend);
  }

  abort(): Promise<void> {
    return this.action({ type: "abort" });
  }

  rename(name: string, beforeSend?: () => void): Promise<void> {
    return this.action({ type: "rename", name }, beforeSend);
  }

  close(): void {
    this.closed = true;
  }
}
