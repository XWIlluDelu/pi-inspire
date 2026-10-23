import { AttachmentStore } from "../../server/attachments.js";

const [root, mode] = process.argv.slice(2);
const store = new AttachmentStore(root, null, { sweepIntervalMs: 0 });
const inputs = [
  {
    originalname: "notes.txt",
    mimetype: "text/plain",
    buffer: Buffer.from("notes"),
  },
  {
    originalname: "image.png",
    mimetype: "image/png",
    buffer: Buffer.from("image"),
  },
];
const uploads = await store.addMany(
  inputs.map((input) => ({
    ...input,
    size: input.buffer.length,
  })) as Express.Multer.File[],
);
if (mode === "prepared")
  await store.resolveForPrompt(uploads.map((upload) => upload.id));
process.stdout.write(JSON.stringify(uploads) + "\n");
// Parent controls the owner lifetime, including exit without AttachmentStore.close().
process.stdin.resume();
