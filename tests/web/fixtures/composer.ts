import { fireEvent, screen } from "@testing-library/react";
import type { ComposerHistoryEntry } from "../../../shared/contracts";
import { discardComposerHistory } from "../../../src/composer-history";
import { store } from "../../../src/store";
import {
  activeSnapshot,
  DEFAULT_PREFS,
  FakeWebSocket,
  installFakeWebSocket,
  inputReceipt,
  installFetch,
  jsonBody,
} from "../helpers";
import { baseRoutes } from "../store-fixture";

// These mutable responses model only the Composer's HTTP collaborators.
export async function createComposerFixture() {
  const host = {
    promptBodies: [] as Record<string, unknown>[],
    slowSearchGate: null as Promise<void> | null,
    historyEntries: [] as ComposerHistoryEntry[],
    historyRequests: 0,
    historyGate: null as Promise<void> | null,
  };
  for (const id of ["s1", "s2"]) {
    store.drafts.setText(id, "");
    discardComposerHistory(id);
  }
  installFakeWebSocket();
  let preferences = DEFAULT_PREFS;
  let preferenceRevision = 0;
  installFetch((url, init) => {
    if (url.startsWith("/api/history?kind=composer&")) {
      host.historyRequests += 1;
      const requestUrl = new URL(url, "https://inspire.test");
      const sessionId = requestUrl.searchParams.get("sessionId") ?? "s1";
      const start = Number(requestUrl.searchParams.get("start") ?? 0);
      const state = store.getState();
      const response = {
        body: {
          sessionId,
          revision: state.view.revision,
          viewId: state.view.viewId,
          incarnation: state.view.incarnation,
          effectiveLeafId: state.view.effectiveLeafId,
          composerHistoryVersion: state.view.composerHistoryVersion,
          historyId: `history-${JSON.stringify(host.historyEntries)}`,
          total: host.historyEntries.length,
          start,
          entries: host.historyEntries.slice(start),
          nextStart: null,
        },
      };
      return host.historyGate
        ? host.historyGate.then(() => response)
        : response;
    }
    if (url.startsWith("/api/attachments")) {
      return {
        body: {
          attachments: [
            {
              id: "att-1",
              fileName: "notes.txt",
              mimeType: "text/plain",
              size: 5,
              kind: "file",
            },
          ],
        },
      };
    }
    if (url.startsWith("/api/files")) {
      if (url.includes("q=slow") && host.slowSearchGate) {
        return host.slowSearchGate.then(() => ({
          body: { files: [{ path: "old/slow.ts", name: "slow.ts" }] },
        }));
      }
      return { body: { files: [{ path: "src/index.ts", name: "index.ts" }] } };
    }
    if (url === "/api/prompt") {
      const body = jsonBody(init);
      host.promptBodies.push(body);
      return {
        status: 202,
        body: {
          ...inputReceipt("prompt", body),
          state: "completed",
          result: null,
        },
      };
    }
    if (url === "/api/preferences" && init.method === "PATCH") {
      preferences = { ...preferences, ...jsonBody(init) };
      return { body: { preferences, revision: ++preferenceRevision } };
    }
    return baseRoutes(url, init);
  });
  await store.init();
  FakeWebSocket.instances.at(-1)?.join(activeSnapshot());

  clearComposer();
  return host;
}

export function typeDraft(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: text },
  });
}

function clearComposer() {
  store.replaceComposerText("");
  for (const item of store.drafts.get(store.getState().sessionId).attachments)
    store.removeAttachment(item.localId);
  for (const path of store.drafts.get(store.getState().sessionId).projectFiles)
    store.removeProjectFile(path);
  store.dismissError();
}
