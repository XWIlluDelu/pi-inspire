import { basename } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ToolLoadoutEntry } from "../../shared/contracts.js";
import {
  TOOL_LOADOUT_MAX_DESCRIPTION_CHARS,
  TOOL_LOADOUT_MAX_NAME_CHARS,
  TOOL_LOADOUT_MAX_SOURCE_CHARS,
  TOOL_LOADOUT_PACKET_LIMIT,
  TOOL_LOADOUT_SUFFIX,
} from "../../shared/tool-loadout.js";
import type { BranchBridgeIdentity } from "../runtime-slot.js";
import { registerWorkerStatusCommand } from "./worker-status-command.js";

export function registerToolLoadoutBridge(
  pi: ExtensionAPI,
  owner: BranchBridgeIdentity,
): void {
  registerWorkerStatusCommand(
    pi,
    owner,
    {
      suffix: TOOL_LOADOUT_SUFFIX,
      description: "tool loadout",
      resultLimit: TOOL_LOADOUT_PACKET_LIMIT,
    },
    (request, _ctx, emit) => {
      const inventory = pi.getAllTools();
      let active = new Set(pi.getActiveTools());
      if (request.name !== undefined || request.active !== undefined) {
        const { name, active: enabled } = request;
        if (
          typeof name !== "string" ||
          name.length === 0 ||
          name.length > TOOL_LOADOUT_MAX_NAME_CHARS ||
          typeof enabled !== "boolean"
        )
          throw new Error("Invalid tool loadout change");
        const target = inventory.find((tool) => tool.name === name);
        if (!target || target.exposure === "hidden") {
          emit({ unavailable: true });
          return;
        }
        // Read, merge, and write in the same handler without yielding to a
        // competing browser edit or an extension's own change.
        if (active.has(name) !== enabled) {
          if (enabled) active.add(name);
          else active.delete(name);
          pi.setActiveTools([...active]);
          active = new Set(pi.getActiveTools());
        }
      }

      const tools: ToolLoadoutEntry[] = [];
      // Account for the base64url frame and reserve space for owner fields.
      const budget = (TOOL_LOADOUT_PACKET_LIMIT * 3) / 4 - 2_048;
      let bytes = 0;
      for (const { name, description, exposure, sourceInfo } of inventory) {
        // A display label suffices for source identity and keeps local absolute
        // paths and package URLs out of this response.
        const { source, path } = sourceInfo;
        if (name.length === 0 || name.length > TOOL_LOADOUT_MAX_NAME_CHARS)
          continue;
        const tool = {
          name,
          description: description.slice(0, TOOL_LOADOUT_MAX_DESCRIPTION_CHARS),
          source: (source === "builtin" || source.startsWith("npm:")
            ? source
            : basename(path) || source
          ).slice(0, TOOL_LOADOUT_MAX_SOURCE_CHARS),
          exposure,
          active: active.has(name),
        };
        bytes += Buffer.byteLength(JSON.stringify(tool)) + 1;
        if (bytes > budget) break;
        tools.push(tool);
      }
      emit({ tools, truncated: tools.length < inventory.length });
    },
  );
}
