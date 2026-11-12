import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ATTACHMENT_CONTEXT_HEADING } from "../../shared/attachment-context.js";
import {
  HISTORY_FIXTURE_SESSION_ID,
  historyFixtureEntries,
} from "./history-session.js";

const now = Date.now();
const COMPACTION_FIXTURE_SESSION_ID = "fixture-compaction";
const ERROR_FIXTURE_SESSION_ID = "fixture-errors";
const RESOURCE_FIXTURE_SESSION_ID = "fixture-resources";
const PROMPT_MAP_FIXTURE_SESSION_ID = "fixture-prompt-map";
export const COPY_FIXTURE_SESSION_ID = "fixture-saved-copy";
export const savedCopy = {
  user: "User source. ".repeat(6000) + "USER_COPY_TAIL",
  response: "Assistant source. ".repeat(4500) + "ASSISTANT_COPY_TAIL",
  final: "Final response fragment.",
  custom: "Custom source. ".repeat(6000) + "CUSTOM_COPY_TAIL",
  details: { note: "Custom details. ".repeat(4500) + "DETAIL_COPY_TAIL" },
};

const mixedFileContext = `${ATTACHMENT_CONTEXT_HEADING}\n- "/workspace/report.md"`;
export const mixedCopySource = [
  "Inspect mixed attachments in report.md.",
  mixedFileContext,
  "[Image: original 2560x133, displayed at 2000x104. Multiply coordinates by 1.28 to map to original image.]",
].join("\n\n");

const richText = `## A compact result

The normalized wave equation is

$$
\\frac{\\partial^2 u}{\\partial t^2}=c^2\\nabla^2u
$$

and the conserved energy is $E=mc^2$ for the familiar relativistic case.

| Quantity | Value |
| --- | ---: |
| Samples | 2,048 |
| Peak frequency | 12.4 Hz |

- [x] Load the signal
- [x] Compute the spectrum
- [ ] Validate the final interpretation

\`\`\`python
frequencies = np.fft.rfftfreq(signal.size, d=1 / sample_rate)
power = np.abs(np.fft.rfft(signal)) ** 2
\`\`\`

See the [Pi documentation](https://pi.dev) for the runtime contract.`;

const initialMessages = [
  {
    role: "user",
    content: "Show me a formula-rich example and inspect the analysis steps.",
    timestamp: now - 30_000,
  },
  {
    role: "assistant",
    content: [
      {
        type: "thinking",
        thinking:
          "I should keep the derivation compact and make every result inspectable.",
      },
      {
        type: "toolCall",
        id: "fixture-tool-1",
        name: "read",
        arguments: { path: "analysis/spectrum.py", offset: 8, limit: 12 },
      },
      { type: "text", text: richText },
    ],
    provider: "workbench",
    model: "offline",
    usage: {
      input: 800,
      output: 420,
      cacheRead: 320,
      cacheWrite: 0,
      totalTokens: 1_540,
      cost: { total: 0 },
    },
    stopReason: "stop",
    timestamp: now - 28_000,
  },
  {
    role: "toolResult",
    toolCallId: "fixture-tool-1",
    toolName: "read",
    content: [
      {
        type: "text",
        text: [
          "def window(samples):",
          "    total = samples.sum()",
          "    scale = 1.0 / len(samples)",
          "    return total * scale",
          "",
          "frequencies = np.fft.rfftfreq(signal.size, d=1 / sample_rate)",
          "power = np.abs(np.fft.rfft(signal)) ** 2",
        ].join("\n"),
      },
    ],
    isError: false,
    timestamp: now - 29_000,
  },
  {
    role: "assistant",
    content: [
      {
        type: "toolCall",
        id: "fixture-tool-2",
        name: "edit",
        arguments: {
          path: "analysis/spectrum.py",
          edits: [
            {
              oldText: "    scale = 1.0 / len(samples)",
              newText: "    scale = 1.0 / max(1, len(samples))",
            },
          ],
        },
      },
      { type: "text", text: "Tightened the window normalization." },
    ],
    provider: "workbench",
    model: "offline",
    usage: {
      input: 900,
      output: 160,
      cacheRead: 620,
      cacheWrite: 0,
      totalTokens: 1_680,
      cost: { total: 0 },
    },
    stopReason: "stop",
    timestamp: now - 26_000,
  },
  {
    role: "toolResult",
    toolCallId: "fixture-tool-2",
    toolName: "edit",
    content: [
      {
        type: "text",
        text: [
          "--- a/analysis/spectrum.py",
          "+++ b/analysis/spectrum.py",
          "@@ -12,7 +12,7 @@ def window(samples):",
          "     total = samples.sum()",
          "-    scale = 1.0 / len(samples)",
          "+    scale = 1.0 / max(1, len(samples))",
          "     return total * scale",
        ].join("\n"),
      },
    ],
    details: {
      patch: [
        "--- a/analysis/spectrum.py",
        "+++ b/analysis/spectrum.py",
        "@@ -12,7 +12,7 @@ def window(samples):",
        "     total = samples.sum()",
        "-    scale = 1.0 / len(samples)",
        "+    scale = 1.0 / max(1, len(samples))",
        "     return total * scale",
      ].join("\n"),
      firstChangedLine: 14,
    },
    isError: false,
    timestamp: now - 25_000,
  },
];

const promptMapFixtureMessages = Array.from({ length: 13 }, (_, index) => {
  const timestamp = now - (13 - index) * 2_000;
  return [
    {
      role: "user",
      content: `Prompt map fixture turn ${index + 1}`,
      timestamp,
    },
    {
      role: "assistant",
      content: `Prompt map fixture response ${index + 1}.`,
      provider: "workbench",
      model: "offline",
      stopReason: "stop",
      timestamp: timestamp + 1,
    },
  ];
}).flat();

const writtenResource =
  "tests/browser/fixtures/file-previews/report%20 draft.md";
const resourceFixtureReferences = [
  ...Array.from(
    { length: 72 },
    (_value, index) =>
      `tests/browser/fixtures/unavailable-resource-${String(index + 1).padStart(3, "0")}.txt`,
  ),
  "tests/browser/fixtures/file-previews/page.html",
  writtenResource,
];

/** A large, deterministic citation set exercises the same list/probe/preview
 * routes as a real session without turning ordinary presentation sessions into
 * an oversized transcript. The two real files stay at the top of Recent. */
const resourceFixtureMessages = [
  {
    role: "assistant",
    content: resourceFixtureReferences.map((path, index) => ({
      type: "toolCall",
      id: `fixture-resource-${index + 1}`,
      name: path === writtenResource ? "write" : "read",
      arguments: { path },
    })),
    provider: "workbench",
    model: "offline",
    stopReason: "stop",
    timestamp: now - 40_000,
  },
];

function messagesForFixture(id: string, image?: string): unknown[] {
  if (id === COPY_FIXTURE_SESSION_ID)
    return [
      {
        role: "user",
        content: [
          { type: "text", text: savedCopy.user },
          { type: "image", mimeType: "image/png", data: image },
        ],
        timestamp: now,
      },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Private reasoning for the test" },
          { type: "text", text: savedCopy.response },
          {
            type: "toolCall",
            id: "copy-tool",
            name: "read",
            arguments: { path: "notes.txt" },
          },
          { type: "text", text: savedCopy.final },
        ],
        timestamp: now,
      },
      {
        role: "custom",
        customType: "copy_fixture",
        content: savedCopy.custom,
        details: savedCopy.details,
        timestamp: now,
      },
      {
        role: "user",
        content: [
          { type: "text", text: mixedCopySource },
          { type: "image", mimeType: "image/png", data: image },
        ],
        timestamp: now,
      },
      {
        role: "user",
        content: [
          { type: "text", text: mixedFileContext },
          { type: "image", mimeType: "image/png", data: image },
        ],
        timestamp: now,
      },
    ];
  if (id === COMPACTION_FIXTURE_SESSION_ID)
    return [
      {
        role: "user",
        content: "Retained request before compaction",
        timestamp: now - 90_000,
      },
      {
        role: "assistant",
        content: "Retained response before compaction",
        timestamp: now - 80_000,
      },
      {
        role: "compactionSummary",
        summary:
          "## Preserved context\n\nKeep the parser decisions and remaining work.",
        tokensBefore: 42_500,
        timestamp: now - 70_000,
      },
      {
        role: "user",
        content: "Next request after compaction",
        timestamp: now - 60_000,
      },
      {
        role: "assistant",
        content: "Next response after compaction",
        timestamp: now - 50_000,
      },
    ];
  if (id === ERROR_FIXTURE_SESSION_ID)
    return [
      {
        role: "user",
        content: "Inspect the interrupted reply.",
        timestamp: now - 3_000,
      },
      {
        role: "assistant",
        timestamp: now - 2_000,
        content: [{ type: "text", text: "Partial output before the failure." }],
        stopReason: "error",
        errorMessage: "WebSocket error",
      },
      {
        role: "assistant",
        timestamp: now - 1_000,
        content: [],
        stopReason: "error",
        errorMessage: `fetch failed\n${"Diagnostic detail: request unavailable. ".repeat(25)}\n<details>原始错误信息</details>`,
      },
    ];
  if (id === RESOURCE_FIXTURE_SESSION_ID) return resourceFixtureMessages;
  if (id === PROMPT_MAP_FIXTURE_SESSION_ID) return promptMapFixtureMessages;
  return initialMessages;
}

function persistedMessage(message: Record<string, unknown>) {
  if (message.role !== "assistant") return message;
  const usage = message.usage as Record<string, unknown> | undefined;
  return {
    api: "openai-completions",
    provider: "workbench",
    model: "offline",
    stopReason: "stop",
    ...message,
    content:
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      ...usage,
      cost: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 0,
        ...(usage?.cost as object),
      },
    },
  };
}

/** Persist ordinary native session files. No simulated runtime or projection is involved. */
export async function seedWorkbenchSessions(
  directory: string,
  cwd: string,
  image?: string,
  rich = true,
) {
  await mkdir(directory, { recursive: true });
  const sessions = [
    [COPY_FIXTURE_SESSION_ID, "Copy saved messages"],
    ["fixture-active", "Formula rendering and spectral analysis"],
    ["fixture-history", "Review extension event lifecycle"],
    ["fixture-branch", "Earlier branch recovery fixture"],
    [HISTORY_FIXTURE_SESSION_ID, "Calibration history fixture"],
    [COMPACTION_FIXTURE_SESSION_ID, "Compaction checkpoint fixture"],
    [ERROR_FIXTURE_SESSION_ID, "Pi error display fixture"],
    [PROMPT_MAP_FIXTURE_SESSION_ID, "Prompt map long-session fixture"],
    [
      RESOURCE_FIXTURE_SESSION_ID,
      "Resource virtualization and sandbox fixture",
    ],
  ] as const;
  for (const [id, name] of sessions.filter(([id]) =>
    id === COPY_FIXTURE_SESSION_ID
      ? rich && image
      : rich || ["fixture-active", "fixture-history"].includes(id),
  )) {
    const sessionCwd =
      !rich && id !== "fixture-active" ? join(cwd, "extension") : cwd;
    await mkdir(sessionCwd, { recursive: true });
    let parentId: string | null = null;
    const entries: unknown[] = [
      {
        type: "session",
        version: 3,
        id,
        cwd: sessionCwd,
        timestamp: new Date(now - 86_400_000).toISOString(),
      },
    ];
    const append = (entry: Record<string, unknown>) => {
      const next = `entry-${entries.length}`;
      entries.push({
        id: next,
        parentId,
        timestamp: new Date(now).toISOString(),
        ...entry,
      });
      parentId = next;
    };
    append({ type: "model_change", provider: "workbench", modelId: "offline" });
    append({ type: "thinking_level_change", thinkingLevel: "medium" });
    if (id === HISTORY_FIXTURE_SESSION_ID) {
      const history = historyFixtureEntries(cwd, image);
      history[0]!.parentId = parentId;
      entries.push(...history);
      parentId = history.at(-1)!.id;
    } else {
      const messages =
        !rich && id !== "fixture-active"
          ? [{ role: "user", content: name, timestamp: now }]
          : messagesForFixture(id, image);
      for (const value of messages) {
        const message = value as Record<string, unknown>;
        if (message.role === "compactionSummary") {
          append({
            type: "compaction",
            summary: message.summary,
            tokensBefore: message.tokensBefore,
            firstKeptEntryId: parentId,
          });
        } else if (message.role === "custom") {
          append({
            type: "custom_message",
            customType: message.customType,
            content: message.content,
            details: message.details,
            display: true,
          });
        } else append({ type: "message", message: persistedMessage(message) });
      }
    }
    append({ type: "session_info", name });
    await writeFile(
      join(directory, `${id}.jsonl`),
      entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
    );
  }
}
