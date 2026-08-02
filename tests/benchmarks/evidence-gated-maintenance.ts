import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import WebSocket from "ws";
import type {
  ActiveSnapshot,
  BranchForkRequest,
  BranchForkResponse,
  BranchNavigateRequest,
  BranchNavigateResponse,
  BranchTreeResponse,
  GitDiffResponse,
  GitDiffSide,
  GitStatusResponse,
  PromptRequest,
  SessionListResponse,
  SessionSummary,
  TranscriptPage,
} from "../../shared/contracts.js";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { createInspireServer } from "../../server/app.js";
import { AttachmentStore } from "../../server/attachments.js";
import { GitInspectionService, type GitInspectionLike } from "../../server/git-inspection.js";
import { PreferencesStore } from "../../server/preferences.js";
import { ResourceStore, type ResourceContext } from "../../server/resources.js";
import type { RuntimeLike } from "../../server/runtime.js";
import { SessionCatalog, type SessionCatalogLike, type SessionRecord } from "../../server/session-catalog.js";
import { SessionProjection } from "../../server/session-projection.js";
import { projectSessionTree } from "../../server/session-tree.js";

const HOST_PORT = 4587;
const WEB_PORT = 5173;
const TOKEN = "maintenance-evaluator-token";
const SESSION_ID = "44444444-4444-4444-8444-444444444444";
const ACCEPTED_BROWSER_SAMPLES = 21;
const MAX_BROWSER_ATTEMPTS = 28;
const HOST_SAMPLES = 21;
const MIN_REPEAT_CROSSINGS = 3;
const MIN_REPEAT_FRACTION = 0.1;
const CONTROL_MIN_FRAME_SAMPLES = 30;
const CONTROL_MIN_EVENT_LOOP_SAMPLES = 20;
const CONTROL_MAX_FRAME_P95_MS = 25;
const CONTROL_MAX_EVENT_LOOP_P95_MS = 25;
const STREAM_DELTAS = 36;
const BACKGROUND_SETTLEMENTS = 4;
const PERSISTED_TARGET_BYTES = 11 * 1024 * 1024;
const EXPECTED_SCENARIO_REQUESTS: Record<string, number> = {
  "/api/branches/navigate": 1,
  "/api/branches/tree": 2,
  "/api/git/diff": 2,
  "/api/git/status": 3,
  "/api/prompt": 1,
  "/api/sessions": BACKGROUND_SETTLEMENTS,
  "/api/snapshot": 1,
};
interface WebSocketWitness {
  type: string;
  sessionId: string;
  outcome: string;
}

function websocketOutcome(event: Record<string, unknown>): string {
  const status = event.sessionStatus as { runState?: unknown; indicator?: unknown } | undefined;
  const message = event.message as { role?: unknown } | undefined;
  switch (event.type) {
    case "message_start":
    case "message_end":
      return String(message?.role ?? "");
    case "agent_start":
    case "agent_settled":
      return `${String(status?.runState ?? "")}:${String(status?.indicator ?? "")}`;
    case "queue_update":
      return `${Array.isArray(event.steering) ? event.steering.length : -1}:${Array.isArray(event.followUp) ? event.followUp.length : -1}`;
    case "tool_execution_start":
      return String(event.toolName ?? "");
    case "message_update":
      return String((event.assistantMessageEvent as { type?: unknown } | undefined)?.type ?? "");
    case "tool_execution_end":
      return `${String(event.toolName ?? "")}:${event.isError === false ? "success" : "error"}`;
    default:
      return "";
  }
}

function parseWebSocketWitness(payload: string): WebSocketWitness {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    throw new Error("WebSocket frame is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object") throw new Error("WebSocket frame is not an event object");
  const event = parsed as Record<string, unknown>;
  if (typeof event.type !== "string" || typeof event.sessionId !== "string") {
    throw new Error("WebSocket frame lacks a typed session address");
  }
  return { type: event.type, sessionId: event.sessionId, outcome: websocketOutcome(event) };
}

function expectedWebSocketWitnesses(): WebSocketWitness[] {
  const selected = SESSION_ID;
  const synchronous: WebSocketWitness[] = [
    { type: "message_start", sessionId: selected, outcome: "user" },
    { type: "agent_start", sessionId: selected, outcome: "running:running" },
    { type: "queue_update", sessionId: selected, outcome: "1:1" },
    { type: "message_start", sessionId: selected, outcome: "assistant" },
    { type: "tool_execution_start", sessionId: selected, outcome: "read" },
  ];
  const scheduled: Array<{ at: number; order: number; event: WebSocketWitness }> = [];
  let order = 0;
  for (let index = 0; index < STREAM_DELTAS; index += 1) {
    const at = 30 + index * 18;
    scheduled.push({ at, order: order++, event: { type: "message_update", sessionId: selected, outcome: "text_delta" } });
    if (index === Math.floor(STREAM_DELTAS / 2)) {
      scheduled.push({ at, order: order++, event: { type: "tool_execution_end", sessionId: selected, outcome: "read:success" } });
    }
  }
  for (let index = 0; index < BACKGROUND_SETTLEMENTS; index += 1) {
    const sessionId = `background-${index + 1}`;
    scheduled.push({ at: 90 + index * 110, order: order++, event: { type: "agent_start", sessionId, outcome: "running:running" } });
    scheduled.push({ at: 140 + index * 110, order: order++, event: { type: "agent_settled", sessionId, outcome: "idle:completed" } });
  }
  const settledAt = 30 + STREAM_DELTAS * 18 + 30;
  scheduled.push({ at: settledAt, order: order++, event: { type: "message_end", sessionId: selected, outcome: "assistant" } });
  scheduled.push({ at: settledAt, order: order++, event: { type: "agent_settled", sessionId: selected, outcome: "idle:" } });
  scheduled.sort((left, right) => left.at - right.at || left.order - right.order);
  return [...synchronous, ...scheduled.map((item) => item.event)];
}

const EXPECTED_WEBSOCKET_WITNESSES = expectedWebSocketWitnesses();

function assertExactWebSocketWitnesses(actual: readonly WebSocketWitness[], expected = EXPECTED_WEBSOCKET_WITNESSES): void {
  if (actual.length !== expected.length) {
    throw new Error(`WebSocket sequence length changed: expected ${expected.length}, received ${actual.length}`);
  }
  for (let index = 0; index < expected.length; index += 1) {
    const wanted = expected[index]!;
    const received = actual[index]!;
    if (wanted.type !== received.type || wanted.sessionId !== received.sessionId || wanted.outcome !== received.outcome) {
      throw new Error(`WebSocket sequence changed at ${index}: expected ${JSON.stringify(wanted)}, received ${JSON.stringify(received)}`);
    }
  }
}

function runWebSocketFailureProbes(): string[] {
  const basis: WebSocketWitness[] = [
    { type: "agent_start", sessionId: "probe-a", outcome: "running:running" },
    { type: "agent_settled", sessionId: "probe-a", outcome: "idle:completed" },
  ];
  const probes: Array<[string, () => void]> = [
    ["malformed JSON", () => { parseWebSocketWitness("{"); }],
    ["missing typed address", () => { parseWebSocketWitness('{"type":"agent_start"}'); }],
    ["missing frame", () => assertExactWebSocketWitnesses(basis.slice(0, 1), basis)],
    ["extra frame", () => assertExactWebSocketWitnesses([...basis, basis[1]!], basis)],
    ["wrong order/type", () => assertExactWebSocketWitnesses([...basis].reverse(), basis)],
    ["wrong session address", () => assertExactWebSocketWitnesses([{ ...basis[0]!, sessionId: "probe-b" }, basis[1]!], basis)],
    ["wrong outcome", () => assertExactWebSocketWitnesses([basis[0]!, { ...basis[1]!, outcome: "idle:failed" }], basis)],
  ];
  for (const [name, probe] of probes) {
    let rejected = false;
    try { probe(); } catch { rejected = true; }
    if (!rejected) throw new Error(`WebSocket witness failure probe was accepted: ${name}`);
  }
  return probes.map(([name]) => name);
}

const thresholds = {
  browserLongTaskMs: 50,
  browserInputDelayMs: 50,
  browserScrollDelayMs: 50,
  // Each measured surface flow contains two awaited user actions, so its
  // end-to-end budget is two 100 ms response budgets rather than one event.
  browserInteractionMs: 200,
  reactSurfaceCommitMs: 16.7,
  hostProjectionP95Ms: 150,
  hostCatalogP95Ms: 150,
  hostStatusP95Ms: 100,
};

interface CommitRecord {
  surface: string;
  phase: string;
  actualDuration: number;
  baseDuration: number;
  startTime: number;
  commitTime: number;
}

interface BrowserRun {
  commits: CommitRecord[];
  longTasks: number[];
  inputDelays: number[];
  scrollDelays: number[];
  frameGaps: number[];
  eventLoopDelays: number[];
  requests: Record<string, number>;
  websocketFrames: number;
  websocketBytes: number;
  websocketWitnesses: WebSocketWitness[];
  interactionMs: { changes: number; branches: number; filesAndStreaming: number };
  assertions: string[];
}

interface HostRun {
  persistedBytes: number;
  visibleMessages: number;
  visibleBytes: number;
  projectionMs: number[];
  catalogMs: number[];
  statusMs: number[];
}

function percentile(values: readonly number[], quantile: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)]!;
}

function stats(values: readonly number[]) {
  if (values.length === 0) return { count: 0, min: 0, median: 0, p95: 0, max: 0 };
  return {
    count: values.length,
    min: Math.min(...values),
    median: percentile(values, 0.5),
    p95: percentile(values, 0.95),
    max: Math.max(...values),
  };
}

function contaminationReasons(run: Pick<BrowserRun, "frameGaps" | "eventLoopDelays">): string[] {
  const frame = stats(run.frameGaps);
  const eventLoop = stats(run.eventLoopDelays);
  const reasons: string[] = [];
  if (frame.count < CONTROL_MIN_FRAME_SAMPLES) reasons.push(`frame control had ${frame.count} samples`);
  if (eventLoop.count < CONTROL_MIN_EVENT_LOOP_SAMPLES) reasons.push(`event-loop control had ${eventLoop.count} samples`);
  if (frame.p95 > CONTROL_MAX_FRAME_P95_MS) reasons.push(`frame-gap p95 ${frame.p95.toFixed(2)} ms exceeded ${CONTROL_MAX_FRAME_P95_MS} ms`);
  if (eventLoop.p95 > CONTROL_MAX_EVENT_LOOP_P95_MS) reasons.push(`event-loop-delay p95 ${eventLoop.p95.toFixed(2)} ms exceeded ${CONTROL_MAX_EVENT_LOOP_P95_MS} ms`);
  return reasons;
}

function repeatabilityWitness(values: readonly number[], threshold: number) {
  const summary = stats(values);
  const crossingCount = values.filter((value) => value >= threshold).length;
  const requiredCrossings = Math.max(MIN_REPEAT_CROSSINGS, Math.ceil(values.length * MIN_REPEAT_FRACTION));
  return {
    ...summary,
    threshold,
    crossingCount,
    crossingFraction: values.length === 0 ? 0 : crossingCount / values.length,
    requiredCrossings,
    activated: summary.p95 >= threshold && crossingCount >= requiredCrossings,
  };
}

function runSamplingRuleProbes(): string[] {
  const cleanControl = { frameGaps: Array(40).fill(16.7), eventLoopDelays: Array(30).fill(1) };
  if (contaminationReasons(cleanControl).length !== 0) throw new Error("Clean control probe was rejected");
  if (contaminationReasons({ ...cleanControl, frameGaps: Array(40).fill(30) }).length === 0) throw new Error("Frame contamination probe was accepted");
  if (contaminationReasons({ ...cleanControl, eventLoopDelays: Array(30).fill(30) }).length === 0) throw new Error("Event-loop contamination probe was accepted");
  const oneSpike = repeatabilityWitness([...Array(20).fill(0), 250], 200);
  const twoSpikes = repeatabilityWitness([...Array(19).fill(0), 250, 250], 200);
  const threeCrossings = repeatabilityWitness([...Array(18).fill(0), 250, 250, 250], 200);
  if (oneSpike.activated || twoSpikes.activated || !threeCrossings.activated) {
    throw new Error("Repeatability decision probes did not enforce three crossings");
  }
  return ["clean control accepted", "frame contamination rejected", "event-loop contamination rejected", "one spike rejected", "two p95 spikes rejected", "three crossings activate"];
}

function messageEntry(id: string, parentId: string | null, role: "user" | "assistant" | "toolResult", text: string, timestamp: number): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date(timestamp).toISOString(),
    message: role === "assistant"
      ? {
          role,
          content: [{ type: "text", text }],
          provider: "benchmark",
          model: "offline",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          stopReason: "stop",
          timestamp,
        }
      : { role, content: text, timestamp },
  } as SessionEntry;
}

async function createLongSession(root: string): Promise<{ record: SessionRecord; entries: SessionEntry[] }> {
  const cwd = join(root, "workspace");
  const sessionDir = join(root, "sessions");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  await writeFile(join(cwd, ".pi", "settings.json"), `${JSON.stringify({ sessionDir })}\n`);
  await writeFile(join(cwd, "analysis.ts"), "export const benchmark = true;\n");

  const entries: SessionEntry[] = [];
  let timestamp = Date.UTC(2026, 7, 1);
  entries.push(messageEntry("root-user", null, "user", "benchmark root", timestamp++));
  entries.push(messageEntry("root-assistant", "root-user", "assistant", "benchmark root answer", timestamp++));

  let abandonedParent = "root-assistant";
  const payload = `abandoned branch payload ${"x".repeat(255 * 1024)}`;
  let index = 0;
  let serializedBytes = 0;
  while (serializedBytes < PERSISTED_TARGET_BYTES) {
    const id = `abandoned-${index++}`;
    const entry = messageEntry(id, abandonedParent, "toolResult", payload, timestamp++);
    entries.push(entry);
    abandonedParent = id;
    serializedBytes += Buffer.byteLength(JSON.stringify(entry)) + 1;
  }

  let activeParent = "root-assistant";
  for (let turn = 0; turn < 80; turn += 1) {
    const userId = `active-user-${turn}`;
    const assistantId = `active-assistant-${turn}`;
    entries.push(messageEntry(userId, activeParent, "user", `benchmark visible turn ${turn} \`analysis.ts\``, timestamp++));
    entries.push(messageEntry(assistantId, userId, "assistant", `settled benchmark answer ${turn} ${"y".repeat(220)}`, timestamp++));
    activeParent = assistantId;
  }

  const header = { type: "session", version: 3, id: SESSION_ID, timestamp: new Date(Date.UTC(2026, 7, 1)).toISOString(), cwd };
  const sessionPath = join(sessionDir, "benchmark.jsonl");
  await writeFile(sessionPath, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const details = await stat(sessionPath);
  return {
    record: {
      path: sessionPath,
      id: SESSION_ID,
      cwd,
      created: details.birthtime,
      modified: details.mtime,
      messageCount: entries.length,
      firstMessage: "benchmark root",
      searchText: "benchmark root",
    },
    entries,
  };
}

class BenchmarkCatalog implements SessionCatalogLike {
  readonly summaries: SessionSummary[];
  listCalls = 0;

  constructor(private readonly record: SessionRecord) {
    this.summaries = Array.from({ length: 24 }, (_, index) => ({
      id: index === 0 ? SESSION_ID : `background-${index}`,
      cwd: index === 0 ? record.cwd : `${record.cwd}/project-${index % 6}`,
      project: index === 0 ? "workspace" : `project-${index % 6}`,
      title: index === 0 ? "Evidence-gated maintenance benchmark" : `Background benchmark ${index}`,
      created: new Date(Date.UTC(2026, 6, 1) + index * 1_000).toISOString(),
      modified: new Date(Date.UTC(2026, 7, 1) - index * 60_000).toISOString(),
      messageCount: 160 + index,
    }));
  }

  async refresh(): Promise<readonly SessionRecord[]> { return [this.record]; }
  async get(id: string): Promise<SessionRecord | undefined> { return id === SESSION_ID ? this.record : undefined; }
  async list(options: { query?: string; offset?: number; limit?: number } = {}): Promise<SessionListResponse> {
    this.listCalls += 1;
    const query = options.query?.toLowerCase() ?? "";
    const filtered = query ? this.summaries.filter((item) => `${item.title} ${item.project}`.toLowerCase().includes(query)) : this.summaries;
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 40;
    return { sessions: filtered.slice(offset, offset + limit), total: filtered.length, offset, limit };
  }
  async listByIds(ids: readonly string[]) { const wanted = new Set(ids); return this.summaries.filter((item) => wanted.has(item.id)); }
  async listByCwds(cwds: readonly string[]) { const wanted = new Set(cwds); return this.summaries.filter((item) => wanted.has(item.cwd)); }
  invalidate(): void {}
}

class BenchmarkGit implements GitInspectionLike {
  calls = 0;
  diffCalls = 0;
  readonly path = {
    id: Buffer.from("analysis.ts").toString("base64url"),
    display: "analysis.ts",
    utf8Path: "analysis.ts",
    workspacePath: "analysis.ts",
  };

  async status(): Promise<GitStatusResponse> {
    this.calls += 1;
    return {
      kind: "repository",
      head: { kind: "branch", name: `benchmark/maintenance@${this.calls}`, oid: "0123456789abcdef0123456789abcdef01234567" },
      files: [{ path: this.path, unstaged: { kind: "modified" }, untracked: false }],
      total: 1,
      truncated: false,
      groups: { conflicted: [], staged: [], unstaged: [this.path.id], untracked: [] },
    };
  }

  async diff(_cwd: string, _pathId: string, side: GitDiffSide): Promise<GitDiffResponse> {
    this.diffCalls += 1;
    return {
      kind: "text", path: this.path, side, truncated: false, encodingLossy: false,
      lines: [{ kind: "context", oldLine: 1, newLine: 1, text: `benchmark diff revision ${this.diffCalls}` }],
    };
  }
}

class BenchmarkRuntime extends EventEmitter implements RuntimeLike {
  readonly activeSessionId = SESSION_ID;
  private messages: unknown[];
  private timers = new Set<NodeJS.Timeout>();
  private running = false;
  private backgroundStatuses: Record<string, { runState: "idle" | "running"; indicator?: "running" | "completed" }> = Object.fromEntries(
    Array.from({ length: BACKGROUND_SETTLEMENTS }, (_, index) => [`background-${index + 1}`, { runState: "idle" as const }]),
  );

  constructor(private readonly record: SessionRecord, entries: SessionEntry[]) {
    super();
    const visible = projectSessionTree(entries, entries.at(-1)?.id ?? null).activePath;
    const visibleIds = new Set(visible);
    this.messages = entries
      .filter((entry) => entry.type === "message" && visibleIds.has(entry.id))
      .map((entry) => ({ ...(entry as { message: Record<string, unknown> }).message, __inspireMessageId: entry.id }))
      .slice(-100);
  }

  sessionCwd(sessionId: string) { return sessionId === SESSION_ID ? this.record.cwd : null; }

  private active() {
    return {
      sessionId: SESSION_ID,
      sessionFile: this.record.path,
      sessionName: "Evidence-gated maintenance benchmark",
      cwd: this.record.cwd,
      model: { provider: "benchmark", id: "offline", name: "Offline benchmark" },
      thinkingLevel: "medium",
      isStreaming: this.running,
      isCompacting: false,
      messages: structuredClone(this.messages),
      transcriptPage: {
        sessionId: SESSION_ID,
        revision: 1,
        viewId: "benchmark-view",
        incarnation: "benchmark-incarnation",
        appendFromRevision: 1,
        effectiveLeafId: "active-assistant-79",
        messages: structuredClone(this.messages),
        hasOlder: true,
        olderCursor: "benchmark-older",
      },
      projectionHealth: { status: "ok" as const },
      projectionConflict: null,
      stats: { contextUsage: { tokens: 32_000, contextWindow: 131_072, percent: 24.4 } },
      availableModels: [{ provider: "benchmark", id: "offline", name: "Offline benchmark", reasoning: true }],
      commands: [{ name: "benchmark", description: "Offline evaluator command", source: "extension" }],
    };
  }

  private state(): ActiveSnapshot {
    return {
      active: this.active(),
      runState: this.running ? "running" : "idle",
      sessionStatuses: {
        [SESSION_ID]: { runState: this.running ? "running" : "idle" },
        ...this.backgroundStatuses,
      },
      pendingQueues: this.running ? { steering: ["keep the visible projection bounded"], followUp: ["verify navigation chrome"] } : { steering: [], followUp: [] },
      pendingExtensionUiRequests: [],
      extensionDisplays: [],
    };
  }

  async openSession() { return this.state(); }
  async newSession() { return this.state(); }
  async snapshot() { return structuredClone(this.state()); }
  async rename(): Promise<void> {}
  async setModel() { return { provider: "benchmark", id: "offline" }; }
  async setThinkingLevel(): Promise<void> {}
  async extensionUiResponse(): Promise<void> {}
  async abort(): Promise<void> { this.running = false; }

  private later(delay: number, operation: () => void) {
    const timer = setTimeout(() => { this.timers.delete(timer); operation(); }, delay);
    this.timers.add(timer);
  }

  async prompt(request: PromptRequest): Promise<void> {
    if (request.sessionId !== SESSION_ID || this.running) throw new Error("Benchmark prompt rejected");
    this.running = true;
    const timestamp = Date.now();
    const user = { role: "user", content: request.message, timestamp, __inspireLiveId: `user:${timestamp}:` };
    const assistant = {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "Tracing the frozen maintenance scenario." },
        { type: "toolCall", id: "benchmark-tool", name: "read", arguments: { path: "analysis.ts" } },
        { type: "text", text: "" },
      ],
      provider: "benchmark",
      model: "offline",
      stopReason: "stop",
      timestamp: timestamp + 1,
      __inspireLiveId: `assistant:${timestamp + 1}:`,
    };
    this.messages.push(user, assistant);
    this.emit("event", { type: "message_start", sessionId: SESSION_ID, message: user, sessionStatus: { runState: "running", indicator: "running" } });
    this.emit("event", { type: "agent_start", sessionId: SESSION_ID, sessionStatus: { runState: "running", indicator: "running" } });
    this.emit("event", { type: "queue_update", sessionId: SESSION_ID, steering: ["keep the visible projection bounded"], followUp: ["verify navigation chrome"] });
    this.emit("event", { type: "message_start", sessionId: SESSION_ID, message: assistant });
    this.emit("event", { type: "tool_execution_start", sessionId: SESSION_ID, toolCallId: "benchmark-tool", toolName: "read", args: { path: "analysis.ts" } });

    const answer = `Frozen evaluator stream completed with analysis.ts visible. ${"stream delta evidence ".repeat(40)}`;
    const chunks = Array.from({ length: STREAM_DELTAS }, (_, index) => answer.slice(Math.floor(index * answer.length / STREAM_DELTAS), Math.floor((index + 1) * answer.length / STREAM_DELTAS)));
    chunks.forEach((chunk, index) => this.later(30 + index * 18, () => {
      (assistant.content[2] as { text: string }).text += chunk;
      this.emit("event", { type: "message_update", sessionId: SESSION_ID, message: structuredClone(assistant), assistantMessageEvent: { type: "text_delta", contentIndex: 2, delta: chunk, partial: structuredClone(assistant) } });
      if (index === Math.floor(STREAM_DELTAS / 2)) {
        this.emit("event", { type: "tool_execution_end", sessionId: SESSION_ID, toolCallId: "benchmark-tool", toolName: "read", result: { content: [{ type: "text", text: "analysis.ts read" }] }, isError: false });
      }
    }));

    for (let index = 0; index < BACKGROUND_SETTLEMENTS; index += 1) {
      const sessionId = `background-${index + 1}`;
      this.later(90 + index * 110, () => {
        this.backgroundStatuses[sessionId] = { runState: "running", indicator: "running" };
        this.emit("event", { type: "agent_start", sessionId, sessionStatus: this.backgroundStatuses[sessionId] });
      });
      this.later(140 + index * 110, () => {
        this.backgroundStatuses[sessionId] = { runState: "idle", indicator: "completed" };
        this.emit("event", { type: "agent_settled", sessionId, sessionStatus: this.backgroundStatuses[sessionId] });
      });
    }

    this.later(30 + STREAM_DELTAS * 18 + 30, () => {
      this.running = false;
      (assistant as Record<string, unknown>).__inspireSettled = true;
      this.emit("event", { type: "message_end", sessionId: SESSION_ID, message: structuredClone(assistant) });
      // Keep every repeated attempt on the same bounded visible projection.
      this.messages = this.messages.slice(-100);
      this.emit("event", { type: "agent_settled", sessionId: SESSION_ID, sessionStatus: { runState: "idle" } });
    });
  }

  async transcriptPage(sessionId: string): Promise<TranscriptPage> {
    return { sessionId, revision: 1, viewId: "benchmark-view", incarnation: "benchmark-incarnation", appendFromRevision: 1, effectiveLeafId: "active-assistant-79", messages: [], hasOlder: false, olderCursor: null };
  }

  async branchTree(sessionId: string): Promise<BranchTreeResponse> {
    return {
      sessionId,
      revision: 1,
      incarnation: "benchmark-incarnation",
      durableLeafId: "active-assistant-79",
      effectiveLeafId: "active-assistant-79",
      activePath: ["root-user", "root-assistant", "active-user-79", "active-assistant-79"],
      nodes: [
        {
          id: "root-user", parentId: null, depth: 0, type: "message", role: "user", label: "User message",
          snippet: "benchmark root", timestamp: "2026-08-01T00:00:00.000Z", active: true, leaf: false,
          canSwitch: false, canEdit: false, canFork: false,
        },
        {
          id: "root-assistant", parentId: "root-user", depth: 1, type: "message", role: "assistant", label: "Assistant message",
          snippet: "benchmark root answer", timestamp: "2026-08-01T00:00:01.000Z", active: true, leaf: false,
          canSwitch: true, canEdit: false, canFork: false,
        },
        {
          id: "active-user-79", parentId: "root-assistant", depth: 2, type: "message", role: "user", label: "User message",
          snippet: "benchmark visible turn 79", timestamp: "2026-08-01T00:00:02.000Z", active: true, leaf: false,
          canSwitch: false, canEdit: true, canFork: true,
        },
        {
          id: "active-assistant-79", parentId: "active-user-79", depth: 3, type: "message", role: "assistant", label: "Assistant message",
          snippet: "settled benchmark answer 79", timestamp: "2026-08-01T00:00:03.000Z", active: true, leaf: true,
          canSwitch: true, canEdit: false, canFork: false,
        },
      ],
      truncated: false,
      health: { status: "ok" },
    };
  }

  async navigateBranch(request: BranchNavigateRequest): Promise<BranchNavigateResponse> {
    if (request.sessionId !== SESSION_ID || request.revision !== 1 || request.targetId !== "active-user-79" || request.mode !== "edit") {
      throw new Error("Unexpected benchmark branch navigation request");
    }
    return { snapshot: structuredClone(this.state()), editorText: "benchmark visible turn 79" };
  }
  async forkBranch(_request: BranchForkRequest): Promise<BranchForkResponse> { throw new Error("Benchmark fork must not be invoked"); }
  async resourceContext(sessionId: string): Promise<ResourceContext> {
    return { sessionId, viewId: "benchmark-view", cwd: this.record.cwd, messages: this.messages };
  }
  async close(): Promise<void> { for (const timer of this.timers) clearTimeout(timer); this.timers.clear(); }
}

async function freePort(port: number): Promise<boolean> {
  return new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolvePort(true)));
  });
}

async function waitForUrl(url: string, timeoutMs = 30_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { const response = await fetch(url); if (response.ok) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private listeners = new Map<string, Array<(params: Record<string, unknown>) => void>>();

  constructor(private readonly socket: WebSocket) {
    socket.on("message", (raw) => {
      const message = JSON.parse(String(raw)) as { id?: number; method?: string; params?: Record<string, unknown>; result?: unknown; error?: { message?: string } };
      if (message.id) {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message ?? "CDP error"));
        else waiter.resolve(message.result);
      } else if (message.method) {
        for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {});
      }
    });
  }

  static async connect(url: string) {
    const socket = new WebSocket(url);
    await new Promise<void>((resolveOpen, reject) => { socket.once("open", resolveOpen); socket.once("error", reject); });
    return new CdpClient(socket);
  }

  on(method: string, listener: (params: Record<string, unknown>) => void) {
    const list = this.listeners.get(method) ?? [];
    list.push(listener);
    this.listeners.set(method, list);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise<T>((resolveCommand, reject) => {
      this.pending.set(id, { resolve: (value) => resolveCommand(value as T), reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate<T>(expression: string): Promise<T> {
    const response = await this.send<{ result: { value?: T; description?: string }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (response.exceptionDetails) throw new Error(response.result.description ?? "Browser evaluation failed");
    return response.result.value as T;
  }

  async close() { this.socket.close(); }
}

async function launchChrome(root: string): Promise<{ process: ChildProcess; client: CdpClient }> {
  const executable = process.env.CHROME_PATH ?? join(process.env.HOME ?? "", ".cache/ms-playwright/chromium-1232/chrome-linux64/chrome");
  const userData = join(root, "chrome-profile");
  await mkdir(userData, { recursive: true });
  const child = spawn(executable, [
    "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage",
    "--remote-debugging-port=0", `--user-data-dir=${userData}`, "about:blank",
  ], { stdio: ["ignore", "ignore", "pipe"] });
  const activePortPath = join(userData, "DevToolsActivePort");
  let port = 0;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try { port = Number((await readFile(activePortPath, "utf8")).split("\n")[0]); if (port) break; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  if (!port) throw new Error("Chromium did not publish a DevTools port");
  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: "PUT" });
  const target = await targetResponse.json() as { webSocketDebuggerUrl: string };
  return { process: child, client: await CdpClient.connect(target.webSocketDebuggerUrl) };
}

async function waitFor(client: CdpClient, expression: string, timeoutMs = 15_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await client.evaluate<boolean>(`Boolean(${expression})`)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error(`Browser condition timed out: ${expression}`);
}

async function browserIteration(root: string, iteration: number): Promise<BrowserRun> {
  const chrome = await launchChrome(join(root, `browser-${iteration}`));
  const client = chrome.client;
  const requests: Record<string, number> = {};
  const websocketWitnesses: WebSocketWitness[] = [];
  let websocketCaptureActive = false;
  let websocketFrames = 0;
  let websocketBytes = 0;
  client.on("Network.requestWillBeSent", (params) => {
    const url = String((params.request as { url?: unknown } | undefined)?.url ?? "");
    if (!url.includes("/api/")) return;
    const path = new URL(url).pathname;
    requests[path] = (requests[path] ?? 0) + 1;
  });
  client.on("Network.webSocketFrameReceived", (params) => {
    if (!websocketCaptureActive) return;
    const payload = String((params.response as { payloadData?: unknown } | undefined)?.payloadData ?? "");
    websocketFrames += 1;
    websocketBytes += Buffer.byteLength(payload);
    websocketWitnesses.push(parseWebSocketWitness(payload));
  });
  try {
    await Promise.all([client.send("Page.enable"), client.send("Runtime.enable"), client.send("Network.enable")]);
    await client.send("Page.addScriptToEvaluateOnNewDocument", { source: `
      window.__INSPIRE_BROWSER_PERF__ = { longTasks: [], events: [], scrollDelays: [], frameGaps: [], eventLoopDelays: [] };
      try { new PerformanceObserver(list => { for (const e of list.getEntries()) window.__INSPIRE_BROWSER_PERF__.longTasks.push(e.duration); }).observe({ type: 'longtask', buffered: true }); } catch {}
      try { new PerformanceObserver(list => { for (const e of list.getEntries()) window.__INSPIRE_BROWSER_PERF__.events.push(Math.max(0, e.processingStart - e.startTime)); }).observe({ type: 'event', buffered: true, durationThreshold: 0 }); } catch {}
      let previousFrame = null;
      const observeFrame = now => {
        if (previousFrame !== null) window.__INSPIRE_BROWSER_PERF__.frameGaps.push(now - previousFrame);
        previousFrame = now;
        requestAnimationFrame(observeFrame);
      };
      requestAnimationFrame(observeFrame);
      const controlIntervalMs = 25;
      let previousControlTick = performance.now();
      setInterval(() => {
        const now = performance.now();
        window.__INSPIRE_BROWSER_PERF__.eventLoopDelays.push(Math.max(0, now - previousControlTick - controlIntervalMs));
        previousControlTick = now;
      }, controlIntervalMs);
      for (const type of ['wheel', 'keydown', 'pointerdown']) addEventListener(type, event => {
        const started = performance.now(); requestAnimationFrame(() => window.__INSPIRE_BROWSER_PERF__.scrollDelays.push(performance.now() - started));
      }, { capture: true, passive: true });
    ` });
    await client.send("Page.navigate", { url: `http://127.0.0.1:${WEB_PORT}/?token=${TOKEN}` });
    await waitFor(client, `document.querySelector('[aria-label="Message"]') && document.querySelector('[aria-label="Search conversation"]')`);

    const assertions = await client.evaluate<string[]>(`(() => {
      const seen = [];
      const visible = label => { const element = document.querySelector('[aria-label="' + label + '"]'); if (!element) throw new Error(label + ' is absent'); seen.push(label); return element; };
      visible('Sessions'); visible('Search sessions'); visible('Search conversation'); visible('Message'); visible('Toggle resources panel').click();
      return seen;
    })()`);
    await waitFor(client, `document.querySelector('[aria-label="Files and resources"]') && document.querySelector('.ctx__branch')?.textContent.includes('benchmark/maintenance')`);
    const chromeAssertions = await client.evaluate<string[]>(`(() => {
      const result = [];
      for (const label of ['Files', 'Changes', 'Branches']) {
        const button = [...document.querySelectorAll('.ctx__modes button')].find(node => node.textContent === label);
        if (!button) throw new Error(label + ' tab absent');
        result.push(label);
      }
      const sessionSearch = document.querySelector('[aria-label="Search sessions"]');
      const transcriptSearch = document.querySelector('[aria-label="Search conversation"]');
      for (const [element, value] of [[sessionSearch, 'benchmark'], [transcriptSearch, 'benchmark']]) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
        setter.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return result;
    })()`);
    assertions.push(...chromeAssertions);
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));

    for (const path of Object.keys(requests)) delete requests[path];
    websocketFrames = 0;
    websocketBytes = 0;
    websocketWitnesses.length = 0;
    websocketCaptureActive = true;
    await client.evaluate(`(() => {
      window.__INSPIRE_MAINTENANCE_BENCHMARK__.commits.length = 0;
      window.__INSPIRE_BROWSER_PERF__.longTasks.length = 0;
      window.__INSPIRE_BROWSER_PERF__.events.length = 0;
      window.__INSPIRE_BROWSER_PERF__.scrollDelays.length = 0;
      window.__INSPIRE_BROWSER_PERF__.frameGaps.length = 0;
      window.__INSPIRE_BROWSER_PERF__.eventLoopDelays.length = 0;
    })()`);

    const changesStarted = await client.evaluate<number>(`performance.now()`);
    const beforeChangesStatus = await client.evaluate<string>(`document.querySelector('.ctx__branch')?.textContent ?? ''`);
    await client.evaluate(`(() => {
      const witness = window.__INSPIRE_CHANGES_ENTRY_WITNESS__ = { sawRefreshLoading: false, observer: null };
      const observeState = () => {
        witness.sawRefreshLoading ||= Boolean(document.querySelector('[aria-label="Refresh Git status"]')?.disabled);
      };
      witness.observer = new MutationObserver(observeState);
      witness.observer.observe(document.body, { attributes: true, childList: true, subtree: true });
      observeState();
      [...document.querySelectorAll('.ctx__modes button')].find(node => node.textContent === 'Changes').click();
    })()`);
    await waitFor(client, `
      window.__INSPIRE_CHANGES_ENTRY_WITNESS__?.sawRefreshLoading &&
      document.querySelector('[aria-label="Repository changes"]') &&
      !document.querySelector('[aria-label="Refresh Git status"]')?.disabled &&
      document.querySelector('.ctx__branch')?.textContent !== ${JSON.stringify(beforeChangesStatus)}
    `, 3_000);
    await client.evaluate(`window.__INSPIRE_CHANGES_ENTRY_WITNESS__?.observer?.disconnect()`);
    await client.evaluate(`document.querySelector('[aria-label="analysis.ts, unstaged modified"]').click()`);
    await waitFor(client, `document.querySelector('[aria-label="Diff for analysis.ts"]')?.textContent.includes('benchmark diff revision')`);
    const beforeRefresh = await client.evaluate<{ status: string; diff: string }>(`({
      status: document.querySelector('.ctx__branch')?.textContent ?? '',
      diff: document.querySelector('[aria-label="Diff for analysis.ts"]')?.textContent ?? ''
    })`);
    const changesAssertions = await client.evaluate<string[]>(`(() => {
      const row = document.querySelector('[aria-label="analysis.ts, unstaged modified"]');
      const detail = document.querySelector('[aria-label="Change detail"]');
      const diff = [...detail.querySelectorAll('button')].find(node => node.textContent === 'Diff');
      const refresh = document.querySelector('[aria-label="Refresh Git status"]');
      if (!row || row.getAttribute('aria-current') !== 'true') throw new Error('changed row did not become authoritative selection');
      if (!diff || diff.getAttribute('aria-pressed') !== 'true') throw new Error('Diff control did not reflect the selected detail');
      if (!refresh || refresh.disabled) throw new Error('Git refresh control is unavailable');
      const witness = window.__INSPIRE_CHANGES_REFRESH_WITNESS__ = { sawRefreshLoading: false, sawDiffLoading: false, observer: null };
      const observeState = () => {
        witness.sawRefreshLoading ||= Boolean(document.querySelector('[aria-label="Refresh Git status"]')?.disabled);
        witness.sawDiffLoading ||= document.body.textContent.includes('Loading diff…');
      };
      witness.observer = new MutationObserver(observeState);
      witness.observer.observe(document.body, { attributes: true, childList: true, subtree: true });
      observeState();
      refresh.click();
      return ['repository change row', 'diff detail control', 'Git refresh control'];
    })()`);
    assertions.push(...changesAssertions);
    await waitFor(client, `
      window.__INSPIRE_CHANGES_REFRESH_WITNESS__?.sawRefreshLoading &&
      window.__INSPIRE_CHANGES_REFRESH_WITNESS__?.sawDiffLoading &&
      !document.querySelector('[aria-label="Refresh Git status"]')?.disabled &&
      !document.body.textContent.includes('Loading diff…') &&
      document.querySelector('.ctx__branch')?.textContent !== ${JSON.stringify(beforeRefresh.status)} &&
      document.querySelector('[aria-label="Diff for analysis.ts"]')?.textContent !== ${JSON.stringify(beforeRefresh.diff)}
    `, 3_000);
    const refreshedChangesAssertions = await client.evaluate<string[]>(`(() => {
      const row = document.querySelector('[aria-label="analysis.ts, unstaged modified"]');
      const detail = document.querySelector('[aria-label="Change detail"]');
      const diffControl = [...detail.querySelectorAll('button')].find(node => node.textContent === 'Diff');
      const refresh = document.querySelector('[aria-label="Refresh Git status"]');
      const status = document.querySelector('.ctx__branch')?.textContent ?? '';
      const diff = document.querySelector('[aria-label="Diff for analysis.ts"]')?.textContent ?? '';
      const witness = window.__INSPIRE_CHANGES_REFRESH_WITNESS__;
      witness?.observer?.disconnect();
      if (!witness?.sawRefreshLoading || !witness?.sawDiffLoading) throw new Error('Changes refresh loading cycle was not rendered');
      if (refresh?.disabled || document.body.textContent.includes('Loading diff…')) throw new Error('Changes refresh did not settle');
      if (!status.startsWith('benchmark/maintenance@') || status === ${JSON.stringify(beforeRefresh.status)}) throw new Error('Rendered Git status did not update');
      if (!diff.includes('benchmark diff revision') || diff === ${JSON.stringify(beforeRefresh.diff)}) throw new Error('Selected diff did not reload');
      if (row?.getAttribute('aria-current') !== 'true' || diffControl?.getAttribute('aria-pressed') !== 'true') throw new Error('Changes selection was not retained');
      return ['Git refresh loading cycle', 'updated rendered Git status', 'updated selected diff', 'settled Changes end state'];
    })()`);
    assertions.push(...refreshedChangesAssertions);
    const changesMs = (await client.evaluate<number>(`performance.now()`)) - changesStarted;

    const branchesStarted = await client.evaluate<number>(`performance.now()`);
    await client.evaluate(`([...document.querySelectorAll('.ctx__modes button')].find(node => node.textContent === 'Branches')).click()`);
    await waitFor(client, `document.querySelector('[aria-label="Session branch history"]')`);
    const branchAssertions = await client.evaluate<string[]>(`(() => {
      window.confirm = () => true;
      const rows = [...document.querySelectorAll('.branch-row')];
      const current = document.querySelector('[aria-label="Current branch: Assistant message"]');
      const edit = document.querySelector('[aria-label="Edit from here: User message"]');
      const fork = document.querySelector('[aria-label="Fork from here: User message"]');
      const refresh = document.querySelector('[aria-label="Refresh branch history"]');
      if (rows.length !== 4) throw new Error('expected four concrete branch rows');
      if (!current || !current.disabled || current.getAttribute('aria-current') !== 'true') throw new Error('current branch control is not disabled/current');
      if (!edit || edit.disabled || !fork || fork.disabled) throw new Error('branch edit/fork actions are unavailable');
      if (!refresh || refresh.disabled) throw new Error('branch refresh control is unavailable');
      edit.click();
      return ['four branch rows', 'current branch control', 'edit branch action', 'fork branch action', 'branch refresh control'];
    })()`);
    assertions.push(...branchAssertions);
    await waitFor(client, `document.querySelector('[aria-label="Message"]')?.value === 'benchmark visible turn 79' && !document.querySelector('[aria-label="Session branch history"]')?.getAttribute('aria-busy')`);
    const branchesMs = (await client.evaluate<number>(`performance.now()`)) - branchesStarted;

    const filesStarted = await client.evaluate<number>(`performance.now()`);
    await client.evaluate(`([...document.querySelectorAll('.ctx__modes button')].find(node => node.textContent === 'Files')).click()`);
    await waitFor(client, `document.querySelector('[aria-label="Referenced files"]')`);
    assertions.push("referenced Files rows");
    await client.evaluate(`(() => {
      const textarea = document.querySelector('[aria-label="Message"]');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, 'run frozen benchmark scenario'); textarea.dispatchEvent(new Event('input', { bubbles: true })); textarea.focus();
    })()`);
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", text: "a" });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA" });
    await client.evaluate(`document.querySelector('[aria-label="Message composer"]').requestSubmit()`);
    await waitFor(client, `document.body.textContent.includes('Pending steering') && document.body.textContent.includes('Pending follow-up')`);
    await waitFor(client, `document.querySelector('[aria-label="Current activity"]')?.textContent.includes('read')`);
    assertions.push("active tool activity");
    const box = await client.evaluate<{ x: number; y: number }>(`(() => { const r = document.querySelector('[role="log"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await client.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: box.x, y: box.y, deltaX: 0, deltaY: -240 });
    await waitFor(client, `document.body.textContent.includes('Frozen evaluator stream completed') && !document.querySelector('[aria-label="Abort running task"]')`, 20_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
    const filesAndStreamingMs = (await client.evaluate<number>(`performance.now()`)) - filesStarted;

    const expectedCompleted = Array.from({ length: BACKGROUND_SETTLEMENTS }, (_, index) => `Background benchmark ${index + 1}`).sort();
    const result = await client.evaluate<{
      commits: CommitRecord[];
      perf: { longTasks: number[]; events: number[]; scrollDelays: number[]; frameGaps: number[]; eventLoopDelays: number[] };
      checks: Record<string, boolean>;
      completedBackgroundRows: string[];
    }>(`(() => {
      const completedBackgroundRows = [...document.querySelectorAll('.nav__row')]
        .filter(row => row.querySelector('[aria-label="Completed"]'))
        .map(row => row.querySelector('.nav__row-name')?.textContent ?? '')
        .sort();
      return {
        commits: window.__INSPIRE_MAINTENANCE_BENCHMARK__.commits,
        perf: window.__INSPIRE_BROWSER_PERF__,
        completedBackgroundRows,
        checks: {
          files: Boolean(document.querySelector('[aria-label="Referenced files"]')),
          search: document.querySelector('[aria-label="Search conversation"]')?.value === 'benchmark',
          queueSettled: !document.body.textContent.includes('Pending steering') && !document.body.textContent.includes('Pending follow-up'),
          backgroundSettled: JSON.stringify(completedBackgroundRows) === ${JSON.stringify(JSON.stringify(expectedCompleted))},
          streamed: document.body.textContent.includes('Frozen evaluator stream completed'),
          tool: [...document.querySelectorAll('.card__tool-name')].some(node => node.textContent === 'read') && document.body.textContent.includes('analysis.ts')
        }
      };
    })()`);
    for (const [name, passed] of Object.entries(result.checks)) {
      if (!passed) throw new Error(`Browser equivalence check failed: ${name}; completed rows=${JSON.stringify(result.completedBackgroundRows)}`);
      assertions.push(name);
    }
    const actualRequests = Object.fromEntries(Object.entries(requests).sort(([left], [right]) => left.localeCompare(right)));
    const expectedRequests = Object.fromEntries(Object.entries(EXPECTED_SCENARIO_REQUESTS).sort(([left], [right]) => left.localeCompare(right)));
    if (JSON.stringify(actualRequests) !== JSON.stringify(expectedRequests)) {
      throw new Error(`Scenario request accounting changed: expected ${JSON.stringify(expectedRequests)}, received ${JSON.stringify(actualRequests)}`);
    }
    if (websocketFrames !== websocketWitnesses.length) throw new Error("WebSocket byte/frame counters diverged from parsed witnesses");
    assertExactWebSocketWitnesses(websocketWitnesses);
    assertions.push("four rendered background completions", "exact HTTP accounting", "exact ordered typed WebSocket accounting");
    return {
      commits: result.commits,
      longTasks: result.perf.longTasks,
      inputDelays: result.perf.events,
      scrollDelays: result.perf.scrollDelays,
      frameGaps: result.perf.frameGaps,
      eventLoopDelays: result.perf.eventLoopDelays,
      requests: actualRequests,
      websocketFrames,
      websocketBytes,
      websocketWitnesses: [...websocketWitnesses],
      interactionMs: { changes: changesMs, branches: branchesMs, filesAndStreaming: filesAndStreamingMs },
      assertions,
    };
  } finally {
    await client.close().catch(() => undefined);
    chrome.process.kill("SIGTERM");
  }
}

async function measureHost(record: SessionRecord): Promise<HostRun> {
  const projectionMs: number[] = [];
  let visibleMessages = 0;
  let visibleBytes = 0;
  for (let iteration = 0; iteration < HOST_SAMPLES; iteration += 1) {
    const started = performance.now();
    const projection = await SessionProjection.open(record);
    projectionMs.push(performance.now() - started);
    const page = projection.latestPage();
    visibleMessages = page.messages.length;
    visibleBytes = Buffer.byteLength(JSON.stringify(page));
    await projection.close();
  }

  const catalog = new SessionCatalog(record.cwd);
  const catalogMs: number[] = [];
  for (let iteration = 0; iteration < HOST_SAMPLES; iteration += 1) {
    catalog.invalidate();
    const started = performance.now();
    const list = await catalog.list({ limit: 40 });
    catalogMs.push(performance.now() - started);
    if (!list.sessions.some((session) => session.id === SESSION_ID)) throw new Error("Real catalog did not find benchmark session");
  }

  const git = new GitInspectionService();
  const statusMs: number[] = [];
  for (let iteration = 0; iteration < HOST_SAMPLES; iteration += 1) {
    const started = performance.now();
    await git.status(process.cwd());
    statusMs.push(performance.now() - started);
  }
  return { persistedBytes: (await stat(record.path)).size, visibleMessages, visibleBytes, projectionMs, catalogMs, statusMs };
}

async function main() {
  if (process.env.INSPIRE_BENCHMARK_ISOLATED !== "1") {
    throw new Error("Benchmark isolation was not acknowledged. Stop builds/checks and other CPU work, then run with INSPIRE_BENCHMARK_ISOLATED=1");
  }
  const websocketFailureProbes = runWebSocketFailureProbes();
  const samplingRuleProbes = runSamplingRuleProbes();
  if (!await freePort(HOST_PORT) || !await freePort(WEB_PORT)) throw new Error(`Evaluator requires free loopback ports ${HOST_PORT} and ${WEB_PORT}`);
  const root = await mkdtemp(join(tmpdir(), "inspire-maintenance-evaluator-"));
  let vite: ChildProcess | null = null;
  let application: ReturnType<typeof createInspireServer> | null = null;
  try {
    const fixture = await createLongSession(root);
    const catalog = new BenchmarkCatalog(fixture.record);
    const runtime = new BenchmarkRuntime(fixture.record, fixture.entries);
    const git = new BenchmarkGit();
    const attachments = new AttachmentStore(join(root, "uploads"));
    const preferences = new PreferencesStore(join(root, "preferences.json"));
    await preferences.patch({ completionAttention: "title" });
    application = createInspireServer({
      token: TOKEN,
      runtime,
      catalog,
      attachments,
      preferences,
      resources: new ResourceStore(),
      git,
      mock: true,
      version: "0.1.0-benchmark",
      piVersion: "0.83.0",
      distDir: join(root, "absent-dist"),
    });
    await new Promise<void>((resolveListen, reject) => {
      application!.server.once("error", reject);
      application!.server.listen(HOST_PORT, "127.0.0.1", resolveListen);
    });
    vite = spawn(resolve("node_modules/.bin/vite"), ["--mode", "maintenance-benchmark", "--host", "127.0.0.1", "--port", String(WEB_PORT), "--strictPort"], {
      cwd: process.cwd(), env: { ...process.env, NO_COLOR: "1" }, stdio: ["ignore", "ignore", "pipe"],
    });
    await waitForUrl(`http://127.0.0.1:${WEB_PORT}`);

    const host = await measureHost(fixture.record);
    const browser: BrowserRun[] = [];
    const discarded: Array<{
      attempt: number;
      reasons: string[];
      frameGapsMs: ReturnType<typeof stats>;
      eventLoopDelaysMs: ReturnType<typeof stats>;
    }> = [];
    let attempts = 0;
    while (browser.length < ACCEPTED_BROWSER_SAMPLES && attempts < MAX_BROWSER_ATTEMPTS) {
      const attempt = attempts++;
      const run = await browserIteration(root, attempt);
      const reasons = contaminationReasons(run);
      if (reasons.length === 0) browser.push(run);
      else discarded.push({
        attempt,
        reasons,
        frameGapsMs: stats(run.frameGaps),
        eventLoopDelaysMs: stats(run.eventLoopDelays),
      });
    }
    if (browser.length < ACCEPTED_BROWSER_SAMPLES) {
      console.log(JSON.stringify({
        schemaVersion: 2,
        decision: "invalid-benchmark",
        reason: `Only ${browser.length} uncontaminated samples were accepted within ${MAX_BROWSER_ATTEMPTS} attempts`,
        sampling: { accepted: browser.length, attempts, discarded },
      }, null, 2));
      process.exitCode = 3;
      return;
    }

    const surfaceNames = ["navigation", "transcript", "composer", "resources"];
    const react = Object.fromEntries(surfaceNames.map((surface) => {
      const commits = browser.flatMap((run) => run.commits.filter((commit) => commit.surface === surface));
      return [surface, {
        commits: commits.length,
        durationMs: stats(commits.map((commit) => commit.actualDuration)),
        totalDurationMs: commits.reduce((sum, commit) => sum + commit.actualDuration, 0),
        perIterationCommits: browser.map((run) => run.commits.filter((commit) => commit.surface === surface).length),
      }];
    }));
    const requestTotals: Record<string, number[]> = {};
    for (const run of browser) for (const [path, count] of Object.entries(run.requests)) (requestTotals[path] ??= []).push(count);
    const perSampleReactP95 = Object.fromEntries(surfaceNames.map((surface) => [
      surface,
      browser.map((run) => percentile(run.commits.filter((commit) => commit.surface === surface).map((commit) => commit.actualDuration), 0.95)),
    ])) as Record<string, number[]>;
    const decisionWitnesses = {
      browserLongTask: repeatabilityWitness(browser.map((run) => percentile(run.longTasks, 0.95)), thresholds.browserLongTaskMs),
      browserInputDelay: repeatabilityWitness(browser.map((run) => percentile(run.inputDelays, 0.95)), thresholds.browserInputDelayMs),
      browserScrollDelay: repeatabilityWitness(browser.map((run) => percentile(run.scrollDelays, 0.95)), thresholds.browserScrollDelayMs),
      changesInteraction: repeatabilityWitness(browser.map((run) => run.interactionMs.changes), thresholds.browserInteractionMs),
      branchesInteraction: repeatabilityWitness(browser.map((run) => run.interactionMs.branches), thresholds.browserInteractionMs),
      react: Object.fromEntries(surfaceNames.map((surface) => [surface, repeatabilityWitness(perSampleReactP95[surface]!, thresholds.reactSurfaceCommitMs)])),
      hostProjection: repeatabilityWitness(host.projectionMs, thresholds.hostProjectionP95Ms),
      hostCatalog: repeatabilityWitness(host.catalogMs, thresholds.hostCatalogP95Ms),
      hostStatus: repeatabilityWitness(host.statusMs, thresholds.hostStatusP95Ms),
    };
    const summary = {
      schemaVersion: 2,
      scenario: {
        isolationAcknowledged: true,
        acceptedBrowserSamples: browser.length,
        browserAttemptBudget: MAX_BROWSER_ATTEMPTS,
        hostSamples: HOST_SAMPLES,
        persistedMinimumBytes: PERSISTED_TARGET_BYTES,
        streamDeltas: STREAM_DELTAS,
        backgroundSettlements: BACKGROUND_SETTLEMENTS,
        visibleSurfaces: ["Files", "Changes", "Branches", "session search", "transcript search", "pending queues", "branch navigation"],
      },
      thresholds,
      decisionRule: {
        percentile: 0.95,
        minimumCrossings: MIN_REPEAT_CROSSINGS,
        minimumCrossingFraction: MIN_REPEAT_FRACTION,
        rule: "activate only when p95 reaches the threshold and at least max(minimumCrossings, ceil(samples * minimumCrossingFraction)) independent samples cross it",
        failureProbes: samplingRuleProbes,
      },
      decisionWitnesses,
      host: {
        persistedBytes: host.persistedBytes,
        visibleMessages: host.visibleMessages,
        visibleBytes: host.visibleBytes,
        projectionMs: stats(host.projectionMs),
        catalogMs: stats(host.catalogMs),
        gitStatusMs: stats(host.statusMs),
      },
      browser: {
        sampling: {
          accepted: browser.length,
          attempts,
          discarded,
          controlThresholds: {
            minimumFrameSamples: CONTROL_MIN_FRAME_SAMPLES,
            minimumEventLoopSamples: CONTROL_MIN_EVENT_LOOP_SAMPLES,
            maximumFrameGapP95Ms: CONTROL_MAX_FRAME_P95_MS,
            maximumEventLoopDelayP95Ms: CONTROL_MAX_EVENT_LOOP_P95_MS,
          },
        },
        control: {
          frameGapsMs: stats(browser.flatMap((run) => run.frameGaps)),
          eventLoopDelaysMs: stats(browser.flatMap((run) => run.eventLoopDelays)),
          perSampleFrameMaxMs: stats(browser.map((run) => Math.max(...run.frameGaps))),
          perSampleEventLoopMaxMs: stats(browser.map((run) => Math.max(...run.eventLoopDelays))),
        },
        react,
        longTasksMs: stats(browser.flatMap((run) => run.longTasks)),
        inputDelayMs: stats(browser.flatMap((run) => run.inputDelays)),
        scrollDelayMs: stats(browser.flatMap((run) => run.scrollDelays)),
        interactionMs: {
          changes: stats(browser.map((run) => run.interactionMs.changes)),
          branches: stats(browser.map((run) => run.interactionMs.branches)),
          filesAndStreaming: stats(browser.map((run) => run.interactionMs.filesAndStreaming)),
        },
        websocketFrames: stats(browser.map((run) => run.websocketFrames)),
        websocketBytes: stats(browser.map((run) => run.websocketBytes)),
        requests: Object.fromEntries(Object.entries(requestTotals).map(([path, counts]) => [path, stats(counts)])),
        deterministicAccounting: {
          expectedRequests: EXPECTED_SCENARIO_REQUESTS,
          requestDerivation: {
            branchNavigate: "one edit-from-here action",
            branchTree: "initial Branches load plus post-navigation reload",
            gitDiff: "changed-row selection plus selected-diff reload after explicit status refresh",
            gitStatus: "Changes entry plus explicit refresh plus settled tool refresh",
            prompt: "one submitted streaming prompt",
            sessions: "one loaded-extent refresh for each of four background settlements",
            snapshot: "one selected-session settlement resync",
          },
          expectedWebsocketFrames: EXPECTED_WEBSOCKET_WITNESSES.length,
          expectedWebsocketSequence: EXPECTED_WEBSOCKET_WITNESSES,
          websocketFailureProbes,
          websocketFrameDerivation: {
            promptStartFrames: 5,
            textDeltaFrames: STREAM_DELTAS,
            toolEndFrames: 1,
            backgroundLifecycleFrames: BACKGROUND_SETTLEMENTS * 2,
            selectedSettlementFrames: 2,
          },
        },
        assertionsPerIteration: browser.map((run) => run.assertions),
      },
    };
    const activated: string[] = [];
    if (decisionWitnesses.browserLongTask.activated) activated.push("browser-long-task");
    if (decisionWitnesses.browserInputDelay.activated) activated.push("browser-input-delay");
    if (decisionWitnesses.browserScrollDelay.activated) activated.push("browser-scroll-delay");
    if (decisionWitnesses.changesInteraction.activated) activated.push("changes-interaction");
    if (decisionWitnesses.branchesInteraction.activated) activated.push("branches-interaction");
    for (const [surface, witness] of Object.entries(decisionWitnesses.react)) {
      if (witness.activated) activated.push(`react-${surface}`);
    }
    if (decisionWitnesses.hostProjection.activated) activated.push("host-projection");
    if (decisionWitnesses.hostCatalog.activated) activated.push("host-catalog");
    if (decisionWitnesses.hostStatus.activated) activated.push("host-status");
    const report = { ...summary, activatedSuspects: activated, decision: activated.length === 0 ? "no-performance-change" : "trace-review-required" };
    console.log(JSON.stringify(report, null, 2));
    if (activated.length > 0) process.exitCode = 2;
  } finally {
    vite?.kill("SIGTERM");
    await application?.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
}

await main();
