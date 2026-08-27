import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseCompactCommand } from "../shared/commands.js";
import type {
  ActiveSnapshot,
  BranchForkRequest,
  BranchForkResponse,
  BranchNavigateRequest,
  BranchNavigateResponse,
  BranchTreeResponse,
  ComposerHistoryEntry,
  ComposerHistoryPage,
  GitDiffLine,
  GitDiffResponse,
  GitDiffSide,
  GitStatusResponse,
  ModelOption,
  NewSessionOptions,
  PendingQueues,
  PromptRequest,
  SessionDeleteResponse,
  SessionListResponse,
  SessionSummary,
  TranscriptActivityPage,
  TranscriptPage,
  UserTurnIndexPage,
  UserTurnTranscriptPage,
} from "../shared/contracts.js";
import { emptyPendingQueues } from "../shared/contracts.js";
import { projectComposerHistoryPage } from "./composer-history.js";
import type { GitInspectionLike } from "./git-inspection.js";
import type { ResourceContext } from "./resources.js";
import type { PendingManagementRequest, RuntimeLike } from "./runtime.js";
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
const PROMPT_MAP_FIXTURE_SESSION_ID = "mock-prompt-map";
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
    id: PROMPT_MAP_FIXTURE_SESSION_ID,
    cwd: mockWorkspace,
    project: "browser fixtures",
    title: "Prompt map long-session fixture",
    created: new Date(now - 10_800_000).toISOString(),
    modified: new Date(now - 20_000).toISOString(),
    messageCount: 26,
  },
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
        arguments: { path: "analysis/spectrum.py", offset: 8, limit: 12 },
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
      {
        type: "text",
        text: [
          "def window(samples):",
          "    total = samples.sum()",
          "    scale = 1.0 / len(samples)",
          "    return total * scale",
          "",
          "frequencies = np.fft.rfftfreq(signal.size, d=1 / sample_rate)",
          "power = np.abs(np.fft.rfft(signal)) ** 2",
        ].join("\n"),
      },
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
        arguments: {
          path: "analysis/spectrum.py",
          edits: [
            {
              oldText: "    scale = 1.0 / len(samples)",
              newText: "    scale = 1.0 / max(1, len(samples))",
            },
          ],
        },
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
    details: {
      patch: [
        "--- a/analysis/spectrum.py",
        "+++ b/analysis/spectrum.py",
        "@@ -12,7 +12,7 @@ def window(samples):",
        "     total = samples.sum()",
        "-    scale = 1.0 / len(samples)",
        "+    scale = 1.0 / max(1, len(samples))",
        "     return total * scale",
      ].join("\n"),
      firstChangedLine: 14,
    },
    isError: false,
    timestamp: now - 25_000,
  },
];

const promptMapFixtureMessages = Array.from({ length: 13 }, (_, index) => {
  const timestamp = now - (13 - index) * 2_000;
  return [
    {
      role: "user",
      content: `Prompt map fixture turn ${index + 1}`,
      timestamp,
    },
    {
      role: "assistant",
      content: `Prompt map fixture response ${index + 1}.`,
      provider: "kimi-coding",
      model: "kimi-k3",
      stopReason: "stop",
      timestamp: timestamp + 1,
    },
  ];
}).flat();

const resourceFixtureReferences = [
  ...Array.from(
    { length: 72 },
    (_value, index) =>
      `tests/browser/fixtures/unavailable-resource-${String(index + 1).padStart(3, "0")}.txt`,
  ),
  "tests/browser/fixtures/file-previews/page.html",
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
  if (id === RESOURCE_FIXTURE_SESSION_ID) return resourceFixtureMessages;
  if (id === PROMPT_MAP_FIXTURE_SESSION_ID) return promptMapFixtureMessages;
  return initialMessages;
}

const mockGitWorkspacePath = "tests/browser/fixtures/file-previews/page.html";
const mockGitPath = {
  id: Buffer.from(mockGitWorkspacePath).toString("base64url"),
  display: mockGitWorkspacePath,
  utf8Path: mockGitWorkspacePath,
  workspacePath: mockGitWorkspacePath,
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
    const source = await readFile(
      resolve(mockWorkspace, mockGitWorkspacePath),
      "utf8",
    );
    const sourceLines = source.split("\n");
    const changedLine = sourceLines.findIndex((line) =>
      line.includes("Quiet systems, legible signals."),
    );
    const lines = sourceLines.flatMap<GitDiffLine>((line, index) => {
      const lineNumber = index + 1;
      if (index !== changedLine)
        return [
          {
            kind: "context" as const,
            text: ` ${line}`,
            oldLine: lineNumber,
            newLine: lineNumber,
          },
        ];
      return [
        {
          kind: "delete" as const,
          text: "-<h1>Quiet systems, readable signals.</h1>",
          oldLine: lineNumber,
          newLine: null,
        },
        {
          kind: "add" as const,
          text: `+${line}`,
          oldLine: null,
          newLine: lineNumber,
        },
      ];
    });
    return {
      kind: "text",
      path: mockGitPath,
      side,
      additions: 1,
      deletions: 1,
      truncated: false,
      encodingLossy: false,
      lines: [
        {
          kind: "meta",
          text: `--- a/${mockGitWorkspacePath}`,
          oldLine: null,
          newLine: null,
        },
        {
          kind: "meta",
          text: `+++ b/${mockGitWorkspacePath}`,
          oldLine: null,
          newLine: null,
        },
        {
          kind: "hunk",
          text: `@@ -1,${sourceLines.length} +1,${sourceLines.length} @@`,
          oldLine: null,
          newLine: null,
        },
        ...lines,
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
      source: null,
    };
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
  private readonly pendingBySession = new Map<string, PendingQueues>();
  private readonly pendingText = new Map<string, string>();
  private nextSession = 0;
  private nextPending = 0;

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

  private pendingFor(sessionId: string): PendingQueues {
    let pending = this.pendingBySession.get(sessionId);
    if (!pending) {
      pending = { ...emptyPendingQueues(), managementAvailable: true };
      this.pendingBySession.set(sessionId, pending);
    }
    return pending;
  }

  private publishPending(sessionId: string): PendingQueues {
    const pending = this.pendingFor(sessionId);
    if (this.state.active?.sessionId === sessionId) {
      this.state.pendingQueues = structuredClone(pending);
    }
    this.emitSession(sessionId, {
      type: "queue_update",
      steering: pending.steering.map((entry) => entry.textPreview),
      followUp: pending.followUp.map((entry) => entry.textPreview),
      pendingQueues: structuredClone(pending),
    });
    return structuredClone(pending);
  }

  private queuePrompt(request: PromptRequest, kind: "steer" | "followUp") {
    const pending = this.pendingFor(request.sessionId);
    const id = `mock-pending-${++this.nextPending}`;
    const text = request.message;
    this.pendingText.set(id, text);
    const entry = {
      id,
      textPreview: text.slice(0, 512),
      textLength: text.length,
      textTruncated: text.length > 512,
      imageCount: 0,
      nonTextContentCount: 0,
    };
    (kind === "steer" ? pending.steering : pending.followUp).push(entry);
    pending.revision += 1;
    this.publishPending(request.sessionId);
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
      const fixtureMessages = summary
        ? structuredClone(messagesForFixture(id))
        : [];
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
        transcriptPage: {
          sessionId: id,
          revision: id === BRANCH_FIXTURE_SESSION_ID ? 7 : 1,
          viewId: `mock-view-${id}`,
          ...(id === BRANCH_FIXTURE_SESSION_ID
            ? { effectiveLeafId: BRANCH_EARLIER_LEAF_ID }
            : {}),
          messages: fixtureMessages,
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
    this.state.pendingQueues = structuredClone(this.pendingFor(id));
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
    this.state.pendingQueues = emptyPendingQueues();
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
    const pending = this.pendingBySession.get(sessionId);
    if (
      (status &&
        ["running", "retrying", "compacting", "queued", "conflict"].includes(
          status.runState,
        )) ||
      pending?.paused ||
      (pending?.steering.length ?? 0) > 0 ||
      (pending?.followUp.length ?? 0) > 0
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
    if (pending) {
      for (const entry of [...pending.steering, ...pending.followUp]) {
        this.pendingText.delete(entry.id);
      }
      this.pendingBySession.delete(sessionId);
    }
    delete this.state.sessionStatuses[sessionId];
    return { sessionId, disposition: "trashed" };
  }

  async clearHiddenSessions(
    expectedSessionIds: readonly string[],
    hiddenSessionIds: readonly string[],
    hiddenProjectCwds: readonly string[],
  ) {
    const individualIds = new Set(hiddenSessionIds);
    const projectCwds = new Set(hiddenProjectCwds);
    const targets = summaries.filter(
      (session) =>
        individualIds.has(session.id) || projectCwds.has(session.cwd),
    );
    if (targets.length === 0)
      throw Object.assign(new Error("No sessions remain in Hidden"), {
        status: 404,
      });
    const expected = new Set(expectedSessionIds);
    if (
      expected.size !== expectedSessionIds.length ||
      targets.length !== expected.size ||
      targets.some((session) => !expected.has(session.id))
    ) {
      throw Object.assign(
        new Error("Hidden changed; review it before clearing"),
        { status: 409 },
      );
    }
    if (targets.some((session) => session.id === this.activeSessionId)) {
      throw Object.assign(
        new Error("Switch to another session before clearing Hidden"),
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
    return { deleted };
  }

  private emitSession(id: string, event: Record<string, unknown>): void {
    this.emit("event", {
      ...event,
      sessionId: id,
      sessionStatus: this.state.sessionStatuses[id],
    });
  }

  async prompt(request: PromptRequest): Promise<ComposerHistoryEntry | null> {
    const active = this.requireSession(request.sessionId);
    // Same prompt boundary as the real host: a bare /compact compacts.
    if (
      parseCompactCommand(request.message) &&
      !request.attachmentIds?.length &&
      !request.historyArtifacts &&
      !request.projectFiles?.length
    ) {
      await this.compact(request.sessionId);
      return null;
    }
    const pending = this.pendingFor(request.sessionId);
    if (active.isStreaming || pending.paused) {
      if (active.isStreaming && !request.behavior) {
        throw new Error("Mock session is already streaming");
      }
      this.queuePrompt(
        request,
        request.behavior === "steer" ? "steer" : "followUp",
      );
      return null;
    }
    const sessionId = active.sessionId;
    const timestamp = Date.now();
    const user = { role: "user", content: request.message, timestamp };
    active.transcriptPage.messages.push(user);
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
    active.transcriptPage.messages.push(assistant);
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
      const pending = this.pendingFor(sessionId);
      if (
        !pending.paused &&
        (pending.steering.length > 0 || pending.followUp.length > 0)
      ) {
        for (const entry of [...pending.steering, ...pending.followUp]) {
          this.pendingText.delete(entry.id);
        }
        pending.steering = [];
        pending.followUp = [];
        pending.revision += 1;
        this.publishPending(sessionId);
      }
      this.emitSession(sessionId, { type: "agent_settled" });
    }, this.streamIntervalMs);
    this.timers.set(sessionId, timer);
    const text = request.message.trim();
    return text ? { text, images: [], files: [] } : null;
  }

  async managePending(
    sessionId: string,
    request: PendingManagementRequest,
  ): Promise<PendingQueues> {
    const active = this.requireSession(sessionId);
    const pending = this.pendingFor(sessionId);
    if (request.expectedRevision !== pending.revision) {
      throw Object.assign(new Error("Pending messages changed; retry"), {
        status: 409,
      });
    }
    const requirePaused = () => {
      if (!pending.paused) {
        throw Object.assign(
          new Error("Pause Pending input before modifying it"),
          { status: 409 },
        );
      }
    };
    const remove = (id: string) => {
      const steeringIndex = pending.steering.findIndex(
        (item) => item.id === id,
      );
      if (steeringIndex >= 0)
        return pending.steering.splice(steeringIndex, 1)[0];
      const followUpIndex = pending.followUp.findIndex(
        (item) => item.id === id,
      );
      if (followUpIndex >= 0)
        return pending.followUp.splice(followUpIndex, 1)[0];
      return undefined;
    };

    switch (request.action) {
      case "pause":
        if (!pending.paused) {
          pending.paused = true;
          pending.revision += 1;
        }
        break;
      case "resume":
        if (pending.paused) {
          pending.paused = false;
          pending.revision += 1;
        }
        break;
      case "delete": {
        requirePaused();
        const removed = remove(request.messageId);
        if (!removed) {
          throw Object.assign(new Error("Pending message not found"), {
            status: 409,
          });
        }
        this.pendingText.delete(removed.id);
        pending.revision += 1;
        break;
      }
      case "clear": {
        requirePaused();
        const entries = [...pending.steering, ...pending.followUp];
        if (entries.length > 0) {
          for (const entry of entries) this.pendingText.delete(entry.id);
          pending.steering = [];
          pending.followUp = [];
          pending.revision += 1;
        }
        break;
      }
      case "convert": {
        requirePaused();
        const target =
          request.target === "steer" ? pending.steering : pending.followUp;
        if (!target.some((item) => item.id === request.messageId)) {
          const moved = remove(request.messageId);
          if (!moved) {
            throw Object.assign(new Error("Pending message not found"), {
              status: 409,
            });
          }
          target.push(moved);
          pending.revision += 1;
        }
        break;
      }
    }

    this.publishPending(sessionId);
    if (
      request.action === "resume" &&
      !active.isStreaming &&
      (pending.steering.length > 0 || pending.followUp.length > 0)
    ) {
      for (const entry of [...pending.steering, ...pending.followUp]) {
        this.pendingText.delete(entry.id);
      }
      pending.steering = [];
      pending.followUp = [];
      pending.revision += 1;
      this.publishPending(sessionId);
    }
    return structuredClone(pending);
  }

  async pendingMessageTexts(
    sessionId: string,
    messageIds: readonly string[],
  ): Promise<Array<{ id: string; text: string }>> {
    this.requireSession(sessionId);
    const pending = this.pendingFor(sessionId);
    const currentIds = new Set(
      [...pending.steering, ...pending.followUp].map((item) => item.id),
    );
    if (new Set(messageIds).size !== messageIds.length) {
      throw Object.assign(new Error("Pending message ids must be unique"), {
        status: 400,
      });
    }
    return messageIds.map((id) => {
      const text = currentIds.has(id) ? this.pendingText.get(id) : undefined;
      if (text === undefined) {
        throw Object.assign(new Error("Pending message not found"), {
          status: 409,
        });
      }
      return { id, text };
    });
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
    const pending = this.pendingFor(active.sessionId);
    if (
      !pending.paused &&
      (pending.steering.length > 0 || pending.followUp.length > 0)
    ) {
      for (const entry of [...pending.steering, ...pending.followUp]) {
        this.pendingText.delete(entry.id);
      }
      pending.steering = [];
      pending.followUp = [];
      pending.revision += 1;
      this.publishPending(active.sessionId);
    }
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
    return structuredClone(this.state);
  }
  async transcriptPage(
    sessionId: string,
    _cursor: string,
    _deferActivity = false,
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
  async transcriptActivityPage(
    sessionId: string,
    _cursor: string,
  ): Promise<TranscriptActivityPage> {
    const active = this.requireSession(sessionId);
    return {
      sessionId,
      revision: active.transcriptPage.revision,
      viewId: active.transcriptPage.viewId,
      messages: [],
      hasMore: false,
      cursor: null,
    };
  }
  async transcriptUserTurns(
    sessionId: string,
    start?: number,
  ): Promise<UserTurnIndexPage> {
    const active = this.requireSession(sessionId);
    const turns = active.transcriptPage.messages.flatMap((value, index) => {
      if (!value || typeof value !== "object" || Array.isArray(value))
        return [];
      const record = value as Record<string, unknown>;
      if (record.role !== "user") return [];
      const ordinal = Number(record.__inspireUserTurnIndex);
      const content =
        typeof record.content === "string"
          ? record.content
          : Array.isArray(record.content)
            ? record.content
                .flatMap((part) =>
                  part &&
                  typeof part === "object" &&
                  !Array.isArray(part) &&
                  (part as Record<string, unknown>).type === "text" &&
                  typeof (part as Record<string, unknown>).text === "string"
                    ? [(part as Record<string, unknown>).text as string]
                    : [],
                )
                .join(" ")
            : "";
      return [
        {
          id:
            typeof record.__inspireMessageId === "string"
              ? record.__inspireMessageId
              : `mock-user:${index}`,
          ordinal: Number.isSafeInteger(ordinal) ? ordinal : 0,
          snippet:
            content.replace(/\s+/g, " ").trim().slice(0, 180) || "User message",
          attachmentCount: 0,
        },
      ];
    });
    turns.forEach((turn, ordinal) => {
      turn.ordinal = ordinal;
    });
    const pageStart =
      start === undefined
        ? Math.max(0, turns.length - 100)
        : Math.min(start, turns.length);
    return {
      sessionId,
      revision: active.transcriptPage.revision,
      viewId: active.transcriptPage.viewId,
      total: turns.length,
      start: pageStart,
      turns: turns.slice(pageStart, pageStart + 100),
    };
  }
  async transcriptUserTurn(
    sessionId: string,
    targetMessageId: string,
    _cursor?: string,
  ): Promise<UserTurnTranscriptPage> {
    const active = this.requireSession(sessionId);
    return {
      ...active.transcriptPage,
      targetMessageId,
      rangeStart: 0,
      rangeEnd: active.transcriptPage.messages.length,
      hasMoreInTurn: false,
      continuationCursor: null,
    };
  }
  async composerHistory(
    sessionId: string,
    start = 0,
  ): Promise<ComposerHistoryPage> {
    const active = this.requireSession(sessionId);
    return projectComposerHistoryPage(
      active.transcriptPage.messages,
      {
        sessionId,
        revision: active.transcriptPage.revision,
        viewId: active.transcriptPage.viewId,
        ...(active.transcriptPage.incarnation
          ? { incarnation: active.transcriptPage.incarnation }
          : {}),
        ...(active.transcriptPage.effectiveLeafId !== undefined
          ? { effectiveLeafId: active.transcriptPage.effectiveLeafId }
          : {}),
      },
      start,
      active.cwd,
    );
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
      messageCount: destination.transcriptPage.messages.length,
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
      messages: active.transcriptPage.messages,
    };
  }
  async close(): Promise<void> {
    for (const timer of this.timers.values()) clearInterval(timer);
    this.timers.clear();
  }
}
