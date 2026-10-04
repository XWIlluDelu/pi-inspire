import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Real installed catalog and native availability, with synthetic fixture-only keys. No model requests. */
export async function loadModelScale(agentDir: string) {
  await mkdir(agentDir, { recursive: true });
  const [{ modelOption }, { ModelRuntime }] = await Promise.all([
    import("../../../server/model-catalog"),
    import("../../../server/pi-runtime"),
  ]);
  const native = await ModelRuntime.create({
    modelsPath: join(agentDir, "models.json"),
    authPath: join(agentDir, "auth.json"),
    refreshOnCreate: false,
  });
  const catalog = native.getModels().map(modelOption);
  const counts = new Map<string, number>();
  for (const model of catalog)
    counts.set(model.provider, (counts.get(model.provider) ?? 0) + 1);
  const credentials: Record<string, { type: "api_key"; key: string }> = {};
  let count = 0;
  for (const [provider, size] of [...counts].sort(
    (left, right) => right[1] - left[1],
  )) {
    credentials[provider] = {
      type: "api_key",
      key: "synthetic-models-scale-key-not-requested",
    };
    count += size;
    if (count >= 1100) break;
  }
  await writeFile(join(agentDir, "auth.json"), JSON.stringify(credentials), {
    mode: 0o600,
  });
  await native.refresh();
  return { catalog, available: (await native.getAvailable()).map(modelOption) };
}
