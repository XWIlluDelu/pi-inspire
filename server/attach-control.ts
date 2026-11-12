import { lstat, readdir, readFile, rm, stat } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import {
  ATTACH_CONTROL_STALE_MS,
  AttachControlError,
  type AttachControlOperation,
  type AttachControlRecord,
  type AttachControlResponse,
  type AttachControlState,
  attachControlDirectory,
  processIdentity,
  requestAttachControl,
} from "../extensions/attach-control.js";
import {
  type ExternalSessionConnection,
  type ExternalSessionState,
  type MatchExternalLeaf,
  PI_STATE_OBSERVATION_TIMEOUT_MS,
} from "./external-session.js";
import { requestError } from "./request-error.js";

const RECORD_NAME = /^[1-9]\d*-[0-9a-f-]{36}\.json$/;
const MAX_RECORD_BYTES = 32_768;
const IDENTITY_CACHE_MS = 10_000;
const OBSERVATION_MAX_AGE_MS = 1_000;

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | null)?.code;
}

function heartbeatIsCurrent(record: AttachControlRecord): boolean {
  const age = Date.now() - record.updatedAt;
  return age >= 0 && age < ATTACH_CONTROL_STALE_MS;
}

async function sessionFileStat(path: string) {
  try {
    return await stat(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function isAttachControlRecord(value: unknown): value is AttachControlRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<AttachControlRecord>;
  return (
    record.version === 1 &&
    typeof record.instanceId === "string" &&
    Number.isSafeInteger(record.pid) &&
    record.pid! > 0 &&
    typeof record.processIdentity === "string" &&
    record.processIdentity.length > 0 &&
    typeof record.sessionId === "string" &&
    record.sessionId.length > 0 &&
    typeof record.sessionFile === "string" &&
    isAbsolute(record.sessionFile) &&
    (record.leafId === null || typeof record.leafId === "string") &&
    (record.activity === "working" ||
      record.activity === "blocked" ||
      record.activity === "idle") &&
    Number.isSafeInteger(record.updatedAt) &&
    typeof record.endpoint === "string" &&
    typeof record.token === "string"
  );
}

async function matchingSessionRecords(
  records: readonly AttachControlRecord[],
  sessionId: string,
  sessionFile: string,
): Promise<AttachControlRecord[]> {
  const file = resolve(sessionFile);
  const candidates = records.filter((record) => record.sessionId === sessionId);
  if (candidates.every((record) => resolve(record.sessionFile) === file))
    return candidates;
  const target = await sessionFileStat(file);
  const matches = await Promise.all(
    candidates.map(async (record) => {
      if (resolve(record.sessionFile) === file) return true;
      if (!target?.isFile() || target.ino === 0n) return false;
      const candidate = await sessionFileStat(record.sessionFile);
      return (
        candidate?.isFile() &&
        candidate.dev === target.dev &&
        candidate.ino === target.ino
      );
    }),
  );
  return candidates.filter((_record, index) => matches[index]);
}

/** Live attach-control records of this OS user. Observation only: reading
 * never starts, stops or writes a Pi session. */
export class AttachControlRegistry {
  private readonly identities = new Map<
    number,
    { identity: string | null; checkedAt: number }
  >();
  private observation?: {
    records: Promise<AttachControlRecord[]>;
    /** null while the scan is in flight. */
    settledAt: number | null;
  };

  constructor(
    readonly directory = attachControlDirectory(),
    /** Records to ignore, such as the Host's own tagged workers. */
    private readonly ignore: (record: AttachControlRecord) => boolean = () =>
      false,
  ) {}

  private async liveIdentity(
    pid: number,
    cachedIdentity = false,
  ): Promise<string | null> {
    const cached = cachedIdentity ? this.identities.get(pid) : undefined;
    if (cached && Date.now() - cached.checkedAt < IDENTITY_CACHE_MS)
      return cached.identity;
    const identity = await processIdentity(pid).catch((error: unknown) => {
      if (errorCode(error) === "ESRCH") return null;
      // On some platforms an exited process yields a generic lookup error.
      // Probe its presence before treating an identity failure as absence.
      try {
        process.kill(pid, 0);
      } catch (probeError) {
        if (errorCode(probeError) === "ESRCH") return null;
      }
      throw error;
    });
    this.identities.set(pid, { identity, checkedAt: Date.now() });
    if (this.identities.size > 512)
      this.identities.delete(this.identities.keys().next().value!);
    return identity;
  }

  private async readRecord(
    name: string,
    relevant: ((record: AttachControlRecord) => Promise<boolean>) | undefined,
    cachedIdentity: boolean,
    includeStale: boolean,
  ): Promise<AttachControlRecord | null> {
    const path = join(this.directory, name);
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > MAX_RECORD_BYTES) return null;
      const record: unknown = JSON.parse(await readFile(path, "utf8"));
      if (!isAttachControlRecord(record) || !name.startsWith(`${record.pid}-`))
        return null;
      if (this.ignore(record) || (relevant && !(await relevant(record))))
        return null;
      if (
        (await this.liveIdentity(record.pid, cachedIdentity)) !==
        record.processIdentity
      ) {
        // A crashed or replaced process cannot remove its own record.
        if (
          !cachedIdentity ||
          (await this.liveIdentity(record.pid)) !== record.processIdentity
        )
          await rm(path, { force: true }).catch(() => {});
        return null;
      }
      return includeStale || heartbeatIsCurrent(record) ? record : null;
    } catch (error) {
      if (errorCode(error) === "ENOENT" || error instanceof SyntaxError)
        return null;
      throw error;
    }
  }

  private async scan({
    include = () => true,
    relevant,
    cachedIdentity = false,
    includeStale = false,
  }: {
    include?: (name: string) => boolean;
    relevant?: (record: AttachControlRecord) => Promise<boolean>;
    cachedIdentity?: boolean;
    includeStale?: boolean;
  } = {}): Promise<AttachControlRecord[]> {
    let names: string[];
    try {
      names = (await readdir(this.directory)).filter(
        (name) => RECORD_NAME.test(name) && include(name),
      );
    } catch (error) {
      if (errorCode(error) === "ENOENT") return [];
      throw error;
    }
    return (
      await Promise.all(
        names.map((name) =>
          this.readRecord(name, relevant, cachedIdentity, includeStale),
        ),
      )
    ).filter((record): record is AttachControlRecord => record !== null);
  }

  /** A fresh scan of every live record. */
  list(): Promise<AttachControlRecord[]> {
    return this.scan();
  }

  /** Records for observers that tolerate a scan up to
   * `OBSERVATION_MAX_AGE_MS` old, far inside the records' own heartbeat
   * staleness. Concurrent observers share one directory scan. */
  observe(): Promise<AttachControlRecord[]> {
    const observation = this.observation;
    if (
      observation &&
      (observation.settledAt === null ||
        Date.now() - observation.settledAt < OBSERVATION_MAX_AGE_MS)
    )
      return observation.records;
    const next: NonNullable<typeof this.observation> = {
      records: this.scan({ cachedIdentity: true }),
      settledAt: null,
    };
    this.observation = next;
    const settle = () => {
      next.settledAt = Date.now();
    };
    void next.records.then(settle, settle);
    return next.records;
  }

  /** Live records of one session; `observe` accepts a shared recent scan. */
  async forSession(
    sessionId: string,
    sessionFile: string,
    {
      observe = false,
      includeStale = false,
    }: {
      observe?: boolean;
      includeStale?: boolean;
    } = {},
  ): Promise<AttachControlRecord[]> {
    if (observe && !includeStale) {
      try {
        return await matchingSessionRecords(
          await this.observe(),
          sessionId,
          sessionFile,
        );
      } catch {
        // An unrelated process can fail activity discovery. Try the
        // requested session alone before making an ownership decision.
      }
    }
    return this.scan({
      includeStale,
      cachedIdentity: observe,
      relevant: async (record) =>
        (await matchingSessionRecords([record], sessionId, sessionFile))
          .length > 0,
    });
  }

  /** Refresh only reports that may describe an earlier position on the same
   * branch. An unavailable read leaves that instance's branch unknown. */
  async branchLeaves(
    sessionId: string,
    sessionFile: string,
    {
      observe,
      isAncestor,
    }: { observe: boolean; isAncestor: (leaf: string | null) => boolean },
  ): Promise<(string | null | undefined)[]> {
    const records = await this.forSession(sessionId, sessionFile, {
      observe,
      includeStale: true,
    });
    const leaves = await Promise.all(
      records.map(async (record) => {
        if (!heartbeatIsCurrent(record)) return [undefined];
        if (!isAncestor(record.leafId)) return [record.leafId];
        if (!record.endpoint) return [undefined];
        try {
          const state = await new AttachControlConnection(this, record).read(
            PI_STATE_OBSERVATION_TIMEOUT_MS,
          );
          if (!("ended" in state)) return [state.leafId];
          return state.ended === "unreachable" ? [undefined] : [];
        } catch {
          return [undefined];
        }
      }),
    );
    return leaves.flat();
  }

  /** Deletion targets the whole session, across every reported branch. A
   * reply is not exit evidence; leave the file in place until each Pi exits. */
  async stopSession(sessionId: string, sessionFile: string): Promise<void> {
    const records = await this.forSession(sessionId, sessionFile, {
      includeStale: true,
    });
    const results = await Promise.allSettled(
      records.map(async (record) => {
        const response = await requestAttachControl(record.endpoint, {
          op: "shutdown",
          token: record.token,
          sessionFile: record.sessionFile,
        }).catch(() => null);
        if (response && !response.ok) {
          if (response.code === "CHANGED") return;
          throw requestError(response.error, 409, {
            code: "SESSION_INSTANCE_ACTIVE",
          });
        }
        const deadline = Date.now() + 15_000;
        while (await this.alive(record.pid, record.processIdentity)) {
          if (Date.now() >= deadline)
            throw requestError(
              "A Pi instance has not exited. The session was not deleted.",
              409,
              { code: "SESSION_INSTANCE_ACTIVE" },
            );
          await new Promise((resolvePromise) =>
            setTimeout(resolvePromise, 100),
          );
        }
      }),
    );
    for (const result of results)
      if (result.status === "rejected") throw result.reason;
    if (
      (await this.forSession(sessionId, sessionFile, { includeStale: true }))
        .length
    )
      throw requestError(
        "Another Pi opened this session during deletion. Review it before retrying.",
        409,
        { code: "SESSION_INSTANCE_ACTIVE" },
      );
  }

  /** Fresh exit evidence for one process incarnation; reads no records. */
  async alive(pid: number, identity: string): Promise<boolean> {
    return (await this.liveIdentity(pid)) === identity;
  }

  /** The current records of one live process, whichever session it now
   * shows. Record names carry the pid, so other processes are not read. */
  async forProcess(
    pid: number,
    identity: string,
  ): Promise<{ alive: boolean; records: AttachControlRecord[] }> {
    if (!(await this.alive(pid, identity)))
      return { alive: false, records: [] };
    return {
      alive: true,
      records: (
        await this.scan({
          include: (name) => name.startsWith(`${pid}-`),
          cachedIdentity: true,
        })
      ).filter((record) => record.processIdentity === identity),
    };
  }
}

/** Prefer a reported continuation over a record that may be behind. */
export function takeoverCandidate(
  records: readonly AttachControlRecord[],
  matchLeaf: MatchExternalLeaf,
  idleOnly = false,
): AttachControlRecord | undefined {
  if (idleOnly) {
    if (records.some((record) => !heartbeatIsCurrent(record))) return undefined;
    const [candidate, other] = records.filter(
      (record) => matchLeaf(record.leafId) !== "other",
    );
    return !other && candidate?.endpoint && candidate.activity === "idle"
      ? candidate
      : undefined;
  }
  const candidates = records
    .filter((record) => record.endpoint)
    .map((record) => ({ record, match: matchLeaf(record.leafId) }));
  const continuations = candidates.filter(({ match }) => match === "continues");
  const [candidate, other] = continuations.length
    ? continuations
    : candidates.filter(({ match }) => match === "possible");
  if (other)
    throw requestError(
      "Several Pi processes match this view. Leave the session in the other Pi processes, then try again.",
      409,
      { code: "EXTERNAL_PI_AMBIGUOUS" },
    );
  return candidate?.record;
}

function stateOf(state: AttachControlState): ExternalSessionState {
  return {
    status: state.activity,
    taskRuns: state.taskRuns,
    modelSelection: state.modelSelection,
    leafId: state.leafId,
    ...(state.uiRequests ? { uiRequests: state.uiRequests } : {}),
  };
}

/** Bound to one process incarnation and session file. Every operation
 * resolves that process's current endpoint, so reloads stay transparent. */
export class AttachControlConnection implements ExternalSessionConnection {
  readonly pid: number;
  private readonly identity: string;
  private readonly sessionId: string;
  private readonly sessionFile: string;
  private failingSince: number | null = null;

  constructor(
    private readonly registry: AttachControlRegistry,
    record: AttachControlRecord,
    private readonly graceMs = ATTACH_CONTROL_STALE_MS,
  ) {
    this.pid = record.pid;
    this.identity = record.processIdentity;
    this.sessionId = record.sessionId;
    this.sessionFile = resolve(record.sessionFile);
  }

  private async current(): Promise<
    AttachControlRecord | { ended: "exited" | "left-session" }
  > {
    const { alive, records } = await this.registry.forProcess(
      this.pid,
      this.identity,
    );
    if (!alive) return { ended: "exited" };
    const matching = await matchingSessionRecords(
      records,
      this.sessionId,
      this.sessionFile,
    );
    const record = matching.find((candidate) => candidate.endpoint);
    if (record) return record;
    // A reload briefly removes the record; another session means this Pi
    // moved away.
    if (records.length > 0 && matching.length === 0)
      return { ended: "left-session" };
    throw requestError(
      matching.length
        ? "The attached Pi has no available control endpoint."
        : "The attached Pi is reloading. Try again shortly.",
      409,
      {
        code: "SESSION_OWNER_UNAVAILABLE",
      },
    );
  }

  private async send(
    operation: AttachControlOperation,
    beforeSend?: () => void,
    expectedLeafId?: string | null,
    observed?: AttachControlRecord,
    timeoutMs?: number,
  ): Promise<Extract<AttachControlResponse, { ok: true }>> {
    const record = observed ?? (await this.current());
    if ("ended" in record)
      throw requestError(
        "The attached Pi is no longer running this session.",
        409,
        {
          code: "SESSION_OWNER_UNAVAILABLE",
        },
      );
    beforeSend?.();
    const unknown = (message: string) =>
      requestError(message, 502, {
        code: "ATTACH_CONTROL_OUTCOME_UNKNOWN",
        outcomeUnknown: true,
      });
    const response = await requestAttachControl(
      record.endpoint,
      {
        ...operation,
        token: record.token,
        sessionFile: record.sessionFile,
        ...(expectedLeafId !== undefined ? { expectedLeafId } : {}),
      },
      timeoutMs,
    ).catch((error: unknown) => {
      if (error instanceof AttachControlError && error.outcomeUnknown)
        throw unknown(error.message);
      if (error instanceof AttachControlError && error.code === "TOO_LARGE")
        throw requestError(error.message, 413, {
          code: "ATTACH_CONTROL_TOO_LARGE",
        });
      throw requestError(
        error instanceof Error
          ? error.message
          : "The attached Pi is unavailable.",
        409,
        { code: "SESSION_OWNER_UNAVAILABLE" },
      );
    });
    if (
      response?.ok === false &&
      typeof response.code === "string" &&
      typeof response.error === "string"
    ) {
      if (
        response.code === "OUTCOME_UNKNOWN" ||
        (operation.op === "prompt" && response.code === "FAILED")
      )
        throw unknown(response.error);
      throw requestError(
        response.error,
        response.code === "TOO_LARGE" ? 413 : 409,
        {
          code:
            response.code === "BLOCKED"
              ? "NATIVE_INPUT_BLOCKED"
              : response.code === "CHANGED"
                ? "SESSION_OWNER_UNAVAILABLE"
                : `ATTACH_CONTROL_${response.code}`,
        },
      );
    }
    if (
      response?.ok !== true ||
      response.state?.sessionId !== record.sessionId ||
      response.state.sessionFile !== record.sessionFile ||
      !response.state.taskRuns ||
      !response.state.modelSelection ||
      ((operation.op === "prompt" || operation.op === "abort") &&
        response.witnessed !== true)
    )
      throw unknown("Invalid response from the attached Pi.");
    return response;
  }

  /** Failures within the grace period (such as a reload) are transient; a
   * lasting one ends the binding as "unreachable". */
  async read(
    timeoutMs?: number,
  ): Promise<
    ExternalSessionState | { ended: "exited" | "left-session" | "unreachable" }
  > {
    try {
      const record = await this.current();
      const state =
        "ended" in record
          ? record
          : stateOf(
              (
                await this.send(
                  { op: "state" },
                  undefined,
                  undefined,
                  record,
                  timeoutMs,
                )
              ).state,
            );
      this.failingSince = null;
      return state;
    } catch (error) {
      this.failingSince ??= Date.now();
      if (Date.now() - this.failingSince >= this.graceMs)
        return { ended: "unreachable" };
      throw error;
    }
  }

  async prompt(
    message: string,
    behavior?: "steer" | "followUp",
    beforeSend?: () => void,
    images?: { path: string; mimeType: string }[],
    expectedLeafId?: string | null,
  ): Promise<void> {
    await this.send(
      { op: "prompt", message, behavior, images },
      beforeSend,
      expectedLeafId,
    );
  }

  async abort(expectedLeafId?: string | null): Promise<void> {
    await this.send({ op: "abort" }, undefined, expectedLeafId);
  }

  async answerUi(response: Record<string, unknown>): Promise<void> {
    await this.send({ op: "ui_response", response });
  }

  async rename(name: string, beforeSend?: () => void): Promise<void> {
    await this.send({ op: "rename", name }, beforeSend);
  }

  async models() {
    const response = await this.send({ op: "models" });
    return { ...response.state.modelSelection, models: response.models ?? [] };
  }

  async setModel(provider: string, modelId: string, beforeSend?: () => void) {
    return (await this.send({ op: "set_model", provider, modelId }, beforeSend))
      .state.modelSelection;
  }

  async setThinkingLevel(
    level: AttachControlState["modelSelection"]["thinkingLevel"],
    beforeSend?: () => void,
  ) {
    return (await this.send({ op: "set_thinking", level }, beforeSend)).state
      .modelSelection;
  }

  close(): void {}
}
