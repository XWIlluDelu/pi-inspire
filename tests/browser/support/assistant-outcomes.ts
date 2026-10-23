import type { Page, WebSocketRoute } from "@playwright/test";
import type { ActiveSnapshot } from "../../../shared/contracts";

/** A public-wire fixture: the mock Host supplies navigation and read snapshots;
 * controlled completion frames represent native Pi without executing a model. */
export async function assistantOutcomeScenario(page: Page) {
  const sessionId = "mock-errors";
  let socket: WebSocketRoute | undefined;
  let readySocket: WebSocketRoute | undefined;
  let phase: "running" | "stopped" | "failed" = "running";
  let refuseStop = true;
  const partial = {
    role: "assistant",
    content: [{ type: "text", text: "Partial response kept before Stop." }],
    timestamp: 2,
    __inspireEntryId: "outcome-partial",
  };
  const stopped = {
    role: "assistant",
    content: [],
    stopReason: "aborted",
    errorMessage: "This operation was aborted",
    timestamp: 3,
    __inspireEntryId: "outcome-stopped",
  };
  const failed = {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: "This operation was aborted",
    timestamp: 4,
    __inspireEntryId: "outcome-failed",
  };
  const project = (snapshot: ActiveSnapshot) => {
    if (snapshot.active?.sessionId !== sessionId) return;
    snapshot.runState =
      phase === "running"
        ? "running"
        : phase === "stopped"
          ? "aborted"
          : "failed";
    snapshot.sessionStatuses[sessionId] = { runState: snapshot.runState };
    const messages = [
      {
        role: "user",
        content: "Run the task until I stop it.",
        timestamp: 1,
        __inspireEntryId: "outcome-user",
      },
      partial,
      ...(phase === "running" ? [] : [stopped]),
      ...(phase === "failed" ? [failed] : []),
    ];
    snapshot.active.transcriptPage = {
      ...snapshot.active.transcriptPage,
      messages,
      hasOlder: false,
      olderCursor: null,
      activityRanges: [],
    };
  };
  await page.routeWebSocket(/\/events(?:\?|$)/, (client) => {
    socket = client;
    readySocket = undefined;
    const upstream = client.connectToServer();
    upstream.onMessage((data) => {
      if (socket !== client) return;
      const event = JSON.parse(String(data));
      if (event.type === "snapshot") {
        if (event.data) project(event.data);
        if (
          (event.detailSessionId ?? event.data?.active?.sessionId) === sessionId
        )
          readySocket = client;
      }
      client.send(JSON.stringify(event));
    });
  });
  for (const pattern of [
    "**/api/bootstrap**",
    "**/api/snapshot**",
    "**/api/sessions/open",
  ]) {
    await page.route(pattern, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      if (body.snapshot) project(body.snapshot);
      else if (body.active) project(body);
      await route.fulfill({ response, json: body });
    });
  }
  await page.route("**/api/control/abort", async (route) => {
    const identity = route.request().postDataJSON();
    await route.fulfill(
      refuseStop
        ? {
            status: 503,
            // A terminal refusal permits a new Stop intent. A bare 503 would
            // retain an unknown operation that this fixture never executed.
            headers: {
              "X-Inspire-Authority": identity.authorityId,
              "X-Inspire-Pending-Operation": identity.operationId,
              "X-Inspire-Pending-Outcome": "failed",
            },
            json: { error: "Stop is temporarily unavailable" },
          }
        : { json: { steering: [], followUp: [] } },
    );
  });
  const emit = (event: Record<string, unknown>) => {
    if (!socket)
      throw new Error("The outcome fixture has no current event connection");
    socket.send(JSON.stringify({ ...event, sessionId }));
  };
  return {
    ready: () => socket !== undefined && socket === readySocket,
    allowStop: () => {
      refuseStop = false;
    },
    stopped: () => {
      phase = "stopped";
      emit({ type: "message_end", message: stopped });
      emit({ type: "agent_settled", aborted: true });
    },
    failed: () => {
      phase = "failed";
      emit({ type: "agent_start" });
      emit({
        type: "message_start",
        message: { ...failed, stopReason: undefined, errorMessage: undefined },
      });
      emit({ type: "message_end", message: failed });
      emit({ type: "agent_settled", aborted: false });
    },
  };
}
