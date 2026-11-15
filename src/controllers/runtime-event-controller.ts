import {
  type ActiveSnapshot,
  type LiveTranscript,
  type ProjectionConflict,
  type SessionRuntimeStatus,
} from "../../shared/contracts";
import { isExternalSessionActivities } from "../../shared/session-activity";
import { type AppState, transcriptDiagnostic } from "../app-state";
import { reduceEvent, type WireEvent } from "../events";

interface RuntimeEventHost {
  state(): AppState;
  patch(patch: Partial<AppState>): void;
  setEditorText?(sessionId: string, text: string): void;
  applySnapshot(snapshot: ActiveSnapshot): void;
  applyTranscript(
    sessionId: string,
    data: LiveTranscript,
    sequence: number,
    statuses?: Record<string, SessionRuntimeStatus>,
  ): void;
  ensureSessionVisible(sessionId: string): void;
  refreshLoadedSessions(): Promise<void>;
  hasVisibleGitSurface(): boolean;
  refreshGitStatus(): Promise<void>;
  selectionGeneration(): number;
  invalidateResync(): void;
  resync(sessionId: string | null, generation: number): Promise<void>;
}

/** Owns ordered runtime-event reduction and user-attention correlation.
 * Snapshots remain AppStore transactions; this controller routes live deltas
 * without giving event producers a second browser-state authority. */
export class RuntimeEventController {
  private readonly titleAttention = new Set<string>();
  private readonly acknowledgedStatus = new Map<string, number>();
  private pendingResync: {
    generation: number;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;

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

  projectSessionStatuses(
    statuses: Record<string, SessionRuntimeStatus>,
    viewedSessionId: string | null,
  ): Record<string, SessionRuntimeStatus> {
    if (viewedSessionId)
      this.viewStatus(viewedSessionId, statuses[viewedSessionId]);
    return Object.fromEntries(
      Object.entries(statuses).map(([id, status]) => [
        id,
        this.displayStatus(id, status),
      ]),
    );
  }

  private viewStatus(id: string, status?: SessionRuntimeStatus): void {
    if (status?.attentionId === undefined) return;
    this.acknowledgedStatus.delete(id);
    this.acknowledgedStatus.set(id, status.attentionId);
    if (this.acknowledgedStatus.size > 512) {
      const oldest = this.acknowledgedStatus.keys().next().value;
      if (oldest !== undefined) this.acknowledgedStatus.delete(oldest);
    }
  }

  private displayStatus(
    id: string,
    status: SessionRuntimeStatus,
  ): SessionRuntimeStatus {
    if (
      status.attentionId === undefined ||
      this.acknowledgedStatus.get(id) !== status.attentionId
    )
      return status;
    const { indicator, ...acknowledged } = status;
    return indicator === "completed" || indicator === "failed"
      ? acknowledged
      : status;
  }

  markTaskAttention(sessionId: string): void {
    if (
      this.host.state().taskAlerts.mode === "off" ||
      (sessionId === this.host.state().sessionId && this.isForeground())
    )
      return;
    this.titleAttention.add(sessionId);
    this.publishTitleAttention();
  }

  invalidateTransport(): void {
    if (this.pendingResync) clearTimeout(this.pendingResync.timer);
    this.pendingResync = null;
  }

  resetStatusAcknowledgements(): void {
    this.acknowledgedStatus.clear();
  }

  private scheduleResync(sessionId: string | null): void {
    // Fence an older response as soon as the event arrives, even while the
    // next observation is waiting for the rest of this event burst.
    this.host.invalidateResync();
    const generation = this.host.selectionGeneration();
    if (this.pendingResync?.generation === generation) return;
    if (this.pendingResync) clearTimeout(this.pendingResync.timer);
    // Settlement can arrive in a burst. Keep a fixed deadline for the refresh.
    const timer = setTimeout(() => {
      this.pendingResync = null;
      void this.host.resync(sessionId, generation);
    }, 16);
    this.pendingResync = { generation, timer };
  }

  clearTitleAttention(): void {
    this.titleAttention.clear();
    this.publishTitleAttention();
  }

  forgetAttention(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of sessionIds) {
      this.titleAttention.delete(sessionId);
      this.acknowledgedStatus.delete(sessionId);
    }
    this.publishTitleAttention();
  }

  apply(event: WireEvent): void {
    if (event.type === "external_session_activity") {
      if (!isExternalSessionActivities(event.activities)) return;
      const previous = this.host.state().externalSessionActivities;
      const next = event.activities;
      if (
        Object.keys(previous).length === Object.keys(next).length &&
        Object.entries(next).every(
          ([id, activity]) => previous[id] === activity,
        )
      )
        return;
      this.host.patch({ externalSessionActivities: next });
      for (const id of Object.keys(next)) this.host.ensureSessionVisible(id);
      return;
    }
    if (event.type === "snapshot") {
      if (event.data) {
        const snapshot = event.data as ActiveSnapshot;
        this.host.applySnapshot({
          ...snapshot,
          runtimeSequence:
            typeof event.runtimeSequence === "number"
              ? event.runtimeSequence
              : snapshot.runtimeSequence,
        });
        if (snapshot.active?.sessionId)
          this.host.ensureSessionVisible(snapshot.active.sessionId);
      }
      return;
    }

    // Every live event carries its authoritative per-session status; merge it
    // into the map before any transcript routing.
    const eventSessionId =
      typeof event.sessionId === "string" ? event.sessionId : null;
    const sessionStatuses = this.mergeSessionStatus(
      eventSessionId,
      event.sessionStatus,
    );
    if (
      eventSessionId !== null &&
      eventSessionId !== this.host.state().sessionId
    ) {
      // Background session: its message/tool/notice deltas must never enter
      // the visible transcript and must not resync it. Only the status
      // changes; a settle refreshes the list so folder/time ordering catches
      // up. Unchanged statuses (token-level chatter) publish nothing.
      if (sessionStatuses) this.host.patch({ sessionStatuses });
      this.host.ensureSessionVisible(eventSessionId);
      if (event.type === "agent_settled")
        void this.host.refreshLoadedSessions();
      return;
    }

    if (eventSessionId) this.host.ensureSessionVisible(eventSessionId);

    if (
      event.type === "tool_execution_end" &&
      this.host.hasVisibleGitSurface()
    ) {
      void this.host.refreshGitStatus();
    }

    if (
      event.type === "session_projection_changed" ||
      event.type === "branch_changed"
    ) {
      const transcript = event.transcript as LiveTranscript;
      const page = transcript?.transcriptPage;
      if (
        !eventSessionId ||
        typeof event.runtimeSequence !== "number" ||
        !Number.isSafeInteger(event.runtimeSequence) ||
        page?.sessionId !== eventSessionId ||
        typeof page.viewId !== "string" ||
        !Number.isSafeInteger(page.revision) ||
        !Array.isArray(page.messages)
      )
        throw new Error("Invalid transcript replacement");
      this.host.applyTranscript(
        eventSessionId,
        transcript,
        event.runtimeSequence,
        sessionStatuses ?? undefined,
      );
      return;
    }

    if (event.type === "session_projection_conflict") {
      const conflict = event.conflict as ProjectionConflict | undefined;
      const statusPatch = sessionStatuses ? { sessionStatuses } : {};
      if (conflict && typeof conflict.message === "string") {
        const view = { ...this.host.state().view, conflict };
        this.host.patch({
          ...statusPatch,
          view,
          ...transcriptDiagnostic(view),
        });
      } else this.host.patch(statusPatch);
      return;
    }

    // Refresh the selected view when a requested worker, attachment, or
    // background model discovery publishes new capabilities.
    if (
      event.type === "runtime_ready" ||
      event.type === "model_metadata_changed"
    ) {
      if (sessionStatuses) this.host.patch({ sessionStatuses });
      void this.host.resync(eventSessionId, this.host.selectionGeneration());
      return;
    }

    if (
      event.type === "extension_ui_request" &&
      event.method === "set_editor_text"
    ) {
      const sessionId = this.host.state().sessionId;
      if (sessionId && typeof event.text === "string")
        this.host.setEditorText?.(sessionId, event.text);
      if (sessionStatuses) this.host.patch({ sessionStatuses });
      return;
    }

    const { slice, resync, changed } = reduceEvent(
      this.host.state().live,
      event,
    );
    if (changed || sessionStatuses)
      this.host.patch({
        ...(changed ? { live: slice } : {}),
        ...(sessionStatuses ? { sessionStatuses } : {}),
      });
    if (resync) {
      const sessionId = eventSessionId ?? this.host.state().sessionId;
      if (event.type === "agent_settled") this.scheduleResync(sessionId);
      else void this.host.resync(sessionId, this.host.selectionGeneration());
    }
  }

  /** Merge an event's sessionStatus into the map; null when nothing changed. */
  private mergeSessionStatus(
    sessionId: string | null,
    status: SessionRuntimeStatus | undefined,
  ): Record<string, SessionRuntimeStatus> | null {
    if (!sessionId || !status) return null;
    if (sessionId === this.host.state().sessionId)
      this.viewStatus(sessionId, status);
    const next = this.displayStatus(sessionId, status);
    const existing = this.host.state().sessionStatuses[sessionId];
    if (
      existing &&
      existing.runState === next.runState &&
      existing.indicator === next.indicator &&
      existing.attentionId === next.attentionId &&
      existing.needsInput === next.needsInput &&
      existing.external === next.external &&
      existing.queueAdmission === next.queueAdmission
    )
      return null;
    return { ...this.host.state().sessionStatuses, [sessionId]: next };
  }
}
