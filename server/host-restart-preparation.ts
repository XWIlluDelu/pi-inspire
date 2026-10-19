import { spawn } from "node:child_process";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";

export function prepareHostRestart(root: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(root, "inspire.mjs"), "prepare-restart"],
      {
        cwd: root,
        env: { ...process.env, INSPIRE_OPEN: "0", INSPIRE_QUIET: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let detail = "";
    const collect = (chunk: Buffer) => {
      detail = (detail + chunk.toString("utf8")).slice(-4_000);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.once("error", () =>
      reject(
        new Error(
          "Restart preparation could not start. The Host was not stopped.",
        ),
      ),
    );
    child.once("close", (code) => {
      if (code === 0) return resolve();
      // Bounded compiler/import diagnostics only; preparation never opens
      // a session or runs extensions. No credentials or request bodies added.
      const reason = stripVTControlCharacters(detail).trim();
      reject(
        new Error(
          `Restart preparation failed. The Host was not stopped.${reason ? `\n${reason}` : ""}`,
        ),
      );
    });
  });
}
