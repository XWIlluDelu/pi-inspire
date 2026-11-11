import type { Page } from "@playwright/test";
import type { ActiveSnapshot, RunState } from "../../../shared/contracts";
import { routeSnapshots } from "./host-events";

/** A public-wire fixture: the Host supplies navigation and read snapshots;
 * controlled completion frames represent native Pi without executing a model. */
export async function assistantOutcomeScenario(page: Page) {
  const sessionId = "fixture-errors";
  let runState: RunState = "running";
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
    snapshot.runState = runState;
    snapshot.sessionStatuses[sessionId] = { runState };
    const messages = [
      {
        role: "user",
        content: "Run the task until I stop it.",
        timestamp: 1,
        __inspireEntryId: "outcome-user",
      },
      partial,
      ...(runState === "running" ? [] : [stopped]),
      ...(runState === "failed" ? [failed] : []),
    ];
    snapshot.active.transcriptPage = {
      ...snapshot.active.transcriptPage,
      messages,
      hasOlder: false,
      olderCursor: null,
      activityRanges: [],
    };
  };
  const transport = await routeSnapshots(page, {
    snapshot: project,
    event: (event) => {
      if (event.sessionId === sessionId && event.sessionStatus)
        event.sessionStatus.runState = runState;
    },
  });
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
  const emit = (event: Record<string, unknown>) =>
    transport.send({ ...event, sessionId });
  return {
    ready: () => transport.ready(sessionId),
    reload: () => transport.reload(sessionId),
    allowStop: () => {
      refuseStop = false;
    },
    stopped: () => {
      runState = "aborted";
      emit({ type: "message_end", message: stopped });
      emit({ type: "agent_settled", aborted: true });
    },
    failed: () => {
      runState = "failed";
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
