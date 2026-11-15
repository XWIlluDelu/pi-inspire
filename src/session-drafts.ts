import { useCallback, useSyncExternalStore } from "react";
import type { PendingAttachment } from "./controllers/composer-controller";

export interface SessionDraft {
  revision: number;
  text: string;
  attachments: PendingAttachment[];
  projectFiles: string[];
  workspaceCwd?: string;
  intentId?: string;
}

export function hasDraftInput(draft: SessionDraft): boolean {
  return Boolean(
    draft.text || draft.attachments.length || draft.projectFiles.length,
  );
}

const EMPTY_DRAFT: SessionDraft = {
  revision: 0,
  text: "",
  attachments: [],
  projectFiles: [],
};

type DraftKey = string | null;

function storageKey(sessionId: DraftKey): string {
  return `inspire:composer-draft:v1:${
    sessionId === null ? "start" : `session:${encodeURIComponent(sessionId)}`
  }`;
}

/** Each tab has one editable draft per native session and one for New.
 * Only text persists here. The upload and operation owners keep their own records. */
export class SessionDrafts {
  private readonly drafts = new Map<DraftKey, SessionDraft>();
  private readonly listeners = new Set<() => void>();
  private revision = 0;

  subscribe = (publish: () => void): (() => void) => {
    this.listeners.add(publish);
    return () => this.listeners.delete(publish);
  };

  get(sessionId: DraftKey): SessionDraft {
    const current = this.drafts.get(sessionId);
    if (current) return current;
    let text = "";
    try {
      text = window.sessionStorage.getItem(storageKey(sessionId)) ?? "";
    } catch {
      // Unavailable storage leaves the same tab-local editing behavior.
    }
    const draft = { ...EMPTY_DRAFT, text };
    this.drafts.set(sessionId, draft);
    return draft;
  }

  update(
    sessionId: DraftKey,
    patch: Partial<Omit<SessionDraft, "revision">>,
    material = true,
  ): SessionDraft {
    const current = this.get(sessionId);
    const draft = {
      ...current,
      ...patch,
      revision: material ? ++this.revision : current.revision,
    };
    if (draft.text !== current.text) {
      try {
        const key = storageKey(sessionId);
        if (draft.text) window.sessionStorage.setItem(key, draft.text);
        else window.sessionStorage.removeItem(key);
      } catch {
        // A quota or policy restriction must not interrupt editing.
      }
    }
    this.drafts.set(sessionId, draft);
    for (const publish of this.listeners) publish();
    return draft;
  }

  setText(sessionId: DraftKey, text: string): void {
    if (this.get(sessionId).text !== text) this.update(sessionId, { text });
  }

  clear(sessionId: DraftKey): void {
    this.update(sessionId, {
      text: "",
      attachments: [],
      projectFiles: [],
      workspaceCwd: undefined,
      intentId: undefined,
    });
  }

  entries() {
    return this.drafts.entries();
  }
}

export function useSessionDraft(
  drafts: SessionDrafts,
  sessionId: DraftKey | undefined,
): SessionDraft {
  const read = useCallback(
    () => (sessionId === undefined ? EMPTY_DRAFT : drafts.get(sessionId)),
    [drafts, sessionId],
  );
  return useSyncExternalStore(drafts.subscribe, read, () => EMPTY_DRAFT);
}
