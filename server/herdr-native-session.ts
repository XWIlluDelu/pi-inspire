import { realpath } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type {
  ExternalSessionConnection,
  ExternalSessionState,
} from "./external-session.js";
import type { HerdrClient } from "./herdr-client.js";
import { HerdrApiError } from "./herdr-control.js";
import type { HerdrNativeWriter } from "./herdr-worker-observer.js";
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

/** Public terminal control for an existing native Pi. No RPC impersonation,
 * process creation, file writes, or terminal ownership is involved. */
export class HerdrNativeSession implements ExternalSessionConnection {
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly client: NativeClient,
    private readonly writer: HerdrNativeWriter,
    private readonly sessionId: string,
    private readonly sessionFile: string,
  ) {}

  async read(): Promise<ExternalSessionState | null> {
    if (this.closed) return null;
    let response: Record<string, unknown>;
    try {
      response = await this.client.nativeAgentRequest(
        this.writer.serverId,
        this.writer.paneId,
        "agent.get",
      );
    } catch (error) {
      if (
        error instanceof HerdrApiError &&
        ["agent_not_found", "pane_not_found"].includes(error.code)
      )
        return null;
      throw error;
    }
    const agent = record(response.agent);
    if (agent.agent !== "pi" || agent.pane_id !== this.writer.paneId)
      return null;
    if (!agent.agent_session) return null;
    const ref = record(agent.agent_session);
    if (ref.source !== "herdr:pi" || ref.agent !== "pi") return null;
    if (ref.kind === "id") {
      if (ref.value !== this.sessionId) return null;
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
      if ((await canonical(ref.value)) !== (await canonical(this.sessionFile)))
        return null;
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
    return {
      status:
        status === "working" || status === "blocked"
          ? status
          : status === "idle" || status === "done" || status === "error"
            ? "idle"
            : "unknown",
    };
  }

  private async assertEmptyEditor(): Promise<void> {
    const response = await this.client.nativeAgentRequest(
      this.writer.serverId,
      this.writer.paneId,
      "agent.read",
      { source: "visible", format: "text" },
    );
    const read = record(response.read);
    if (read.pane_id !== this.writer.paneId || typeof read.text !== "string")
      throw new Error("Herdr returned an invalid Pi editor view");
    // Use the live viewport, not the cached detection snapshot. The last two
    // borders enclose the editor; a running Pi prefixes its top border with
    // "── ⠸ Working". This only checks input: transcript/state never come from text.
    const lines = read.text.split("\n");
    const borders = lines.flatMap((line, index) =>
      /^\s*─{2,}.*─{3,}\s*$/.test(line) ? [index] : [],
    );
    const [start, end] = borders.slice(-2);
    if (start === undefined || end === undefined)
      throw requestError(
        "Pi is not showing its message editor. Return to the conversation in its terminal, then send again.",
        409,
      );
    if (lines.slice(start + 1, end).some((line) => line.trim()))
      throw requestError(
        "There is an unsent draft in the Pi terminal. Send or clear that draft before sending from Inspire.",
        409,
      );
  }

  private serialize(operation: () => Promise<void>): Promise<void> {
    const pending = this.tail.then(operation);
    this.tail = pending.catch(() => undefined);
    return pending;
  }

  prompt(
    message: string,
    behavior?: "steer" | "followUp",
    beforeSend?: () => void,
  ): Promise<void> {
    return this.serialize(async () => {
      const state = await this.read();
      if (!state || this.closed)
        throw requestError(
          "This Pi terminal is no longer using this session. Reopen the session to continue.",
          409,
        );
      if (state.status === "blocked")
        throw requestError(
          "Pi is waiting for an answer in its terminal. Answer there before sending another message.",
          409,
        );
      // Treat C0 terminal controls as data-invalid, never as terminal shortcuts.
      if (/[\x00-\x08\x0b-\x1f\x7f]/.test(message))
        throw requestError(
          "The message contains unsupported terminal control characters.",
          400,
        );
      await this.assertEmptyEditor();
      beforeSend?.();
      try {
        if (behavior === "followUp" && state.status === "working") {
          await this.client.nativeAgentRequest(
            this.writer.serverId,
            this.writer.paneId,
            "pane.send_text",
            { text: message },
          );
          beforeSend?.();
          await this.client.nativeAgentRequest(
            this.writer.serverId,
            this.writer.paneId,
            "agent.send_keys",
            { keys: ["alt+enter"] },
          );
        } else {
          await this.client.nativeAgentRequest(
            this.writer.serverId,
            this.writer.paneId,
            "agent.prompt",
            { text: message },
          );
        }
      } catch (error) {
        if (
          error instanceof HerdrApiError &&
          [
            "agent_blocked",
            "agent_not_found",
            "pane_not_found",
            "agent_not_ready",
          ].includes(error.code) &&
          behavior !== "followUp"
        )
          throw error;
        throw requestError(
          "The connection was interrupted while sending. Check the conversation before sending again.",
          504,
          {
            code: "PI_RPC_OUTCOME_UNKNOWN",
            outcomeUnknown: true,
          },
        );
      }
    });
  }

  abort(): Promise<void> {
    return this.serialize(async () => {
      const state = await this.read();
      if (!state || this.closed)
        throw requestError("The Pi terminal connection has ended.", 409);
      if (state.status === "idle") return;
      await this.client.nativeAgentRequest(
        this.writer.serverId,
        this.writer.paneId,
        "agent.send_keys",
        { keys: ["esc"] },
      );
    });
  }

  close(): void {
    this.closed = true;
  }
}
