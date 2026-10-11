import { incomingIntercom } from "./custom-message-presentation";

// A reading sequence for shared activity-header, nested-tool, fallback and
// extension-message regressions. Outcomes remain native records, not summaries.
export function activityReadingMessages() {
  return [
    {
      role: "user",
      content: [
        {
          type: "text",
          text: "Review the pending changes and check that keyboard navigation still works.",
        },
      ],
      __inspireMessageId: "reading-user",
    },
    {
      role: "assistant",
      __inspireMessageId: "reading-assistant-1",
      content: [
        {
          type: "thinking",
          thinking:
            "Reviewing the changed components\n\nI will check the interaction boundaries, then verify the focused regression tests.",
        },
        {
          type: "toolCall",
          id: "reading-code",
          name: "codemode",
          arguments: {
            code: 'text(await tools.read({path: "src/components/Composer.tsx"})); text(await tools.bash({command: "npm run typecheck"}));',
          },
        },
      ],
    },
    {
      role: "toolResult",
      __inspireMessageId: "reading-code-result",
      toolCallId: "reading-code",
      toolName: "codemode",
      isError: false,
      content: [
        {
          type: "text",
          text: "Script completed\nWall time 2.3 seconds\nOutput:\n",
        },
        {
          type: "text",
          text: '{"typecheck":"passed","components":["Composer","CustomMessage"],"output":"Checked keyboard focus and copy ownership.\\nNo type errors."}',
        },
      ],
      details: {
        calls: [
          {
            id: "reading-child-1",
            name: "read",
            args: '{"path":"src/components/Composer.tsx"}',
            status: "ok",
          },
          {
            id: "reading-child-2",
            name: "bash",
            args: '{"command":"npm run typecheck"}',
            status: "ok",
            durationMs: 1800,
          },
        ],
      },
    },
    {
      role: "assistant",
      __inspireMessageId: "reading-assistant-2",
      content: [
        {
          type: "thinking",
          thinking:
            "Checking the external preview\n\nThe local checks passed. The preview service has a separate result.",
        },
        {
          type: "toolCall",
          id: "reading-preview",
          name: "preview_check",
          arguments: { target: "workspace", checks: ["keyboard", "layout"] },
        },
      ],
    },
    {
      role: "toolResult",
      __inspireMessageId: "reading-preview-result",
      toolCallId: "reading-preview",
      toolName: "preview_check",
      isError: true,
      content: [
        {
          type: "text",
          text: "Preview service unavailable. The local checks are unaffected.",
        },
      ],
      details: { status: 503, retryAfter: 30 },
    },
    incomingIntercom(
      "### Review notes\n\nThe keyboard checks are complete. **Copy stays independent of disclosure.**\n\n- Preserve the current draft when switching sessions.\n- Keep long tool paths readable on a narrow screen.",
    ),
    {
      role: "assistant",
      __inspireMessageId: "reading-answer",
      content: [
        {
          type: "text",
          text: "The local checks passed. The external preview is unavailable; its error is retained above.",
        },
      ],
    },
  ];
}
