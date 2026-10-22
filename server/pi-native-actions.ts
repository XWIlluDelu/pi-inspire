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
  type NativeModelCatalog,
  type NativeModelSelection,
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
          record.nativeActions?.version !== 2 ||
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

  /** Read-only state bound to the same validated receiver as actions. */
  async readState() {
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
      return {
        modelControls: record.nativeActions?.models === true,
        modelSelection: record.nativeActions?.modelSelection,
      };
    return {
      taskRuns: runs,
      modelControls: record.nativeActions?.models === true,
      modelSelection: record.nativeActions?.modelSelection,
    };
  }

  async invoke(
    action: NativeAction,
    send: (frame: string) => Promise<unknown>,
    beforeSend?: () => void,
    signal?: AbortSignal,
  ): Promise<NativeModelSelection | NativeModelCatalog | undefined> {
    signal?.throwIfAborted();
    const { file, record } = await this.target();
    if (
      action.type === "prompt" &&
      action.images?.length &&
      !record.nativeActions?.images
    )
      throw requestError(
        "Reload the session-activity extension in the original Pi terminal before sending images.",
        409,
        { code: "NATIVE_ACTIONS_UNAVAILABLE" },
      );
    const modelAction = ["get_models", "set_model", "set_thinking"].includes(
      action.type,
    );
    if (modelAction && record.nativeActions?.models !== true)
      throw requestError(
        "Reload the updated session-activity extension in the original Pi terminal before changing its model or thinking level.",
        409,
        { code: "NATIVE_ACTIONS_UNAVAILABLE" },
      );
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
      signal?.throwIfAborted();
      beforeSend?.();
      try {
        await send(nativeActionFrame(receiverId, operationId));
        // This bounds receipt observation, not native model work. Never resend.
        const until = Date.now() + (modelAction ? 30_000 : 5_000);
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
          signal?.throwIfAborted();
          if ((await lstat(path)).size > 4 * 1024 * 1024)
            throw new Error("Native result exceeds the action payload limit");
          // The receiver updates the existing request with r+, so removal
          // cannot recreate an abandoned read. A partial write is not a receipt.
          let response: NativeActionRequest | undefined;
          try {
            response = JSON.parse(await readFile(path, "utf8"));
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
          }
          if (
            response &&
            (response.operationId !== operationId ||
              response.receiverId !== receiverId ||
              response.sessionId !== request.sessionId ||
              response.sessionFile !== request.sessionFile ||
              response.processIdentity !== request.processIdentity)
          )
            throw new Error("The native action response target changed");
          const result = response?.result;
          if (result?.operationId === operationId) {
            if (result.status === "invoked") {
              if (!modelAction) return;
              if (!response?.modelState)
                throw new Error("Native model result unavailable");
              return response.modelState;
            }
            throw requestError(
              result.message ?? "Native Pi rejected the action",
              409,
              {
                code: result.code ?? "NATIVE_ACTION_REJECTED",
              },
            );
          }
          await delay(25, undefined, { signal });
        } while (Date.now() < until);
        throw new Error("Native action receipt unavailable");
      } catch (error) {
        signal?.throwIfAborted();
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
