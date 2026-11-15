import { AttachmentStore } from "../../server/attachments.js";

const [root] = process.argv.slice(2);
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
  [...inputs, ...inputs].map((input) => ({
    ...input,
    size: input.buffer.length,
  })) as Express.Multer.File[],
);
await store.resolveForPrompt(uploads.slice(inputs.length).map(({ id }) => id));
process.stdout.write(JSON.stringify(uploads) + "\n");
// Parent controls the owner lifetime, including exit without AttachmentStore.close().
process.stdin.resume();
