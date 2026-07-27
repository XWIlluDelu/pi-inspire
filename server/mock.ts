import { EventEmitter } from "node:events";
import type { ActiveSnapshot, PromptRequest, SessionListResponse, SessionSummary } from "../shared/contracts.js";
import { parseCompactCommand, type RuntimeLike } from "./runtime.js";
import type { SessionCatalogLike, SessionRecord } from "./session-catalog.js";

const now = Date.now();
const summaries: SessionSummary[] = [
  {
    id: "mock-active",
    cwd: "/home/demo/research",
    project: "research",
    title: "Formula rendering and spectral analysis",
    created: new Date(now - 86_400_000).toISOString(),
    modified: new Date(now - 90_000).toISOString(),
    messageCount: 5,
  },
  {
    id: "mock-history",
    cwd: "/home/demo/pi-extension",
    project: "pi-extension",
    title: "Review extension event lifecycle",
    created: new Date(now - 604_800_000).toISOString(),
    modified: new Date(now - 172_800_000).toISOString(),
    messageCount: 12,
  },
];

const richText = `## A compact result

The normalized wave equation is

$$
\\frac{\\partial^2 u}{\\partial t^2}=c^2\\nabla^2u
$$

and the conserved energy is $E=mc^2$ for the familiar relativistic case.

| Quantity | Value |
| --- | ---: |
| Samples | 2,048 |
| Peak frequency | 12.4 Hz |

- [x] Load the signal
- [x] Compute the spectrum
- [ ] Validate the final interpretation

\`\`\`python
frequencies = np.fft.rfftfreq(signal.size, d=1 / sample_rate)
power = np.abs(np.fft.rfft(signal)) ** 2
\`\`\`

See the [Pi documentation](https://pi.dev) for the runtime contract.`;

const initialMessages = [
  {
    role: "user",
    content: "Show me a formula-rich example and inspect the analysis steps.",
    timestamp: now - 30_000,
  },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "I should keep the derivation compact and make every result inspectable." },
      { type: "toolCall", id: "mock-tool-1", name: "read", arguments: { path: "analysis/spectrum.py" } },
      { type: "text", text: richText },
    ],
    provider: "kimi-coding",
    model: "kimi-k3",
    usage: { input: 800, output: 420, cacheRead: 320, cacheWrite: 0, totalTokens: 1_540, cost: { total: 0 } },
    stopReason: "stop",
    timestamp: now - 28_000,
  },
  {
    role: "toolResult",
    toolCallId: "mock-tool-1",
    toolName: "read",
    content: [{ type: "text", text: "Read 84 lines from analysis/spectrum.py" }],
    isError: false,
    timestamp: now - 29_000,
  },
  {
    role: "assistant",
    content: [
      { type: "toolCall", id: "mock-tool-2", name: "edit", arguments: { path: "analysis/spectrum.py" } },
      { type: "text", text: "Tightened the window normalization." },
    ],
    provider: "kimi-coding",
    model: "kimi-k3",
    usage: { input: 900, output: 160, cacheRead: 620, cacheWrite: 0, totalTokens: 1_680, cost: { total: 0 } },
    stopReason: "stop",
    timestamp: now - 26_000,
  },
  {
    role: "toolResult",
    toolCallId: "mock-tool-2",
    toolName: "edit",
    content: [
      {
        type: "text",
        text: [
          "--- a/analysis/spectrum.py",
          "+++ b/analysis/spectrum.py",
          "@@ -12,7 +12,7 @@ def window(samples):",
          "     total = samples.sum()",
          "-    scale = 1.0 / len(samples)",
          "+    scale = 1.0 / max(1, len(samples))",
          "     return total * scale",
        ].join("\n"),
      },
    ],
    isError: false,
    timestamp: now - 25_000,
  },
];

export class MockCatalog implements SessionCatalogLike {
  async refresh(): Promise<readonly SessionRecord[]> {
    return [];
  }
  async get(id: string): Promise<SessionRecord | undefined> {
    const summary = summaries.find((session) => session.id === id);
    if (!summary) return undefined;
    return {
      path: `/mock/${id}.jsonl`,
      id,
      cwd: summary.cwd,
      name: summary.title,
      created: new Date(summary.created),
      modified: new Date(summary.modified),
      messageCount: summary.messageCount,
      firstMessage: summary.title,
      searchText: `${summary.title}\n${summary.cwd}`.toLowerCase(),
    };
  }
  async list(options: { query?: string; offset?: number; limit?: number } = {}): Promise<SessionListResponse> {
    const query = options.query?.trim().toLowerCase().slice(0, 200) ?? "";
    const matches = summaries.filter((item) => `${item.title} ${item.project}`.toLowerCase().includes(query));
    const offset = Math.max(0, Number.isFinite(options.offset) ? Math.floor(options.offset!) : 0);
    const limit = Math.min(100, Math.max(1, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 40));
    return { sessions: matches.slice(offset, offset + limit), total: matches.length, offset, limit };
  }
  async listByIds(ids: readonly string[]): Promise<SessionSummary[]> {
    const requested = new Set(ids);
    return summaries.filter((session) => requested.has(session.id));
  }
  invalidate(): void {}
}

export class MockRuntime extends EventEmitter implements RuntimeLike {
  private state: ActiveSnapshot = { active: null, runState: "idle", sessionStatuses: {} };
  private readonly sessions = new Map<string, NonNullable<ActiveSnapshot["active"]>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private nextSession = 0;

  get activeSessionId(): string | null {
    return this.state.active?.sessionId ?? null;
  }

  sessionCwd(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.cwd ?? null;
  }

  private requireSession(sessionId: string): NonNullable<ActiveSnapshot["active"]> {
    const session = this.sessions.get(sessionId);
    if (!session) throw Object.assign(new Error("That session is not open on this host"), { status: 409 });
    return session;
  }

  private activate(id = "mock-active", cwd = "/home/demo/research"): ActiveSnapshot {
    const summary = summaries.find((item) => item.id === id);
    let active = this.sessions.get(id);
    if (!active) {
      active = {
        sessionId: id,
        sessionFile: `/mock/${id}.jsonl`,
        sessionName: summary?.title ?? "New session",
        cwd,
        model: { provider: "kimi-coding", id: "kimi-k3", name: "Kimi K3" },
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        messages: summary ? structuredClone(initialMessages) : [],
        stats: { contextUsage: { tokens: 12_640, contextWindow: 131_072, percent: 9.64 } },
        availableModels: [
          { provider: "kimi-coding", id: "kimi-k3", contextWindow: 131_072, reasoning: true },
          { provider: "anthropic", id: "claude-sonnet-4", contextWindow: 200_000, reasoning: true },
        ],
        commands: [
          { name: "compact", description: "Compact the current context", source: "extension" },
          { name: "skill:docdoki", description: "Maintain project design documents", source: "skill" },
        ],
      };
      this.sessions.set(id, active);
    }

    const currentStatus = this.state.sessionStatuses[id] ?? { runState: "idle" as const };
    const viewedStatus =
      currentStatus.indicator === "running" ? currentStatus : { runState: currentStatus.runState };
    this.state.active = active;
    this.state.runState = viewedStatus.runState;
    this.state.sessionStatuses[id] = viewedStatus;
    return this.state;
  }

  async openSession(id: string): Promise<ActiveSnapshot> {
    return this.activate(id, summaries.find((item) => item.id === id)?.cwd ?? "/home/demo/research");
  }

  async newSession(cwdInput: string, name?: string): Promise<ActiveSnapshot> {
    const id = `mock-new-${++this.nextSession}`;
    const snapshot = this.activate(id, cwdInput);
    if (snapshot.active) snapshot.active.sessionName = name || "New session";
    return snapshot;
  }

  private emitSession(id: string, event: Record<string, unknown>): void {
    this.emit("event", { ...event, sessionId: id, sessionStatus: this.state.sessionStatuses[id] });
  }

  async prompt(request: PromptRequest): Promise<void> {
    const active = this.requireSession(request.sessionId);
    // Same prompt boundary as the real host: a bare /compact compacts.
    if (parseCompactCommand(request.message) && !request.attachmentIds?.length && !request.projectFiles?.length) {
      await this.compact(request.sessionId);
      return;
    }
    if (active.isStreaming) throw new Error("Mock session is already streaming");
    const sessionId = active.sessionId;
    const timestamp = Date.now();
    const user = { role: "user", content: request.message, timestamp };
    active.messages.push(user);
    active.isStreaming = true;
    if (this.state.active?.sessionId === sessionId) this.state.runState = "running";
    this.state.sessionStatuses[sessionId] = { runState: "running", indicator: "running" };
    this.emitSession(sessionId, { type: "message_start", message: user });
    this.emitSession(sessionId, { type: "agent_start" });

    const answer = `You asked: **${request.message || "about the attached material"}**.\n\nThe live mock stream confirms inline math $a^2+b^2=c^2$ and display math:\n\n$$\\int_0^1 x^2\\,dx=\\frac13$$`;
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      provider: "kimi-coding",
      model: "kimi-k3",
      stopReason: "stop",
      timestamp: timestamp + 1,
    };
    active.messages.push(assistant);
    this.emitSession(sessionId, { type: "message_start", message: assistant });
    const chunks = answer.match(/.{1,14}/gs) ?? [answer];
    let index = 0;
    const timer = setInterval(() => {
      const chunk = chunks[index++];
      if (chunk !== undefined) {
        (assistant.content[0] as { text: string }).text += chunk;
        this.emitSession(sessionId, {
          type: "message_update",
          message: structuredClone(assistant),
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk, partial: structuredClone(assistant) },
        });
        return;
      }
      clearInterval(timer);
      this.timers.delete(sessionId);
      active.isStreaming = false;
      const selected = this.state.active?.sessionId === sessionId;
      this.state.sessionStatuses[sessionId] = selected
        ? { runState: "idle" }
        : { runState: "idle", indicator: "completed" };
      if (selected) this.state.runState = "idle";
      this.emitSession(sessionId, { type: "message_end", message: structuredClone(assistant) });
      this.emitSession(sessionId, { type: "agent_settled" });
    }, 18);
    this.timers.set(sessionId, timer);
  }

  async abort(sessionId: string): Promise<void> {
    const active = this.requireSession(sessionId);
    const timer = this.timers.get(active.sessionId);
    if (timer) clearInterval(timer);
    this.timers.delete(active.sessionId);
    active.isStreaming = false;
    this.state.sessionStatuses[active.sessionId] = { runState: "aborted" };
    if (this.state.active?.sessionId === active.sessionId) this.state.runState = "aborted";
    this.emitSession(active.sessionId, { type: "agent_settled" });
  }

  async compact(sessionId = this.state.active?.sessionId ?? ""): Promise<unknown> {
    this.requireSession(sessionId);
    const selected = this.state.active?.sessionId === sessionId;
    if (selected) this.state.runState = "compacting";
    this.state.sessionStatuses[sessionId] = { runState: "compacting", indicator: "running" };
    this.emitSession(sessionId, { type: "compaction_start", reason: "manual" });
    if (selected) this.state.runState = "idle";
    this.state.sessionStatuses[sessionId] = { runState: "idle" };
    this.emitSession(sessionId, { type: "compaction_end", reason: "manual", result: { tokensBefore: 12_640 } });
    return { tokensBefore: 12_640, estimatedTokensAfter: 4_200 };
  }

  async rename(sessionId: string, name: string): Promise<void> {
    this.requireSession(sessionId).sessionName = name;
  }
  async setModel(sessionId: string, provider: string, modelId: string): Promise<unknown> {
    const session = this.requireSession(sessionId);
    session.model = { provider, id: modelId };
    return session.model;
  }
  async setThinkingLevel(sessionId: string, level: string): Promise<void> {
    this.requireSession(sessionId).thinkingLevel = level;
  }
  async extensionUiResponse(): Promise<void> {}
  async snapshot(): Promise<ActiveSnapshot> {
    return structuredClone(this.state);
  }
  async resourceContext(sessionId: string) {
    const active = this.state.active;
    if (!active || active.sessionId !== sessionId) {
      throw Object.assign(new Error("The resource does not belong to the visible session"), { status: 409 });
    }
    return { sessionId, cwd: active.cwd, messages: active.messages };
  }
  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
