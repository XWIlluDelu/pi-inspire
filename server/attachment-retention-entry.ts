import { trustSessionDirectory } from "./attachment-retention-identity.js";

const [action, directory, ...flags] = process.argv.slice(2);
if (
  action !== "trust-session-directory" ||
  !directory ||
  flags.some(
    (flag) => flag !== "--confirm" && flag !== "--accept-replacement",
  ) ||
  new Set(flags).size !== flags.length ||
  (flags.includes("--accept-replacement") && !flags.includes("--confirm"))
) {
  console.error(
    "Usage: inspire uploads trust-session-directory <absolute-path> [--confirm [--accept-replacement]]",
  );
  console.error(
    "Preview makes no changes. --confirm asserts that the complete original session and Trash references are available; mistaken trust may release uploads. Stop all affected Hosts first.",
  );
  process.exitCode = 1;
} else {
  const confirm = flags.includes("--confirm");
  if (confirm)
    console.error(
      "You confirm this directory contains the complete original session and Trash references that must be retained. Trusting incomplete or replacement storage may release uploaded files.",
    );
  try {
    const plan = await trustSessionDirectory(directory, {
      confirm,
      acceptReplacement: flags.includes("--accept-replacement"),
    });
    console.log(
      `${confirm ? "Trusted" : "Preview"} session directory: ${plan.directory}`,
    );
    console.log(
      `Affected retained upload registries: ${plan.registries.length}`,
    );
    for (const path of plan.registries) console.log(`  ${path}`);
    console.log(
      "Previous identities: " + JSON.stringify(plan.expectedIdentities),
    );
    console.log("Current volume: " + JSON.stringify(plan.currentVolume));
    if (plan.requiresReplacement && !confirm)
      console.log(
        "Replacement differs: add --confirm --accept-replacement only after verifying the complete original session AND native Trash references.",
      );
    if (confirm)
      console.log(
        "Storage continuity recorded. Hosts may now be started; attachment collection can retry.",
      );
    else {
      console.log(
        "No files changed. Stop every affected Host before retrying with --confirm.",
      );
      console.log(
        "Confirm only when this directory contains the complete original session and Trash references that must be retained.",
      );
      console.log(
        "Trusting incomplete or replacement storage may release uploaded files.",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
