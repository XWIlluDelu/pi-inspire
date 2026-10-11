import { stripVTControlCharacters } from "node:util";

const MAX_DIAGNOSTICS = 3;
const MAX_PATH_CHARS = 300;

/** Recognize Pi's CLI diagnostics, not arbitrary child logging. Only resource
 * identity and fixed guidance cross into browser errors; exception text may
 * contain credentials, source excerpts or other private process output. */
export function piStartupDiagnostics(stderr: string): {
  failures: string[];
  warnings: string[];
} {
  const failures = new Set<string>();
  const warnings = new Set<string>();
  for (const line of stripVTControlCharacters(stderr).split(/\r?\n/)) {
    const extension = /^Error: Failed to load extension "([^"\r\n]+)": /.exec(
      line,
    );
    if (extension && failures.size < MAX_DIAGNOSTICS) {
      failures.add(
        `Could not load Pi extension "${boundedPath(extension[1]!)}". Repair or disable it in Pi, then retry. Native error details are in the Host log.`,
      );
    }
    const settings =
      /^Warning: Invalid settings file (.+?settings\.json): /.exec(line);
    if (settings && warnings.size < MAX_DIAGNOSTICS) {
      warnings.add(
        `Pi could not read settings from "${boundedPath(settings[1]!)}". Repair this file and Reload the session; changes may apply only in memory until then.`,
      );
    }
  }
  return { failures: [...failures], warnings: [...warnings] };
}

function boundedPath(path: string): string {
  const clean = path.replace(/[\x00-\x1f\x7f]/g, "");
  return clean.length > MAX_PATH_CHARS
    ? `…${clean.slice(-MAX_PATH_CHARS)}`
    : clean;
}
