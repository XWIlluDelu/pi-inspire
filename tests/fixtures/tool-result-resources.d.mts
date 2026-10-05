import type { TranscriptPage } from "../../shared/contracts.js";
import type { ToolCallContent } from "../../src/events.js";

/** Data-only boundary: web tests do not import the Host TypeScript project. */
export function toolResultResourcesFixture(): Promise<{
  root: string;
  record: { id: string; path: string; cwd: string; name: string };
  messages: unknown[];
  page: TranscriptPage;
  readCall: ToolCallContent;
  bashCall: ToolCallContent;
  fullOutputPath: string;
  fullOutput: string;
  piVersion: string;
  dispose(): Promise<void>;
}>;
