export const TOOL_LOADOUT_SUFFIX = "_tool_loadout";
export const TOOL_LOADOUT_MAX_NAME_CHARS = 512;
export const TOOL_LOADOUT_MAX_DESCRIPTION_CHARS = 768;
export const TOOL_LOADOUT_MAX_SOURCE_CHARS = 256;
export const TOOL_LOADOUT_PACKET_LIMIT = 128 * 1024;

export interface ToolLoadoutChange {
  name: string;
  active: boolean;
}
