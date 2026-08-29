import {
  type ActiveSnapshot,
  type ProjectionConflict,
  type ProjectionHealth,
  projectionConflictSeverity,
  isSessionRuntimeStatus,
  type SessionRuntimeStatus,
} from "../../shared/contracts";
import type { AppState } from "../app-state";
import {
  type ChatMessage,
  type EventSlice,
  messageKey,
  type Notice,
  reduceEvent,
  type WireEvent,
} from "../events";

interface RuntimeEventHost {
  state(): AppState;
  patch(patch: Partial<AppState>): void;
  notify(kind: Notice["kind"], text: string): void;
  openSession(sessionId: string): Promise<void>;
  applySnapshot(snapshot: ActiveSnapshot): void;
  invalidateSelection(): void;
  ensureSessionVisible(sessionId: string): void;
  recordRuntimeReady(sessionId: string): void;
  clearRuntimeReady(sessionId: string): void;
  refreshLoadedSessions(): Promise<void>;
  hasVisibleGitSurface(): boolean;
  refreshGitStatus(): Promise<void>;
  markProjectionStale(): void;
  selectionGeneration(): number;
  resync(
    sessionId: string | null,
    generation: number,
    minimumRevision?: number,
  ): Promise<void>;
  scheduleNoticeDismissal(noticeId: number): void;
}

/** Owns ordered runtime-event reduction and user-attention correlation.
 * Snapshots remain AppStore transactions; this controller routes live deltas
 * without giving event producers a second browser-state authority. */
export class RuntimeEventController {
  private settledKeys = new Set<string>();
  private readonly attentionArms = new Map<
    string,
    Set<"agent" | "compaction">
  >();
  private readonly titleAttention = new Set<string>();

  constructor(private readonly host: RuntimeEventHost) {}

  private isForeground(): boolean {
    return document.visibilityState === "visible" && document.hasFocus();
  }

  private publishTitleAttention(): void {
    const attentionSessionIds = [...this.titleAttention];
    if (
      attentionSessionIds.length ===
        this.host.state().attentionSessionIds.length &&
      attentionSessionIds.every(
        (id, index) => id === this.host.state().attentionSessionIds[index],
      )
    )
      return;
    this.host.patch({ attentionSessionIds });
  }

  private clearAttentionFor(sessionId: string | null): void {
    if (!sessionId || !this.titleAttention.delete(sessionId)) return;
    this.publishTitleAttention();
  }

  /** Called from the window focus/visibility boundary. Viewing the owning
   * selected session acknowledges its title attention. */
  acknowledgeVisibleSession(): void {
    if (this.isForeground())
      this.clearAttentionFor(this.host.state().sessionId);
  }

  private armAttention(sessionId: string, kind: "agent" | "compaction"): void {
    const arms =
      this.attentionArms.get(sessionId) ?? new Set<"agent" | "compaction">();
    arms.add(kind);
    this.attentionArms.set(sessionId, arms);
  }

  private hasAttentionArm(
    sessionId: string,
    kind: "agent" | "compaction",
  ): boolean {
    return this.attentionArms.get(sessionId)?.has(kind) ?? false;
  }

  private consumeAttentionArm(
    sessionId: string,
    kind: "agent" | "compaction",
  ): boolean {
    const arms = this.attentionArms.get(sessionId);
    if (!arms?.delete(kind)) return false;
    if (arms.size === 0) this.attentionArms.delete(sessionId);
    return true;
  }

  /** Snapshots never create attention ownership, but they are authoritative
   * evidence that an observed live operation either still exists or ended
   * outside this socket's event stream. */
  reconcileAttentionArms(
    sessionStatuses: Readonly<Record<string, SessionRuntimeStatus>>,
  ): void {
    const liveAgentStates = new Set([
      "running",
      "retrying",
      "queued",
      "compacting",
    ]);
    for (const [sessionId, arms] of this.attentionArms) {
      const runState = sessionStatuses[sessionId]?.runState;
      if (!runState) {
        this.attentionArms.delete(sessionId);
        continue;
      }
      if (arms.has("agent") && !liveAgentStates.has(runState))
        arms.delete("agent");
      if (arms.has("compaction") && runState !== "compacting")
        arms.delete("compaction");
      if (arms.size === 0) this.attentionArms.delete(sessionId);
    }
  }

  private statusOutcome(event: WireEvent): "completed" | "failed" | "aborted" {
    const status = event.sessionStatus as
      | Partial<SessionRuntimeStatus>
      | undefined;
    if (
      event.type === "runtime_error" ||
      status?.runState === "failed" ||
      status?.runState === "conflict"
    )
      return "failed";
    if (status?.runState === "aborted") return "aborted";
    return "completed";
  }

  private compactionOutcome(
    event: WireEvent,
  ): "completed" | "failed" | "aborted" {
    if (event.aborted === true) return "aborted";
    if (typeof event.errorMessage === "string" && event.errorMessage.trim())
      return "failed";
    if (event.result === undefined || event.result === null) return "failed";
    return this.statusOutcome(event);
  }

  private attendToOutcome(
    sessionId: string,
    outcome: "completed" | "failed" | "aborted",
  ): void {
    const foregroundOwner =
      sessionId === this.host.state().sessionId && this.isForeground();
    if (
      foregroundOwner ||
      this.host.state().prefs.completionAttention === "off"
    )
      return;
    // Desktop attention is progressive: the durable tab marker remains after
    // the transient OS notification disappears or cannot be delivered.
    this.titleAttention.add(sessionId);
    this.publishTitleAttention();
    if (this.host.state().prefs.completionAttention === "title") return;
    if (this.host.state().prefs.completionAttention !== "desktop") return;
    const NotificationApi = window.Notification;
    if (!NotificationApi || NotificationApi.permission !== "granted") return;
    const project = this.host
      .state()
      .sessions.find((candidate) => candidate.id === sessionId)?.project;
    const title =
      outcome === "completed"
        ? "Task completed"
        : outcome === "aborted"
          ? "Task aborted"
          : "Task failed";
    // A catalog title can be the first prompt. OS-visible fields therefore use
    // only fixed copy, opaque session identity, and cwd-derived project data.
    const body = project ? `Project: ${project}` : "Pi task";
    try {
      const notification = new NotificationApi(title, {
        body,
        tag: `inspire-task:${sessionId}:${outcome}`,
      });
      notification.onclick = () => {
        window.focus();
        if (this.host.state().sessionId !== sessionId)
          void this.host.openSession(sessionId);
        else this.acknowledgeVisibleSession();
        notification.close();
      };
    } catch {
      this.host.notify(
        "warning",
        "Desktop notifications are unavailable in this browser context",
      );
    }
  }

  clearLiveAttention(): void {
    this.attentionArms.clear();
  }

  clearTitleAttention(): void {
    this.titleAttention.clear();
    this.publishTitleAttention();
  }

  forgetAttention(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of sessionIds) {
      this.attentionArms.delete(sessionId);
      this.titleAttention.delete(sessionId);
    }
    this.publishTitleAttention();
  }

  replaceSettledMessages(messages: readonly ChatMessage[]): void {
    this.settledKeys = new Set(
      messages.map(messageKey).filter((key): key is string => key !== null),
    );
  }

  markSettled(key: string): void {
    this.settledKeys.add(key);
  }

  private eventSlice(): EventSlice {
    const s = this.host.state();
    return {
      messages: s.messages,
      streaming: s.streaming,
      activeAssistantMessageKey: s.activeAssistantMessageKey,
      runState: s.runState,
      tools: s.tools,
      retry: s.retry,
      queue: s.queue,
      extensionUiRequests: s.extensionUiRequests,
      extensionUiRespondingId: s.extensionUiRespondingId,
      extensionDisplays: s.extensionDisplays,
      notices: s.notices,
      statuses: s.statuses,
      editorText: s.editorText,
      windowTitle: s.windowTitle,
      nextNoticeId: s.nextNoticeId,
    };
  }

  apply(event: WireEvent): void {
    if (event.type === "snapshot") {
      if (event.data) {
        // An authoritative push is the newest selection truth: invalidate any
        // open/new response still in flight so it cannot overwrite this. The
        // push also immediately releases the old opening marker; stale
        // finally blocks are fenced by their operation owner.
        this.host.invalidateSelection();
        const snapshot = event.data as ActiveSnapshot;
        this.host.applySnapshot(snapshot);
        if (snapshot.active?.sessionId)
          this.host.ensureSessionVisible(snapshot.active.sessionId);
      }
      return;
    }

    // Every live event carries its authoritative per-session status; merge it
    // into the map before any transcript routing.
    const eventSessionId =
      typeof event.sessionId === "string" ? event.sessionId : null;
    if (eventSessionId) this.host.ensureSessionVisible(eventSessionId);
    const priorRunState = eventSessionId
      ? this.host.state().sessionStatuses[eventSessionId]?.runState
      : undefined;
    const sessionStatuses = this.mergeSessionStatus(
      eventSessionId,
      event.sessionStatus,
    );
    if (eventSessionId) {
      if (event.type === "agent_start" || event.type === "auto_retry_start") {
        this.armAttention(eventSessionId, "agent");
      } else if (event.type === "compaction_start") {
        const nestedInAgent =
          this.hasAttentionArm(eventSessionId, "agent") ||
          priorRunState === "running" ||
          priorRunState === "retrying" ||
          priorRunState === "queued";
        if (event.reason === "manual" && !nestedInAgent)
          this.armAttention(eventSessionId, "compaction");
      } else if (event.type === "compaction_end") {
        if (this.consumeAttentionArm(eventSessionId, "compaction")) {
          this.attendToOutcome(eventSessionId, this.compactionOutcome(event));
        }
      } else if (event.type === "agent_settled") {
        if (this.consumeAttentionArm(eventSessionId, "agent")) {
          this.attendToOutcome(eventSessionId, this.statusOutcome(event));
        }
      } else if (event.type === "runtime_error") {
        const armed =
          this.consumeAttentionArm(eventSessionId, "agent") ||
          this.consumeAttentionArm(eventSessionId, "compaction");
        // Runtime death terminates every operation owned by this worker.
        this.attentionArms.delete(eventSessionId);
        if (armed) this.attendToOutcome(eventSessionId, "failed");
      }
    }

    if (
      eventSessionId !== null &&
      eventSessionId !== this.host.state().sessionId
    ) {
      // Background session: its message/tool/notice deltas must never enter
      // the visible transcript and must not resync it. Only the status
      // changes; a settle refreshes the list so folder/time ordering catches
      // up. Unchanged statuses (token-level chatter) publish nothing.
      if (sessionStatuses) this.host.patch({ sessionStatuses });
      if (
        event.type === "runtime_ready" &&
        eventSessionId === this.host.state().openingSessionId
      ) {
        this.host.recordRuntimeReady(eventSessionId);
      }
      if (event.type === "runtime_error")
        this.host.clearRuntimeReady(eventSessionId);
      if (event.type === "agent_settled")
        void this.host.refreshLoadedSessions();
      return;
    }

    if (
      event.type === "tool_execution_end" &&
      this.host.hasVisibleGitSurface()
    ) {
      void this.host.refreshGitStatus();
    }

    if (event.type === "session_projection_changed") {
      const rawHealth = event.health as Partial<ProjectionHealth> | undefined;
      const health: ProjectionHealth =
        rawHealth?.status === "error"
          ? {
              status: "error",
              ...(typeof rawHealth.message === "string"
                ? { message: rawHealth.message }
                : {}),
            }
          : rawHealth?.status === "ok"
            ? { status: "ok" }
            : this.host.state().projectionHealth;
      const conflict =
        event.conflict === null
          ? null
          : event.conflict && typeof event.conflict === "object"
            ? (event.conflict as ProjectionConflict)
            : this.host.state().projectionConflict;
      const projectionError =
        conflict?.message ??
        (health.status === "error"
          ? (health.message ?? "Session projection failed")
          : null);
      const projectionSeverity =
        projectionConflictSeverity(conflict) === "attention"
          ? "warning"
          : "error";
      const clearedProjectionError =
        !projectionError &&
        this.host.state().error === this.host.state().projectionError;
      this.host.patch({
        ...(sessionStatuses ? { sessionStatuses } : {}),
        projectionHealth: health,
        projectionConflict: conflict,
        projectionError,
        ...(projectionError
          ? { error: projectionError, errorSeverity: projectionSeverity }
          : clearedProjectionError
            ? { error: null, errorSeverity: "error" }
            : {}),
      });
      this.host.markProjectionStale();
      const revision =
        typeof event.revision === "number" ? event.revision : undefined;
      void this.host.resync(
        eventSessionId ?? this.host.state().sessionId,
        this.host.selectionGeneration(),
        revision,
      );
      return;
    }

    if (event.type === "session_projection_conflict") {
      if (sessionStatuses) this.host.patch({ sessionStatuses });
      const conflict = event.conflict as ProjectionConflict | undefined;
      if (typeof conflict?.message === "string") {
        this.host.patch({
          projectionConflict: conflict,
          projectionError: conflict.message,
          runState: "conflict",
          error: conflict.message,
          errorSeverity:
            projectionConflictSeverity(conflict) === "attention"
              ? "warning"
              : "error",
        });
      }
      return;
    }

    // An unopened session is shown from its read-only Pi-file preview while
    // extensions initialize off the critical path. Replace that preview with
    // the worker's live state as soon as its own runtime becomes ready.
    if (event.type === "runtime_ready") {
      if (sessionStatuses) this.host.patch({ sessionStatuses });
      void this.host.resync(eventSessionId, this.host.selectionGeneration());
      return;
    }

    const before = this.host.state().notices.length;
    const { slice, settle, resync, changed } = reduceEvent(
      this.eventSlice(),
      this.settledKeys,
      event,
    );
    for (const key of settle) this.settledKeys.add(key);
    if (changed) {
      this.host.patch(sessionStatuses ? { ...slice, sessionStatuses } : slice);
      for (const notice of slice.notices.slice(before)) {
        this.host.scheduleNoticeDismissal(notice.id);
      }
    } else if (sessionStatuses) {
      this.host.patch({ sessionStatuses });
    }
    if (resync)
      void this.host.resync(
        eventSessionId ?? this.host.state().sessionId,
        this.host.selectionGeneration(),
      );
  }

  /** Merge an event's sessionStatus into the map; null when nothing changed. */
  private mergeSessionStatus(
    sessionId: string | null,
    status: unknown,
  ): Record<string, SessionRuntimeStatus> | null {
    if (!sessionId || !isSessionRuntimeStatus(status)) return null;
    const next = status;
    const existing = this.host.state().sessionStatuses[sessionId];
    if (
      existing &&
      existing.runState === next.runState &&
      existing.indicator === next.indicator
    )
      return null;
    return { ...this.host.state().sessionStatuses, [sessionId]: next };
  }
}
