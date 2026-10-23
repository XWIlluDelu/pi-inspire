import type { ToolPresentationConfiguration } from "../../../shared/tool-presentation-config";

export const checkpointAdapterConfiguration: ToolPresentationConfiguration = {
  version: 1,
  rules: {},
  mappings: {},
  checkpoints: [
    {
      source: "magic-context",
      title: "Magic Context compacted",
      summaryPrefix: "Magic Context compacted:",
      legacySummaryPrefix: "Magic Context compacted",
      tokensLabel: "History chunk",
      tokensDescription:
        "Estimated tokens in the history chunk sent to Magic Context for processing.",
    },
  ],
};
