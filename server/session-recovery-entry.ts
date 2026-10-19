import { recoverSessionBundle } from "./session-recovery.js";

const [bundle, ...extra] = process.argv.slice(2);
if (!bundle || extra.length) {
  console.error("Usage: inspire recover-session <bundle-folder>");
  process.exitCode = 1;
} else {
  try {
    const path = await recoverSessionBundle(bundle);
    console.log(`Recovered session: ${path}`);
    console.log(
      "Recovery bundle retained. Remove it after verifying the session.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
