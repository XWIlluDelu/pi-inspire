import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { defaultPreferences, type InspirePreferences } from "../shared/contracts.js";

const preferencesSchema = z.object({
  theme: z.enum(["system", "light", "dark"]),
  launch: z.enum(["welcome", "continue"]),
  thinkingVisibility: z.enum(["hidden", "collapsed", "expanded"]),
  toolVisibility: z.enum(["hidden", "collapsed", "expanded"]),
  readingSerif: z.boolean(),
});

export class PreferencesStore {
  readonly path: string;

  constructor(path = join(homedir(), ".config", "inspire", "preferences.json")) {
    this.path = path;
  }

  async read(): Promise<InspirePreferences> {
    try {
      const parsed = preferencesSchema.safeParse(JSON.parse(await readFile(this.path, "utf8")));
      return parsed.success ? parsed.data : defaultPreferences;
    } catch {
      return defaultPreferences;
    }
  }

  async write(value: unknown): Promise<InspirePreferences> {
    const preferences = preferencesSchema.parse(value);
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.path);
    return preferences;
  }
}
