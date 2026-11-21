import { z } from "zod";
import {
  TOOL_LOADOUT_EXPOSURES,
  type ToolLoadoutSnapshot,
} from "../shared/contracts.js";
import {
  TOOL_LOADOUT_MAX_DESCRIPTION_CHARS,
  TOOL_LOADOUT_MAX_NAME_CHARS,
  TOOL_LOADOUT_MAX_SOURCE_CHARS,
  TOOL_LOADOUT_PACKET_LIMIT,
  TOOL_LOADOUT_SUFFIX,
  type ToolLoadoutChange,
} from "../shared/tool-loadout.js";
import type { PiRpcProcess } from "./pi-rpc.js";
import { requestError } from "./request-error.js";
import type { BranchBridgeIdentity } from "./runtime-slot.js";
import { workerStatusReply } from "./worker-status-request.js";

const toolLoadout = z.object({
  tools: z.array(
    z.object({
      name: z.string().min(1).max(TOOL_LOADOUT_MAX_NAME_CHARS),
      description: z.string().max(TOOL_LOADOUT_MAX_DESCRIPTION_CHARS),
      source: z.string().max(TOOL_LOADOUT_MAX_SOURCE_CHARS),
      exposure: z.enum(TOOL_LOADOUT_EXPOSURES),
      active: z.boolean(),
    }),
  ),
  truncated: z.boolean(),
});

export async function requestWorkerToolLoadout(
  worker: PiRpcProcess,
  bridge: BranchBridgeIdentity,
  sessionId: string,
  change?: ToolLoadoutChange,
): Promise<ToolLoadoutSnapshot> {
  let result: z.infer<typeof toolLoadout> | "unavailable";
  try {
    const packet = await workerStatusReply(worker, bridge, sessionId, {
      suffix: TOOL_LOADOUT_SUFFIX,
      argument: change && { ...change },
      maxResultBytes: TOOL_LOADOUT_PACKET_LIMIT,
      malformedError: new Error("Pi returned an invalid tool loadout"),
    });
    result =
      packet.unavailable === true && change
        ? "unavailable"
        : toolLoadout.parse(packet);
  } catch {
    // Pi may have applied the change before the receipt was lost. Keep the
    // worker intact and require a new observation before another change.
    if (change)
      throw requestError(
        "Pi did not confirm the tool change. Refresh the loadout.",
        504,
        { code: "PI_RPC_OUTCOME_UNKNOWN", outcomeUnknown: true },
      );
    throw requestError("Pi did not return a complete tool loadout", 502);
  }
  if (result === "unavailable")
    throw requestError(
      "This tool is no longer selectable in Pi. Refresh the loadout.",
      409,
      { code: "TOOL_LOADOUT_TOOL_UNAVAILABLE" },
    );
  return { workerId: bridge.workerId, ...result };
}
