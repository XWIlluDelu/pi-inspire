import { fireEvent, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComposerHistoryEntry } from "../../../shared/contracts";
import { discardComposerHistory } from "../../../src/composer-history";
import { deleteSessionDraft } from "../../../src/session-drafts";
import { store } from "../../../src/store";
import {
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
  type RouteResponse,
  TEST_HOST_AUTHORITY,
} from "../helpers";
import { baseRoutes } from "../store-fixture";

// These mutable responses model only the Composer's HTTP collaborators.
export async function createComposerFixture() {
  const host = {
    promptBodies: [] as Record<string, unknown>[],
    abortBodies: [] as Record<string, unknown>[],
    promptFails: false,
    promptGates: [] as Promise<RouteResponse>[],
    fileSearchFails: false,
    slowSearchGate: null as Promise<void> | null,
    historyEntries: [] as ComposerHistoryEntry[],
    historyRequests: 0,
    historyGate: null as Promise<void> | null,
  };
  for (const id of ["s1", "s2"]) {
    deleteSessionDraft(id);
    discardComposerHistory(id);
  }
  installFakeWebSocket();
  installFetch((url, init) => {
    if (url.startsWith("/api/composer/history")) {
      host.historyRequests += 1;
      const requestUrl = new URL(url, "https://inspire.test");
      const sessionId = requestUrl.searchParams.get("sessionId") ?? "s1";
      const start = Number(requestUrl.searchParams.get("start") ?? 0);
      const state = store.getState();
      const response = {
        body: {
          sessionId,
          revision: state.transcriptRevision,
          viewId: state.transcriptViewId,
          incarnation: state.transcriptIncarnation,
          effectiveLeafId: state.transcriptEffectiveLeafId,
          composerHistoryVersion: state.composerHistoryVersion,
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
      if (host.fileSearchFails)
        return { status: 500, body: { error: "index unavailable" } };
      if (url.includes("q=slow") && host.slowSearchGate) {
        return host.slowSearchGate.then(() => ({
          body: { files: [{ path: "old/slow.ts", name: "slow.ts" }] },
        }));
      }
      if (url.includes("q=keyboard")) {
        return {
          body: {
            files: [
              { path: "src/keyboard-a.ts", name: "keyboard-a.ts" },
              { path: "src/keyboard-b.ts", name: "keyboard-b.ts" },
              { path: "src/keyboard-c.ts", name: "keyboard-c.ts" },
            ],
          },
        };
      }
      return { body: { files: [{ path: "src/index.ts", name: "index.ts" }] } };
    }
    if (url.startsWith("/api/pending/recover"))
      return {
        body: { steering: ["recovered steer"], followUp: ["recovered follow"] },
      };
    if (url.startsWith("/api/control/abort")) {
      host.abortBodies.push(jsonBody(init));
      return { body: { steering: [], followUp: [] } };
    }
    if (url.startsWith("/api/prompt")) {
      const body = jsonBody(init);
      if (host.promptFails)
        return {
          status: 500,
          headers: {
            "X-Inspire-Authority": TEST_HOST_AUTHORITY,
            "X-Inspire-Prompt-Operation": String(body.operationId),
            "X-Inspire-Prompt-Outcome": "rejected",
          },
          body: { error: "boom" },
        };
      host.promptBodies.push(body);
      return (
        host.promptGates.shift() ?? { status: 202, body: { accepted: true } }
      );
    }
    if (url.startsWith("/api/preferences")) return { body: jsonBody(init) };
    return baseRoutes(url, init);
  });
  await store.init("token");
  FakeWebSocket.instances.at(-1)?.open();

  clearComposer();
  return host;
}

export async function attachFile(name = "notes.txt") {
  const input = document.querySelector(
    'input[type="file"]',
  ) as HTMLInputElement;
  await userEvent.upload(
    input,
    new File(["hello"], name, { type: "text/plain" }),
  );
}

export function typeDraft(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), {
    target: { value: text },
  });
}

function clearComposer() {
  store.replaceComposerText("");
  for (const item of store.getState().attachments)
    store.removeAttachment(item.localId);
  for (const path of store.getState().projectFiles)
    store.removeProjectFile(path);
  store.dismissError();
}
