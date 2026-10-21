const [parent, protocol] = process.argv.slice(2);
if (!parent) throw new Error("Missing owned lock fixture parent");
// Other native platforms already use the portable lock/birth protocol.
if (protocol === "portable" && process.platform === "linux")
  Object.defineProperty(process, "platform", { value: "darwin" });
const { withRetentionMaintenance } = await import(
  "../../server/attachment-retention-identity.js"
);
await withRetentionMaintenance(parent, async () => {
  process.stdout.write("locked\n");
  setInterval(() => undefined, 1000);
  await new Promise(() => undefined);
});
