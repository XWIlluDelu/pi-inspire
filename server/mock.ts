import { EventEmitter } from "node:events";
import { resolve } from "node:path";
import { parseCompactCommand } from "../shared/commands.js";
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
  ModelOption,
  NewSessionOptions,
  PromptRequest,
  SessionDeleteResponse,
  SessionListResponse,
  SessionSummary,
  TranscriptPage,
} from "../shared/contracts.js";
import type { GitInspectionLike } from "./git-inspection.js";
import type { ResourceContext } from "./resources.js";
import type { RuntimeLike } from "./runtime.js";
import type { SessionCatalogLike, SessionRecord } from "./session-catalog.js";

const now = Date.now();
// Browser acceptance runs point this at the checkout so resource and project
// picker fixtures exercise the normal server paths without test-only routes.
const mockWorkspace = resolve(
  process.env.INSPIRE_MOCK_WORKSPACE ?? "/home/demo/research",
);
const mockHistoryWorkspace = process.env.INSPIRE_MOCK_WORKSPACE
  ? mockWorkspace
  : "/home/demo/pi-extension";
const RESOURCE_FIXTURE_SESSION_ID = "mock-resources";
const BRANCH_FIXTURE_SESSION_ID = "mock-branch";
const BRANCH_EARLIER_LEAF_ID = "mock-branch-earlier";
const BRANCH_LATEST_LEAF_ID = "mock-branch-latest";

const baseSummaries: SessionSummary[] = [
  {
    id: "mock-active",
    cwd: mockWorkspace,
    project: "research",
    title: "Formula rendering and spectral analysis",
    created: new Date(now - 86_400_000).toISOString(),
    modified: new Date(now - 90_000).toISOString(),
    messageCount: 5,
  },
  {
    id: "mock-history",
    cwd: mockHistoryWorkspace,
    project: "pi-extension",
    title: "Review extension event lifecycle",
    created: new Date(now - 604_800_000).toISOString(),
    modified: new Date(now - 172_800_000).toISOString(),
    messageCount: 12,
  },
];

const browserFixtureSummaries: SessionSummary[] = [
  {
    id: RESOURCE_FIXTURE_SESSION_ID,
    cwd: mockWorkspace,
    project: "browser fixtures",
    title: "Resource virtualization and sandbox fixture",
    created: new Date(now - 3_600_000).toISOString(),
    modified: new Date(now - 45_000).toISOString(),
    messageCount: 1,
  },
  {
    id: BRANCH_FIXTURE_SESSION_ID,
    cwd: mockWorkspace,
    project: "browser fixtures",
    title: "Earlier branch recovery fixture",
    created: new Date(now - 7_200_000).toISOString(),
    modified: new Date(now - 30_000).toISOString(),
    messageCount: 3,
  },
];

const summaries = [
  ...baseSummaries,
  ...(process.env.INSPIRE_MOCK_WORKSPACE ? browserFixtureSummaries : []),
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

export const MOCK_AVAILABLE_MODELS: ModelOption[] = [
  { provider: "kimi-coding", id: "kimi-k3", name: "Kimi K3", reasoning: true },
  {
    provider: "anthropic",
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    reasoning: true,
  },
];

const initialMessages = [
  {
    role: "user",
    content: "Show me a formula-rich example and inspect the analysis steps.",
    timestamp: now - 30_000,
  },
  {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking:
          "I should keep the derivation compact and make every result inspectable.",
      },
      {
        type: "toolCall",
        id: "mock-tool-1",
        name: "read",
        arguments: { path: "analysis/spectrum.py" },
      },
      { type: "text", text: richText },
    ],
    provider: "kimi-coding",
    model: "kimi-k3",
    usage: {
      input: 800,
      output: 420,
      cacheRead: 320,
      cacheWrite: 0,
      totalTokens: 1_540,
      cost: { total: 0 },
    },
    stopReason: "stop",
    timestamp: now - 28_000,
  },
  {
    role: "toolResult",
    toolCallId: "mock-tool-1",
    toolName: "read",
    content: [
      { type: "text", text: "Read 84 lines from analysis/spectrum.py" },
    ],
    isError: false,
    timestamp: now - 29_000,
  },
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "mock-tool-2",
        name: "edit",
        arguments: { path: "analysis/spectrum.py" },
      },
      { type: "text", text: "Tightened the window normalization." },
    ],
    provider: "kimi-coding",
    model: "kimi-k3",
    usage: {
      input: 900,
      output: 160,
      cacheRead: 620,
      cacheWrite: 0,
      totalTokens: 1_680,
      cost: { total: 0 },
    },
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

const resourceFixtureReferences = [
  ...Array.from(
    { length: 72 },
    (_value, index) =>
      `tests/browser/fixtures/unavailable-resource-${String(index + 1).padStart(3, "0")}.txt`,
  ),
  "tests/browser/fixtures/sandbox-resource.html",
];

/** A large, deterministic citation set exercises the same list/probe/preview
 * routes as a real session without turning ordinary mock conversations into
 * an oversized transcript. The final HTML reference is recent-first. */
const resourceFixtureMessages = [
  {
    role: "assistant",
    content: resourceFixtureReferences.map((path, index) => ({
      type: "toolCall",
      id: `mock-resource-${index + 1}`,
      name: "read",
      arguments: { path },
    })),
    provider: "kimi-coding",
    model: "kimi-k3",
    stopReason: "stop",
    timestamp: now - 40_000,
  },
];

function messagesForFixture(id: string): unknown[] {
  return id === RESOURCE_FIXTURE_SESSION_ID
    ? resourceFixtureMessages
    : initialMessages;
}

const mockGitPath = {
  id: Buffer.from("analysis/spectrum.py").toString("base64url"),
  display: "analysis/spectrum.py",
  utf8Path: "analysis/spectrum.py",
  workspacePath: "analysis/spectrum.py",
};

export class MockGitInspection implements GitInspectionLike {
  async status(): Promise<GitStatusResponse> {
    return {
      kind: "repository",
      head: {
        kind: "branch",
        name: "mock/analysis",
        oid: "0123456789abcdef0123456789abcdef01234567",
      },
      files: [
        { path: mockGitPath, unstaged: { kind: "modified" }, untracked: false },
      ],
      total: 1,
      truncated: false,
      groups: {
        conflicted: [],
        staged: [],
        unstaged: [mockGitPath.id],
        untracked: [],
      },
    };
  }

  async diff(
    _cwd: string,
    pathId: string,
    side: GitDiffSide,
  ): Promise<GitDiffResponse> {
    if (pathId !== mockGitPath.id || side !== "unstaged") {
      throw Object.assign(
        new Error("That path and diff side are not present in fresh status"),
        { status: 409 },
      );
    }
    return {
      kind: "text",
      path: mockGitPath,
      side,
      truncated: false,
      encodingLossy: false,
      lines: [
        {
          kind: "meta",
          text: "--- a/analysis/spectrum.py",
          oldLine: null,
          newLine: null,
        },
        {
          kind: "meta",
          text: "+++ b/analysis/spectrum.py",
          oldLine: null,
          newLine: null,
        },
        { kind: "hunk", text: "@@ -12 +12 @@", oldLine: null, newLine: null },
        {
          kind: "delete",
          text: "-scale = 1.0 / len(samples)",
          oldLine: 12,
          newLine: null,
        },
        {
          kind: "add",
          text: "+scale = 1.0 / max(1, len(samples))",
          oldLine: null,
          newLine: 12,
        },
      ],
    };
  }
}

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
      name: undefined,
      created: new Date(summary.created),
      modified: new Date(summary.modified),
      messageCount: summary.messageCount,
      firstMessage: summary.title,
      searchText: `${summary.title}\n${summary.cwd}`.toLowerCase(),
    };
  }
  async getUnique(id: string): Promise<SessionRecord | undefined> {
    return this.get(id);
  }
  async list(
    options: { query?: string; offset?: number; limit?: number } = {},
  ): Promise<SessionListResponse> {
    const query = options.query?.trim().toLowerCase().slice(0, 200) ?? "";
    const matches = summaries.filter((item) =>
      `${item.title} ${item.project}`.toLowerCase().includes(query),
    );
    const offset = Math.max(
      0,
      Number.isFinite(options.offset) ? Math.floor(options.offset!) : 0,
    );
    const limit = Math.min(
      100,
      Math.max(
        1,
        Number.isFinite(options.limit) ? Math.floor(options.limit!) : 40,
      ),
    );
    return {
      sessions: matches.slice(offset, offset + limit),
      total: matches.length,
      offset,
      limit,
    };
  }
  async listByIds(ids: readonly string[]): Promise<SessionSummary[]> {
    const requested = new Set(ids);
    return summaries.filter((session) => requested.has(session.id));
  }
  async listByCwds(cwds: readonly string[]): Promise<SessionSummary[]> {
    const requested = new Set(cwds);
    return summaries.filter((session) => requested.has(session.cwd));
  }
  invalidate(): void {}
}

export class MockRuntime extends EventEmitter implements RuntimeLike {
  private readonly streamIntervalMs: number;
  private state: ActiveSnapshot = {
    active: null,
    runState: "idle",
    sessionStatuses: {},
  };
  private readonly sessions = new Map<
    string,
    NonNullable<ActiveSnapshot["active"]>
  >();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private nextSession = 0;

  constructor({ streamIntervalMs = 18 }: { streamIntervalMs?: number } = {}) {
    super();
    this.streamIntervalMs = streamIntervalMs;
  }

  get activeSessionId(): string | null {
    return this.state.active?.sessionId ?? null;
  }

  sessionCwd(sessionId: string): string | null {
    return this.sessions.get(sessionId)?.cwd ?? null;
  }

  private requireSession(
    sessionId: string,
  ): NonNullable<ActiveSnapshot["active"]> {
    const session = this.sessions.get(sessionId);
    if (!session)
      throw Object.assign(new Error("That session is not open on this host"), {
        status: 409,
      });
    return session;
  }

  private activate(id = "mock-active", cwd = mockWorkspace): ActiveSnapshot {
    const summary = summaries.find((item) => item.id === id);
    let active = this.sessions.get(id);
    if (!active) {
      active = {
        sessionId: id,
        sessionFile: `/mock/${id}.jsonl`,
        // Catalog titles model first-prompt presentation; they are not an
        // explicit Pi session name.
        sessionName: undefined,
        cwd,
        model: { provider: "kimi-coding", id: "kimi-k3", name: "Kimi K3" },
        thinkingLevel: "medium",
        isStreaming: false,
        isCompacting: false,
        messages: summary ? structuredClone(messagesForFixture(id)) : [],
        transcriptPage: {
          sessionId: id,
          revision: id === BRANCH_FIXTURE_SESSION_ID ? 7 : 1,
          viewId: `mock-view-${id}`,
          ...(id === BRANCH_FIXTURE_SESSION_ID
            ? { effectiveLeafId: BRANCH_EARLIER_LEAF_ID }
            : {}),
          messages: summary ? structuredClone(messagesForFixture(id)) : [],
          hasOlder: false,
          olderCursor: null,
        },
        ...(id === BRANCH_FIXTURE_SESSION_ID
          ? {
              durableLeafId: BRANCH_LATEST_LEAF_ID,
              effectiveLeafId: BRANCH_EARLIER_LEAF_ID,
              navigationLeased: true,
            }
          : {}),
        projectionHealth: { status: "ok" },
        projectionConflict: null,
        stats: {
          contextUsage: {
            tokens: 12_640,
            contextWindow: 131_072,
            percent: 9.64,
          },
        },
        availableModels: structuredClone(MOCK_AVAILABLE_MODELS),
        commands: [
          {
            name: "compact",
            description: "Compact the current context",
            source: "extension",
          },
          {
            name: "skill:docdoki",
            description: "Maintain project design documents",
            source: "skill",
          },
        ],
      };
      this.sessions.set(id, active);
    }
    if (!active) throw new Error("Mock session activation failed");

    const currentStatus = this.state.sessionStatuses[id] ?? {
      runState: "idle" as const,
    };
    const viewedStatus =
      currentStatus.indicator === "running"
        ? currentStatus
        : { runState: currentStatus.runState };
    this.state.active = active;
    this.state.runState = viewedStatus.runState;
    this.state.sessionStatuses[id] = viewedStatus;
    return this.state;
  }

  async openSession(id: string): Promise<ActiveSnapshot> {
    return this.activate(
      id,
      summaries.find((item) => item.id === id)?.cwd ?? mockWorkspace,
    );
  }

  async newSession(
    cwdInput: string,
    options: NewSessionOptions = {},
  ): Promise<ActiveSnapshot> {
    const id = `mock-new-${++this.nextSession}`;
    const snapshot = this.activate(id, cwdInput);
    if (snapshot.active) {
      snapshot.active.sessionName = options.name?.trim() || undefined;
      const selected = options.model
        ? MOCK_AVAILABLE_MODELS.find(
            (model) =>
              model.provider === options.model?.provider &&
              model.id === options.model.id,
          )
        : undefined;
      if (selected) snapshot.active.model = structuredClone(selected);
      if (options.thinkingLevel)
        snapshot.active.thinkingLevel = options.thinkingLevel;
    }
    return snapshot;
  }

  async deselectSession(): Promise<ActiveSnapshot> {
    this.state.active = null;
    this.state.runState = "idle";
    return this.state;
  }

  async deleteSession(sessionId: string): Promise<SessionDeleteResponse> {
    if (this.activeSessionId === sessionId) {
      throw Object.assign(
        new Error("Switch to another session before deleting this one"),
        { status: 409 },
      );
    }
    const status = this.state.sessionStatuses[sessionId];
    if (
      status &&
      ["running", "retrying", "compacting", "queued", "conflict"].includes(
        status.runState,
      )
    ) {
      throw Object.assign(
        new Error(
          "Wait for the session's active work to finish before deleting it",
        ),
        { status: 409 },
      );
    }
    const index = summaries.findIndex((session) => session.id === sessionId);
    if (index < 0)
      throw Object.assign(new Error("Session not found"), { status: 404 });
    summaries.splice(index, 1);
    this.sessions.delete(sessionId);
    delete this.state.sessionStatuses[sessionId];
    return { sessionId, disposition: "trashed" };
  }

  async deleteHiddenFolderSessions(
    cwd: string,
    expectedSessionIds: readonly string[],
  ) {
    const targets = summaries.filter((session) => session.cwd === cwd);
    if (targets.length === 0)
      throw Object.assign(new Error("No sessions remain in this folder"), {
        status: 404,
      });
    const expected = new Set(expectedSessionIds);
    if (
      expected.size !== expectedSessionIds.length ||
      targets.length !== expected.size ||
      targets.some((session) => !expected.has(session.id))
    ) {
      throw Object.assign(
        new Error("The folder's sessions changed; review it before deleting"),
        { status: 409 },
      );
    }
    if (targets.some((session) => session.id === this.activeSessionId)) {
      throw Object.assign(
        new Error("Switch to another session before deleting this folder"),
        { status: 409 },
      );
    }
    const deleted: Array<{
      sessionId: string;
      disposition: "trashed" | "deleted";
    }> = [];
    for (const target of targets) {
      try {
        const result = await this.deleteSession(target.id);
        deleted.push(result);
      } catch (error) {
        return {
          cwd,
          deleted,
          failure: {
            sessionId: target.id,
            message:
              error instanceof Error
                ? error.message
                : "Failed to delete session",
          },
        };
      }
    }
    return { cwd, deleted };
  }

  private emitSession(id: string, event: Record<string, unknown>): void {
    this.emit("event", {
      ...event,
      sessionId: id,
      sessionStatus: this.state.sessionStatuses[id],
    });
  }

  async prompt(request: PromptRequest): Promise<void> {
    const active = this.requireSession(request.sessionId);
    // Same prompt boundary as the real host: a bare /compact compacts.
    if (
      parseCompactCommand(request.message) &&
      !request.attachmentIds?.length &&
      !request.projectFiles?.length
    ) {
      await this.compact(request.sessionId);
      return;
    }
    if (active.isStreaming)
      throw new Error("Mock session is already streaming");
    const sessionId = active.sessionId;
    const timestamp = Date.now();
    const user = { role: "user", content: request.message, timestamp };
    active.messages.push(user);
    active.isStreaming = true;
    if (this.state.active?.sessionId === sessionId)
      this.state.runState = "running";
    this.state.sessionStatuses[sessionId] = {
      runState: "running",
      indicator: "running",
    };
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
          assistantMessageEvent: {
            type: "text_delta",
            contentIndex: 0,
            delta: chunk,
            partial: structuredClone(assistant),
          },
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
      this.emitSession(sessionId, {
        type: "message_end",
        message: structuredClone(assistant),
      });
      this.emitSession(sessionId, { type: "agent_settled" });
    }, this.streamIntervalMs);
    this.timers.set(sessionId, timer);
  }

  async abort(sessionId: string): Promise<void> {
    const active = this.requireSession(sessionId);
    const timer = this.timers.get(active.sessionId);
    if (timer) clearInterval(timer);
    this.timers.delete(active.sessionId);
    active.isStreaming = false;
    this.state.sessionStatuses[active.sessionId] = { runState: "aborted" };
    if (this.state.active?.sessionId === active.sessionId)
      this.state.runState = "aborted";
    this.emitSession(active.sessionId, { type: "agent_settled" });
  }

  async compact(
    sessionId = this.state.active?.sessionId ?? "",
  ): Promise<unknown> {
    this.requireSession(sessionId);
    const selected = this.state.active?.sessionId === sessionId;
    if (selected) this.state.runState = "compacting";
    this.state.sessionStatuses[sessionId] = {
      runState: "compacting",
      indicator: "running",
    };
    this.emitSession(sessionId, { type: "compaction_start", reason: "manual" });
    if (selected) this.state.runState = "idle";
    this.state.sessionStatuses[sessionId] = { runState: "idle" };
    this.emitSession(sessionId, {
      type: "compaction_end",
      reason: "manual",
      result: { tokensBefore: 12_640 },
    });
    return { tokensBefore: 12_640, estimatedTokensAfter: 4_200 };
  }

  async rename(sessionId: string, name: string): Promise<void> {
    this.requireSession(sessionId).sessionName = name;
  }
  async setModel(
    sessionId: string,
    provider: string,
    modelId: string,
  ): Promise<unknown> {
    const session = this.requireSession(sessionId);
    session.model = { provider, id: modelId };
    return session.model;
  }
  async setThinkingLevel(sessionId: string, level: string): Promise<void> {
    this.requireSession(sessionId).thinkingLevel = level;
  }
  async extensionUiResponse(): Promise<void> {}
  async snapshot(): Promise<ActiveSnapshot> {
    if (this.state.active) {
      this.state.active.transcriptPage.messages = this.state.active.messages;
    }
    return structuredClone(this.state);
  }
  async transcriptPage(
    sessionId: string,
    _cursor: string,
  ): Promise<TranscriptPage> {
    const active = this.requireSession(sessionId);
    return {
      sessionId,
      revision: active.transcriptPage.revision,
      viewId: active.transcriptPage.viewId,
      messages: [],
      hasOlder: false,
      olderCursor: null,
    };
  }
  async branchTree(sessionId: string): Promise<BranchTreeResponse> {
    const active = this.requireSession(sessionId);
    if (sessionId !== BRANCH_FIXTURE_SESSION_ID) {
      return {
        sessionId,
        revision: active.transcriptPage.revision,
        incarnation: "mock",
        durableLeafId: null,
        effectiveLeafId: null,
        activePath: [],
        nodes: [],
        truncated: false,
        health: { status: "ok" },
      };
    }
    const durableLeafId = active.durableLeafId ?? BRANCH_LATEST_LEAF_ID;
    const effectiveLeafId = active.effectiveLeafId ?? BRANCH_EARLIER_LEAF_ID;
    const viewingEarlier = effectiveLeafId !== durableLeafId;
    return {
      sessionId,
      revision: active.transcriptPage.revision,
      incarnation: "mock-branch",
      durableLeafId,
      effectiveLeafId,
      activePath: viewingEarlier
        ? [BRANCH_EARLIER_LEAF_ID]
        : [BRANCH_EARLIER_LEAF_ID, BRANCH_LATEST_LEAF_ID],
      nodes: [
        {
          id: BRANCH_EARLIER_LEAF_ID,
          parentId: null,
          depth: 0,
          type: "message",
          role: "user",
          label: "Earlier request",
          snippet: "Inspect the earlier branch",
          timestamp: new Date(now - 60_000).toISOString(),
          active: viewingEarlier,
          leaf: viewingEarlier,
          canSwitch: !viewingEarlier,
          canEdit: true,
          canFork: true,
        },
        {
          id: BRANCH_LATEST_LEAF_ID,
          parentId: BRANCH_EARLIER_LEAF_ID,
          depth: 1,
          type: "message",
          role: "assistant",
          label: "Latest response",
          snippet: "Continue from the durable leaf",
          timestamp: new Date(now - 30_000).toISOString(),
          active: !viewingEarlier,
          leaf: !viewingEarlier,
          canSwitch: viewingEarlier,
          canEdit: false,
          canFork: false,
        },
      ],
      truncated: false,
      health: { status: "ok" },
    };
  }
  async navigateBranch(
    request: BranchNavigateRequest,
  ): Promise<BranchNavigateResponse> {
    const active = this.requireSession(request.sessionId);
    if (
      request.sessionId !== BRANCH_FIXTURE_SESSION_ID ||
      request.mode !== "switch" ||
      request.targetId !== BRANCH_LATEST_LEAF_ID ||
      request.revision !== active.transcriptPage.revision
    ) {
      throw Object.assign(new Error("Mock branch target is unavailable"), {
        status: 409,
      });
    }
    active.effectiveLeafId = BRANCH_LATEST_LEAF_ID;
    active.navigationLeased = false;
    active.transcriptPage = {
      ...active.transcriptPage,
      revision: active.transcriptPage.revision + 1,
      viewId: `mock-view-${active.sessionId}-latest`,
      effectiveLeafId: BRANCH_LATEST_LEAF_ID,
    };
    return { snapshot: await this.snapshot() };
  }
  async forkBranch(request: BranchForkRequest): Promise<BranchForkResponse> {
    const source = this.requireSession(request.sessionId);
    if (
      request.sessionId !== BRANCH_FIXTURE_SESSION_ID ||
      request.targetId !== BRANCH_EARLIER_LEAF_ID ||
      request.revision !== source.transcriptPage.revision
    ) {
      throw Object.assign(new Error("Mock branch target is unavailable"), {
        status: 409,
      });
    }
    const sessionId = `mock-branch-fork-${++this.nextSession}`;
    const destination = structuredClone(source);
    destination.sessionId = sessionId;
    destination.sessionFile = `/mock/${sessionId}.jsonl`;
    destination.sessionName = "Fork of earlier branch";
    destination.durableLeafId = BRANCH_EARLIER_LEAF_ID;
    destination.effectiveLeafId = BRANCH_EARLIER_LEAF_ID;
    destination.navigationLeased = false;
    destination.transcriptPage = {
      ...destination.transcriptPage,
      sessionId,
      revision: 1,
      viewId: `mock-view-${sessionId}`,
      effectiveLeafId: BRANCH_EARLIER_LEAF_ID,
    };
    this.sessions.set(sessionId, destination);
    this.state.active = destination;
    this.state.runState = "idle";
    this.state.sessionStatuses[sessionId] = { runState: "idle" };
    summaries.push({
      id: sessionId,
      cwd: destination.cwd,
      project: "browser fixtures",
      title: "Fork of earlier branch",
      created: new Date().toISOString(),
      modified: new Date().toISOString(),
      messageCount: destination.messages.length,
    });
    return { sessionId, snapshot: await this.snapshot(), editorText: "" };
  }
  async resourceContext(sessionId: string): Promise<ResourceContext> {
    const active = this.state.active;
    if (!active || active.sessionId !== sessionId) {
      throw Object.assign(
        new Error("The resource does not belong to the visible session"),
        { status: 409 },
      );
    }
    return {
      sessionId,
      viewId: active.transcriptPage.viewId,
      revision: active.transcriptPage.revision,
      cwd: active.cwd,
      messages: active.messages,
    };
  }
  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
