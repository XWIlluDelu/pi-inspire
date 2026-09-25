import { z } from "zod";

// Framing applies only to authenticated startup, never to Pi's steady-state
// conversation stream. The same bounded primitive serves Herdr control RPC.
export {
  readLocalJsonLine as readHerdrBridgeRecord,
  writeLocalJsonLine as writeHerdrBridgeRecord,
} from "./local-json-line.js";

export const HERDR_BRIDGE_VERSION = 1;

export const herdrLaunchTicketSchema = z
  .object({
    version: z.literal(HERDR_BRIDGE_VERSION),
    address: z.string().min(1).max(4_096),
    token: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();

export const herdrBridgeHelloSchema = z
  .object({
    version: z.literal(HERDR_BRIDGE_VERSION),
    token: z.string().regex(/^[a-f0-9]{64}$/u),
    channel: z.enum(["rpc", "stderr"]),
    pid: z.number().int().min(2),
  })
  .strict();

export const herdrLaunchGrantSchema = z
  .object({
    executable: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().min(1),
    env: z.record(z.string(), z.string()),
  })
  .strict();

export const herdrBridgeReadySchema = z
  .object({
    pid: z.number().int().min(2),
  })
  .strict();
