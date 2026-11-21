import { spawn } from "node:child_process";
import { once } from "node:events";
import { win32 } from "node:path";
import { environmentValue } from "./platform-environment.mjs";

async function launch(command, args, spawnDetached) {
  const child = spawnDetached(command, args, {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  const [code, signal] = await once(child, "exit");
  if (code !== 0) {
    const reason = signal ? `ended with ${signal}` : `exited with status ${code}`;
    throw Object.assign(
      new Error(`Desktop browser opener ${reason}`),
      { code: signal ?? `EXIT_${code}` },
    );
  }
}

/** The launcher and the Host use the same OS opener for a fresh pairing URL. */
export async function openBrowser(
  url,
  platform = process.platform,
  spawnDetached = spawn,
  environment = process.env,
) {
  if (platform === "darwin") return launch("open", [url], spawnDetached);
  if (platform === "win32") {
    const root = environmentValue(environment, "SystemRoot", platform);
    const command = root ? win32.join(root, "System32", "rundll32.exe") : "rundll32.exe";
    return launch(command, ["url.dll,FileProtocolHandler", url], spawnDetached);
  }
  try {
    await launch("xdg-open", [url], spawnDetached);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await launch("gio", ["open", url], spawnDetached);
  }
}
