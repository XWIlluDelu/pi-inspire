import type { ToolPresentationConfiguration } from "../../../shared/tool-presentation-config";
import type { ChatMessage } from "../../../src/events";

export const customMessageConfiguration: ToolPresentationConfiguration = {
  version: 1,
  rules: {},
  mappings: {},
  customMessages: {
    intercom_message: {
      source: "Intercom",
      title: ["details.from.name", "details.from.id"],
      body: "details.bodyText",
      requireAbsent: ["details.message.crossMachine"],
    },
  },
};

export const intercomBody = `## Composer review ready

Expanded editing now preserves **the current draft and attachments**. The focused checks passed; the changes remain in the workspace for review.

- History is independent of compaction.
- Refresh restores text drafts without submitting them.
- 窄屏编辑保留当前上下文，键盘焦点回到输入框。

| Surface | Result |
| --- | --- |
| Desktop | Context stays visible |
| Narrow | Editor fits the available width |

\`src/components/session-workbench/composer/ExpandedComposerEditor.tsx\` stays inspectable in [the review guide](https://example.org/review).

\`\`\`ts
const draft = { text: "Keep the exact message", attachments: [] };
\`\`\`

Please review the **final paragraph** as well as the header.`;

export function incomingIntercom(bodyText = intercomBody): ChatMessage {
  const from = {
    id: "21b2937f-1111-2222-3333-444444444444",
    name: "Inspire: composer editing",
    cwd: "/home/reviewer/projects/inspire",
  };
  const message = {
    id: "8e6f75ae-8677-ba8f-5ca4-239512345678",
    text: bodyText,
    seq: 42,
    timestamp: 1_900_000_000_000,
    brokerReceivedAt: 1_900_000_000_010,
    receivedAt: 1_900_000_000_020,
    injectedAt: 1_900_000_000_030,
  };
  const replyCommand =
    'intercom({ action: "send", to: "21b2937f", message: "..." })';
  return {
    role: "custom",
    customType: "intercom_message",
    display: true,
    timestamp: 1_900_000_000_040,
    __inspireMessageId: "custom-message-review",
    content: `**From ${from.name}** (${from.cwd})\n\nTo reply, use the intercom tool: ${replyCommand}\n\n_Message ${message.id} · seq 42 · sent 2030-03-17T17:46:40.000Z · broker 2030-03-17T17:46:40.010Z · received 2030-03-17T17:46:40.020Z · injected 2030-03-17T17:46:40.030Z_\n\n${bodyText}`,
    details: { from, message, replyCommand, bodyText },
  };
}
