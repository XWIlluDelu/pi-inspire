import { existsSync } from "node:fs";
import {
  link,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { piInstallation, SessionManager } from "../../server/pi-runtime.js";
import {
  assertExportDestination,
  serializeBranchExport,
} from "../../server/session-export.js";
import { exportArgumentPath } from "../../shared/commands.js";
import type { HostNativeCommandResponse } from "../../shared/contracts.js";
import { nativeSessionWorkbench } from "./fixtures/native-session-workbench.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup.length = 0;
  vi.unstubAllEnvs();
});

const fixture = (options = {}) => nativeSessionWorkbench(cleanup, options);

it("exports a saved branch with an unavailable workspace without launching Pi", async () => {
  const f = await fixture({ openSource: false });
  await rm(f.workspace, { recursive: true });
  await f.runtime.openSession(f.id);
  expect((await f.runtime.snapshot(f.id)).active?.readOnlyReason).toBe(
    "workspace-unavailable",
  );
  const response = await fetch(`${f.url}/api/sessions/export`, {
    method: "POST",
    headers: f.headers,
    body: JSON.stringify({ sessionId: f.id, format: "jsonl" }),
  });
  expect(response.status).toBe(200);
  const result = (await response.json()) as {
    downloadId: string;
  };
  const downloaded = await fetch(
    `${f.url}/api/sessions/${f.id}/exports/${result.downloadId}`,
    {
      headers: f.headers,
    },
  );
  expect(downloaded.status).toBe(200);
  const content = await downloaded.text();
  expect(content).toContain("Current branch only");
  expect(content).toContain('"type":"image"');
  expect(content).not.toContain("Other branch only");
  expect(f.workers).toHaveLength(0);
});

it.skipIf(
  !existsSync(join(piInstallation.packageRoot, "dist/core/session-export.js")),
)(
  "matches the installed native branch serializer and preserves the source through HTML/JSONL/downloads",
  async () => {
    const f = await fixture();
    const state = await f.workers[0]!.request({ type: "get_state" });
    const before = await readFile(f.path, "utf8");
    const native = (await import(
      pathToFileURL(
        join(piInstallation.packageRoot, "dist/core/session-export.js"),
      ).href
    )) as { serializeSessionBranch(manager: unknown): string };
    const expected = native.serializeSessionBranch(SessionManager.open(f.path));
    const rpc = vi.spyOn(f.workers[0]!, "request");
    const response = await fetch(`${f.url}/api/control/native-command`, {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify({
        sessionId: f.id,
        command: "export",
        argument: '"exports/branch copy.jsonl"',
      }),
    });
    expect(response.status).toBe(200);
    expect(rpc).toHaveBeenCalledWith({
      type: "get_entries",
      since: "00000007",
    });
    const result = (await response.json()) as HostNativeCommandResponse;
    expect(result.export).toMatchObject({
      format: "jsonl",
      fileName: "branch copy.jsonl",
    });
    const content = await readFile(
      join(f.workspace, "exports/branch copy.jsonl"),
      "utf8",
    );
    const parsed = (text: string) =>
      text
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    const actual = parsed(content),
      reference = parsed(expected);
    expect({ ...actual[0], timestamp: null }).toEqual({
      ...reference[0],
      timestamp: null,
    });
    expect(actual.slice(1)).toEqual(reference.slice(1));
    expect(content).not.toContain("Other branch only");
    expect(content).toContain("image/png");
    expect(content).toContain("excludeFromContext");
    const download = `${f.url}/api/sessions/${f.id}/exports/${result.export!.downloadId}`;
    expect((await fetch(download)).status).toBe(401);
    expect(
      (
        await fetch(download.replace(f.id, "another-session"), {
          headers: f.headers,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await fetch(`${f.url}/api/sessions/${f.id}/exports/../../etc/passwd`, {
          headers: f.headers,
        })
      ).status,
    ).not.toBe(200);
    await writeFile(result.export!.path, "Replaced export file");
    const fetched = await fetch(download, { headers: f.headers });
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-disposition")).toContain("attachment;");
    expect(fetched.headers.get("content-security-policy")).toBe("sandbox");
    expect(await fetched.text()).toBe(content);
    const html = await fetch(`${f.url}/api/control/native-command`, {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify({ sessionId: f.id, command: "export" }),
    });
    expect(html.status).toBe(200);
    const htmlResult = (await html.json()) as HostNativeCommandResponse;
    expect(htmlResult.export?.format).toBe("html");
    const htmlContent = await readFile(htmlResult.export!.path, "utf8");
    const embedded =
      /<script id="session-data" type="application\/json">([^<]+)<\/script>/u.exec(
        htmlContent,
      )?.[1];
    expect(embedded).toBeTruthy();
    const htmlData = Buffer.from(embedded!, "base64").toString("utf8");
    expect(htmlData).toContain("Other branch only");
    expect(htmlData).toContain("Current branch only");
    const workspaceFiles = await readdir(f.workspace, { recursive: true });
    for (const format of ["html", "jsonl"]) {
      const exported = await fetch(`${f.url}/api/sessions/export`, {
        method: "POST",
        headers: f.headers,
        body: JSON.stringify({ sessionId: f.id, format }),
      });
      expect(exported.status).toBe(200);
      const file = (await exported.json()) as {
        downloadId: string;
        fileName: string;
      };
      expect(file.fileName.endsWith(`.${format}`)).toBe(true);
      const downloaded = await fetch(
        `${f.url}/api/sessions/${f.id}/exports/${file.downloadId}`,
        { headers: f.headers },
      );
      expect(downloaded.status).toBe(200);
      const text = await downloaded.text();
      if (format === "jsonl")
        expect(parsed(text).slice(1)).toEqual(reference.slice(1));
      else {
        const data =
          /<script id="session-data" type="application\/json">([^<]+)<\/script>/u.exec(
            text,
          )?.[1];
        expect(Buffer.from(data!, "base64").toString("utf8")).toContain(
          "Other branch only",
        );
      }
    }
    expect(await readdir(f.workspace, { recursive: true })).toEqual(
      workspaceFiles,
    );
    expect(await readFile(f.path, "utf8")).toBe(before);
    expect(await f.workers[0]!.request({ type: "get_state" })).toEqual(state);
    const overwrite = await fetch(`${f.url}/api/control/native-command`, {
      method: "POST",
      headers: f.headers,
      body: JSON.stringify({
        sessionId: f.id,
        command: "export",
        argument: f.path,
      }),
    });
    expect(overwrite.status).toBe(400);
    expect(await readFile(f.path, "utf8")).toBe(before);
    const changelog = await fetch(`${f.url}/api/pi/changelog`, {
      headers: f.headers,
    });
    expect(await changelog.json()).toMatchObject({
      version: piInstallation.version,
      markdown: expect.stringContaining(`## [${piInstallation.version}]`),
    });
  },
  30_000,
);

// Use the real-Pi integration budget, including cold native startup.
it("exports native in-memory entries before a new session materializes", async () => {
  const f = await fixture({ openSource: false });
  const snapshot = await f.runtime.newSession(f.workspace, {
    name: "Deferred export",
  });
  expect(f.workers).toHaveLength(1);
  expect(existsSync(snapshot.active!.sessionFile!)).toBe(false);
  const result = await f.runtime.nativeCommand({
    sessionId: snapshot.active!.sessionId,
    command: "export",
    argument: "deferred.jsonl",
  });
  const exported = await readFile(result.export!.path, "utf8");
  expect(exported).toContain('"name":"Deferred export"');
  expect(exported).toContain(snapshot.active!.sessionId);
  expect(existsSync(snapshot.active!.sessionFile!)).toBe(false);
}, 30_000);

describe("native path and branch boundaries", () => {
  it("uses one native path token and rejects incomplete branch projections", () => {
    expect(exportArgumentPath()).toBeUndefined();
    expect(exportArgumentPath("report.jsonl extra ignored")).toBe(
      "report.jsonl",
    );
    expect(exportArgumentPath('"with space.jsonl" ignored')).toBe(
      "with space.jsonl",
    );
    expect(exportArgumentPath('"unfinished')).toBeUndefined();
    expect(() =>
      serializeBranchExport("id", "/tmp", { entries: [], leafId: "missing" }),
    ).toThrow("incomplete");
  });
  it("refuses canonical source paths, symlinks, and hardlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "inspire-export-path-"));
    cleanup.push(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "session.jsonl");
    await writeFile(path, "source");
    await symlink(path, join(directory, "alias.jsonl"));
    await link(path, join(directory, "hard.jsonl"));
    for (const target of [
      path,
      join(directory, "alias.jsonl"),
      join(directory, "hard.jsonl"),
    ])
      await expect(assertExportDestination(target, path)).rejects.toThrow(
        "source Pi session",
      );
    await expect(
      assertExportDestination(join(directory, "export.jsonl"), path),
    ).resolves.toBeUndefined();
  });
});
