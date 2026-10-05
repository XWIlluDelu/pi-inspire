import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { piInstallation } from "../../server/pi-installation.ts";
import { SessionProjection } from "../../server/session-projection.ts";

/** Offline native results persisted through the real Host projection boundary.
 * No agent, provider request, account or user configuration is involved. */
export async function toolResultResourcesFixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "inspire-tool-resources-")),
  );
  const cwd = join(root, "project");
  const imagePath = join(cwd, "preview.png");
  let fullOutputPath;
  let projection;
  const dispose = async () => {
    await projection?.close();
    if (fullOutputPath) await rm(fullOutputPath, { force: true });
    await rm(root, { recursive: true, force: true });
  };
  try {
    await mkdir(cwd);
    await writeFile(
      imagePath,
      await readFile(
        resolve("tests/browser/fixtures/file-previews/training curve.png"),
      ),
    );
    const readCall = {
      type: "toolCall",
      id: "read-image",
      name: "read",
      arguments: { path: "preview.png" },
    };
    const bashCall = {
      type: "toolCall",
      id: "bash-output",
      name: "bash",
      arguments: {
        command:
          "for ((i=1;i<=2500;i++)); do printf 'native line %s\\n' \"$i\"; done",
      },
    };
    const read = await piInstallation.sdk
      .createReadTool(cwd)
      .execute(readCall.id, readCall.arguments);
    const bash = await piInstallation.sdk
      .createBashTool(cwd, {
        spawnHook: (context) => ({
          ...context,
          env: { PATH: process.env.PATH, HOME: root, LANG: "C.UTF-8" },
        }),
      })
      .execute(bashCall.id, bashCall.arguments);
    fullOutputPath = bash.details.fullOutputPath;
    if (!fullOutputPath)
      throw new Error("Native Bash fixture did not record a full-output log");
    const path = join(root, "session.jsonl");
    const id = "tool-result-resources";
    const messages = [
      {
        role: "user",
        content: "Inspect this image and shell output.",
        timestamp: 1,
      },
      {
        role: "assistant",
        content: [readCall, bashCall],
        timestamp: 2,
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolName: "read",
        toolCallId: readCall.id,
        ...read,
        timestamp: 3,
      },
      {
        role: "toolResult",
        toolName: "bash",
        toolCallId: bashCall.id,
        ...bash,
        timestamp: 4,
      },
    ];
    await writeFile(
      path,
      [
        {
          type: "session",
          version: 3,
          id,
          cwd,
          timestamp: "2026-10-03T00:00:00.000Z",
        },
        ...messages.map((message, index) => ({
          type: "message",
          id: `entry-${index}`,
          parentId: index === 0 ? null : `entry-${index - 1}`,
          timestamp: new Date(index + 1).toISOString(),
          message,
        })),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const record = {
      id,
      path,
      cwd,
      name: "Saved tool resources",
      source: null,
      created: new Date(),
      modified: new Date(),
      messageCount: messages.length,
      firstMessage: "Inspect this image and shell output.",
      searchText: "",
    };
    projection = await SessionProjection.open(record);
    const page = projection.latestPage([], undefined, "tool-resources-view");
    return {
      root,
      record,
      messages: [...projection.messages],
      page,
      readCall,
      bashCall,
      fullOutputPath,
      fullOutput: await readFile(fullOutputPath, "utf8"),
      piVersion: piInstallation.version,
      dispose,
    };
  } catch (error) {
    await dispose();
    throw error;
  }
}
