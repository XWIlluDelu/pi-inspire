import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type NativeAction,
  type NativeActionRequest,
  nativeActionFrame,
  nativeActionPath,
  type PiActivityRecord,
  piActivityDirectory,
  piActivityProcessIdentity,
} from "../docs/examples/session-activity.js";
import { isPiActivityRecord } from "./pi-session-activity.js";
import { requestError } from "./request-error.js";

/** Discovery is not authority. Requests still travel through the captured Herdr
 * control connection; only its target TUI can consume the invocation frame. */
export class PiNativeActions {
  constructor(
    private readonly pid: number,
    private readonly sessionId: string,
    private readonly sessionFile: string,
    private readonly expectedIdentity?: string,
    private readonly directory = piActivityDirectory(),
  ) {}

  private async target(): Promise<{ file: string; record: PiActivityRecord }> {
    const identity = await piActivityProcessIdentity(this.pid);
    if (this.expectedIdentity && identity !== this.expectedIdentity)
      throw requestError("The original Pi process has retired.", 409, {
        code: "SESSION_OWNER_UNAVAILABLE",
      });
    const path = await realpath(this.sessionFile);
    const matches: Array<{ file: string; record: PiActivityRecord }> = [];
    for (const name of await readdir(this.directory).catch(
      () => [] as string[],
    )) {
      if (!new RegExp(`^${this.pid}-[0-9a-f-]{36}\\.json$`).test(name))
        continue;
      try {
        const file = join(this.directory, name);
        const stat = await lstat(file);
        if (!stat.isFile() || stat.size > 16_384) continue;
        const record: unknown = JSON.parse(await readFile(file, "utf8"));
        if (
          !isPiActivityRecord(record) ||
          record.inactive ||
          record.released ||
          record.pid !== this.pid ||
          record.processIdentity !== identity ||
          record.sessionId !== this.sessionId ||
          (await realpath(record.sessionFile)) !== path ||
          record.nativeActions?.version !== 1 ||
          !/^[0-9a-f-]{36}$/.test(record.nativeActions.receiverId)
        )
          continue;
        matches.push({ file, record });
      } catch {
        /* an unavailable report grants no action capability */
      }
    }
    if (matches.length !== 1)
      throw requestError(
        "Load the updated Inspire session-activity extension in the original Pi terminal with /reload, then reselect this session.",
        409,
        { code: "NATIVE_ACTIONS_UNAVAILABLE" },
      );
    return matches[0]!;
  }

  /** Read-only outcome evidence bound to the same validated receiver as actions. */
  async taskRuns(): Promise<
    import("../docs/examples/session-activity.js").NativeTaskRuns | undefined
  > {
    const { record } = await this.target();
    const runs = record.taskRuns;
    if (
      !runs ||
      runs.receiverId !== record.nativeActions?.receiverId ||
      !(
        runs.activeRunId === null ||
        (typeof runs.activeRunId === "string" &&
          /^[0-9a-f-]{36}$/.test(runs.activeRunId))
      ) ||
      !Array.isArray(runs.settled) ||
      runs.settled.length > 16 ||
      !runs.settled.every(
        (item) =>
          typeof item.id === "string" &&
          /^[0-9a-f-]{36}$/.test(item.id) &&
          ["completed", "failed", "aborted"].includes(item.outcome) &&
          Number.isSafeInteger(item.settledAt) &&
          item.settledAt > 0,
      )
    )
      return undefined;
    return runs;
  }

  async invoke(
    action: NativeAction,
    send: (frame: string) => Promise<unknown>,
    beforeSend?: () => void,
  ): Promise<void> {
    const { file, record } = await this.target();
    const receiverId = record.nativeActions!.receiverId;
    const operationId = randomUUID();
    const request: NativeActionRequest = {
      receiverId,
      operationId,
      pid: this.pid,
      processIdentity: record.processIdentity!,
      sessionId: this.sessionId,
      sessionFile: record.sessionFile,
      action,
    };
    const path = nativeActionPath(this.directory, operationId);
    await mkdir(join(this.directory, "actions"), {
      recursive: true,
      mode: 0o700,
    });
    try {
      await writeFile(path, JSON.stringify(request), {
        mode: 0o600,
        flag: "wx",
      });
      beforeSend?.();
      try {
        await send(nativeActionFrame(receiverId, operationId));
        // This bounds receipt observation, not native model work. Never resend.
        const until = Date.now() + 5_000;
        do {
          const latest: PiActivityRecord = JSON.parse(
            await readFile(file, "utf8"),
          );
          if (
            latest.nativeActions?.receiverId !== receiverId ||
            latest.inactive ||
            latest.sessionId !== request.sessionId ||
            latest.sessionFile !== request.sessionFile ||
            latest.processIdentity !== request.processIdentity
          )
            throw new Error("The native action receiver changed");
          const result = latest.nativeActions.result;
          if (result?.operationId === operationId) {
            if (result.status === "invoked") return;
            throw requestError(
              result.message ?? "Native Pi rejected the action",
              409,
              {
                code: result.code ?? "NATIVE_ACTION_REJECTED",
              },
            );
          }
          await delay(25);
        } while (Date.now() < until);
        throw new Error("Native action receipt unavailable");
      } catch (error) {
        if ((error as { status?: number }).status === 409) throw error;
        throw requestError(
          "The native Pi action could not be confirmed. Check the original terminal before trying again.",
          504,
          { code: "PI_RPC_OUTCOME_UNKNOWN", outcomeUnknown: true },
        );
      }
    } finally {
      await rm(path, { force: true });
    }
  }
}
