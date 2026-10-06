import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AttachmentStore,
  addAttachmentContext,
} from "../../server/attachments.js";
import { getAgentDir } from "../../server/pi-runtime.js";

// Each phase runs in a fresh process with an isolated HOME/XDG/Pi directory.
const [phase, fixtureRoot] = process.argv.slice(2);
if (!fixtureRoot) throw new Error("Missing isolated fixture root");
const store = new AttachmentStore(undefined, undefined, { sweepIntervalMs: 0 });
const recordPath = join(fixtureRoot, "accepted.json");
if (phase === "send") {
  const attachment = await store.add({
    originalname: "report with spaces.txt",
    mimetype: "text/plain",
    size: 7,
    buffer: Buffer.from("payload"),
  } as Express.Multer.File);
  const { files } = await store.resolveForPrompt([attachment.id]);
  const path = files[0]!.path;
  const sessionDirectory = join(getAgentDir(), "sessions", "fixture");
  await mkdir(sessionDirectory, { recursive: true });
  const session = join(sessionDirectory, "retained.jsonl");
  await writeFile(
    session,
    [
      { type: "session", version: 3, id: "fixture", cwd: fixtureRoot },
      {
        type: "message",
        id: "u1",
        parentId: null,
        message: {
          role: "user",
          content: addAttachmentContext("Read", [{ kind: "file", path }], []),
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n",
  );
  await store.registerSession(session);
  await store.releaseConsumed([attachment.id], session);
  await writeFile(
    recordPath,
    JSON.stringify({ path, session, name: attachment.fileName }),
  );
  await store.close();
  console.log(JSON.stringify({ path, session, pid: process.pid }));
} else {
  const record = JSON.parse(await readFile(recordPath, "utf8")) as {
    path: string;
    session: string;
    name: string;
  };
  await store.ready();
  if (phase === "delete") await rm(record.session);
  const collection = await store.collectUnreferenced();
  const result =
    phase === "delete"
      ? collection
      : {
          ...collection,
          owns: store.ownsPromptFile(record.path),
          name: store.promptFileName(record.path),
          bytes: await readFile(record.path, "utf8"),
          pid: process.pid,
        };
  await store.close();
  console.log(JSON.stringify(result));
}
