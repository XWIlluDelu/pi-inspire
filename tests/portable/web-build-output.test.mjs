import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { publishWebBuild } from "../../scripts/web-build-output.mjs";

const temporaryDirectories = [];

async function directory(prefix) {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function put(root, relativePath, content) {
  const path = join(root, relativePath);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function missing(path) {
  await assert.rejects(stat(path), { code: "ENOENT" });
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("web build publication", () => {
  it("switches staged output while retaining one outgoing executable generation", async () => {
    const dist = await directory("inspire-published-dist-");
    const firstStaging = await directory("inspire-staged-web-");
    await put(dist, "index.html", "old index\n");
    await put(dist, "assets/ContextPane-old.js", "old context\n");
    await put(dist, "assets/common-old.css", "old css\n");
    await put(dist, "assets/obsolete-old.png", "old image\n");
    await put(firstStaging, "index.html", "first index\n");
    await put(firstStaging, "theme-init.js", "first theme\n");
    await put(firstStaging, "assets/index-first.js", "first main\n");
    await put(firstStaging, "assets/logo-first.png", "first image\n");

    assert.deepEqual(await publishWebBuild(firstStaging, dist), {
      currentAssets: 2,
      retainedOutgoingAssets: 2,
      cleanupFailures: 0,
    });
    assert.equal(
      await readFile(join(dist, "index.html"), "utf8"),
      "first index\n",
    );
    assert.equal(
      await readFile(join(dist, "theme-init.js"), "utf8"),
      "first theme\n",
    );
    assert.equal(
      await readFile(join(dist, "assets", "ContextPane-old.js"), "utf8"),
      "old context\n",
    );
    await missing(join(dist, "assets", "obsolete-old.png"));

    const secondStaging = await directory("inspire-staged-web-");
    await put(secondStaging, "index.html", "second index\n");
    await put(secondStaging, "theme-init.js", "second theme\n");
    await put(secondStaging, "assets/index-second.js", "second main\n");

    assert.deepEqual(await publishWebBuild(secondStaging, dist), {
      currentAssets: 1,
      retainedOutgoingAssets: 1,
      cleanupFailures: 0,
    });
    assert.equal(
      await readFile(join(dist, "assets", "index-first.js"), "utf8"),
      "first main\n",
    );
    await missing(join(dist, "assets", "ContextPane-old.js"));
    assert.equal(
      await readFile(join(dist, "index.html"), "utf8"),
      "second index\n",
    );
  });

  it("omits the outgoing generation from a clean release build", async () => {
    const dist = await directory("inspire-clean-dist-");
    const staging = await directory("inspire-clean-staging-");
    await put(dist, "index.html", "old index\n");
    await put(dist, "assets/index-old.js", "old main\n");
    await put(dist, "legacy-worker.js", "old worker\n");
    await put(staging, "index.html", "new index\n");
    await put(staging, "assets/index-new.js", "new main\n");

    assert.deepEqual(
      await publishWebBuild(staging, dist, { retainOutgoing: false }),
      {
        currentAssets: 1,
        retainedOutgoingAssets: 0,
        cleanupFailures: 0,
      },
    );
    await missing(join(dist, "assets", "index-old.js"));
    await missing(join(dist, "legacy-worker.js"));
    assert.equal(
      await readFile(join(dist, "assets", "index-new.js"), "utf8"),
      "new main\n",
    );
  });

  it("publishes the first build when dist does not exist", async () => {
    const parent = await directory("inspire-first-dist-");
    const dist = join(parent, "dist");
    const staging = await directory("inspire-first-staging-");
    await put(staging, "index.html", "first index\n");
    await put(staging, "assets/index-first.js", "first main\n");

    assert.deepEqual(await publishWebBuild(staging, dist), {
      currentAssets: 1,
      retainedOutgoingAssets: 0,
      cleanupFailures: 0,
    });
    assert.equal(
      await readFile(join(dist, "index.html"), "utf8"),
      "first index\n",
    );
    assert.equal(
      await readFile(join(dist, "assets", "index-first.js"), "utf8"),
      "first main\n",
    );
  });
});
