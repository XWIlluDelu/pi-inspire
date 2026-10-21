// Independent conversation boundaries alongside a failed tool: used to check
// disclosure, source copying and compact/touch geometry without a live failure.
export const conversationFeedbackMessages = [
  {
    role: "user",
    content: "继续",
    __inspireEntryId: "feedback-short",
    __inspireMessageId: "feedback-user-short",
  },
  {
    role: "compactionSummary",
    summary:
      "Magic Context compacted: ## Retained context\n\nKeep the current design decisions. Check short messages and failure states on a narrow screen.",
    tokensBefore: 42500,
    __inspireCompactionSource: "magic-context",
    __inspireMessageId: "feedback-magic",
  },
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "feedback-tool",
        name: "workspace_preview",
        arguments: { path: "src/components/Composer.tsx" },
      },
    ],
    __inspireMessageId: "feedback-call",
  },
  {
    role: "toolResult",
    toolCallId: "feedback-tool",
    toolName: "workspace_preview",
    content: [
      {
        type: "text",
        text: "Failed to open the workspace preview.\nConnection refused: http://127.0.0.1:5173/preview\nThe original source files were not changed.",
      },
    ],
    isError: true,
    __inspireMessageId: "feedback-result",
  },
  {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage:
      "fetch failed\nThe provider closed the connection before a response arrived.\n\n" +
      Array.from(
        { length: 8 },
        (_, i) =>
          `Diagnostic line ${i + 1}: request cancelled while waiting for the provider.`,
      ).join("\n"),
    __inspireMessageId: "feedback-error",
  },
  {
    role: "user",
    content:
      "保留已有设计与操作行为。请检查短消息、换行消息以及错误详情在窄屏上的排版，复制与 Fork 应当始终属于同一组操作。",
    __inspireEntryId: "feedback-long",
    __inspireMessageId: "feedback-user-long",
  },
];
