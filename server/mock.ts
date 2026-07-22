import { EventEmitter } from "node:events";
import type { ActiveSnapshot, PromptRequest, SessionListResponse, SessionSummary } from "../shared/contracts.js";
import type { RuntimeLike } from "./runtime.js";
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
];

export class MockCatalog implements SessionCatalogLike {
  async refresh(): Promise<readonly SessionRecord[]> {
    return [];
  }
  async get(): Promise<SessionRecord | undefined> {
    return undefined;
  }
  async list(options: { query?: string; offset?: number; limit?: number } = {}): Promise<SessionListResponse> {
    const query = options.query?.trim().toLowerCase().slice(0, 200) ?? "";
    const matches = summaries.filter((item) => `${item.title} ${item.project}`.toLowerCase().includes(query));
    const offset = Math.max(0, Number.isFinite(options.offset) ? Math.floor(options.offset!) : 0);
    const limit = Math.min(100, Math.max(1, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 40));
    return { sessions: matches.slice(offset, offset + limit), total: matches.length, offset, limit };
  }
  invalidate(): void {}
}

export class MockRuntime extends EventEmitter implements RuntimeLike {
  activeCwd: string | null = null;
  private state: ActiveSnapshot = { active: null, runState: "idle" };
  private timer: NodeJS.Timeout | null = null;

  private activate(id = "mock-active", cwd = "/home/demo/research"): ActiveSnapshot {
    const summary = summaries.find((item) => item.id === id) ?? summaries[0]!;
    this.activeCwd = cwd;
    this.state = {
      active: {
        sessionId: summary.id,
        sessionFile: `/mock/${summary.id}.jsonl`,
        sessionName: summary.title,
        cwd,
        model: { provider: "kimi-coding", id: "kimi-k3", name: "Kimi K3" },
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        messages: structuredClone(initialMessages),
        stats: { contextUsage: { tokens: 12_640, contextWindow: 131_072, percent: 9.64 } },
        availableModels: [
          { provider: "kimi-coding", id: "kimi-k3", contextWindow: 131_072, reasoning: true },
          { provider: "anthropic", id: "claude-sonnet-4", contextWindow: 200_000, reasoning: true },
        ],
        commands: [
          { name: "compact", description: "Compact the current context", source: "extension" },
          { name: "skill:docdoki", description: "Maintain project design documents", source: "skill" },
        ],
      },
      runState: "idle",
    };
    return this.state;
  }

  async openSession(id: string): Promise<ActiveSnapshot> {
    return this.activate(id, summaries.find((item) => item.id === id)?.cwd ?? "/home/demo/research");
  }

  async newSession(cwdInput: string, name?: string): Promise<ActiveSnapshot> {
    const snapshot = this.activate("mock-new", cwdInput);
    if (snapshot.active) {
      snapshot.active.sessionName = name || "New session";
      snapshot.active.messages = [];
    }
    return snapshot;
  }

  async prompt(request: PromptRequest): Promise<void> {
    if (!this.state.active) throw new Error("Open a mock session first");
    if (this.state.active.isStreaming) throw new Error("Mock session is already streaming");
    const timestamp = Date.now();
    const user = { role: "user", content: request.message, timestamp };
    this.state.active.messages.push(user);
    this.state.active.isStreaming = true;
    this.state.runState = "running";
    this.emit("event", { type: "message_start", message: user });
    this.emit("event", { type: "agent_start" });

    const answer = `You asked: **${request.message || "about the attached material"}**.\n\nThe live mock stream confirms inline math $a^2+b^2=c^2$ and display math:\n\n$$\\int_0^1 x^2\\,dx=\\frac13$$`;
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      provider: "kimi-coding",
      model: "kimi-k3",
      stopReason: "stop",
      timestamp: timestamp + 1,
    };
    this.state.active.messages.push(assistant);
    this.emit("event", { type: "message_start", message: assistant });
    const chunks = answer.match(/.{1,14}/gs) ?? [answer];
    let index = 0;
    this.timer = setInterval(() => {
      if (!this.state.active) return;
      const chunk = chunks[index++];
      if (chunk !== undefined) {
        (assistant.content[0] as { text: string }).text += chunk;
        this.emit("event", {
          type: "message_update",
          message: structuredClone(assistant),
          assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk, partial: structuredClone(assistant) },
        });
        return;
      }
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.state.active.isStreaming = false;
      this.state.runState = "idle";
      this.emit("event", { type: "message_end", message: structuredClone(assistant) });
      this.emit("event", { type: "agent_settled" });
    }, 18);
  }

  async abort(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.state.active) this.state.active.isStreaming = false;
    this.state.runState = "aborted";
    this.emit("event", { type: "agent_settled" });
  }

  async compact(): Promise<unknown> {
    this.state.runState = "compacting";
    this.emit("event", { type: "compaction_start", reason: "manual" });
    this.state.runState = "idle";
    this.emit("event", { type: "compaction_end", reason: "manual", result: { tokensBefore: 12_640 } });
    return { tokensBefore: 12_640, estimatedTokensAfter: 4_200 };
  }

  async rename(name: string): Promise<void> {
    if (this.state.active) this.state.active.sessionName = name;
  }
  async setModel(provider: string, modelId: string): Promise<unknown> {
    if (this.state.active) this.state.active.model = { provider, id: modelId };
    return this.state.active?.model;
  }
  async setThinkingLevel(level: string): Promise<void> {
    if (this.state.active) this.state.active.thinkingLevel = level;
  }
  async extensionUiResponse(): Promise<void> {}
  async snapshot(): Promise<ActiveSnapshot> {
    return structuredClone(this.state);
  }
  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
  }
}
