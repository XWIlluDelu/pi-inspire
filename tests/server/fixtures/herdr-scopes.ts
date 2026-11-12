import { readFile } from "node:fs/promises";
import { assertHerdrWorkerScopesAvailable } from "../../../server/herdr-process-group.js";

export const herdrScopesAvailable =
  process.platform === "linux" &&
  (await assertHerdrWorkerScopesAvailable(process.env).then(
    () => true,
    () => false,
  ));

export async function processCanRun(pid: number): Promise<boolean> {
  try {
    const source = await readFile(`/proc/${pid}/stat`, "utf8");
    const state = source.slice(source.lastIndexOf(")") + 2).split(" ")[0];
    return state !== "Z" && state !== "X";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
