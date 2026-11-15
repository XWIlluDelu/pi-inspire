import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspireCacheDirectory,
  inspireConfigDirectory,
  inspireRuntimeDirectory,
  inspireStateDirectory,
  resolveUserPath,
} from "../../server/platform-paths.mjs";

test("typed paths use Host home syntax and leave shell expressions literal", () => {
  const posix = { platform: "darwin", home: "/Users/Host Name" };
  assert.equal(resolveUserPath("~", "/checkout", posix), "/Users/Host Name");
  assert.equal(
    resolveUserPath("~/研究", "/checkout", posix),
    "/Users/Host Name/研究",
  );
  assert.equal(
    resolveUserPath("~\\notes", "/checkout", posix),
    "/checkout/~\\notes",
  );
  assert.equal(
    resolveUserPath("$HOME/notes", "/checkout", posix),
    "/checkout/$HOME/notes",
  );
  assert.equal(
    resolveUserPath("./~/literal", "/checkout", posix),
    "/checkout/~/literal",
  );
  const windows = { platform: "win32", home: "D:\\Users\\Host Name" };
  assert.equal(
    resolveUserPath("~\\研究", "C:\\checkout", windows),
    "D:\\Users\\Host Name\\研究",
  );
  assert.equal(
    resolveUserPath("~/研究", "C:\\checkout", windows),
    "D:\\Users\\Host Name\\研究",
  );
  assert.equal(
    resolveUserPath("bundle", "C:\\caller", windows),
    "C:\\caller\\bundle",
  );
});

test("uses native Linux XDG directories", () => {
  const options = {
    platform: "linux",
    home: "/home/a",
    environment: {
      XDG_CACHE_HOME: "/cache",
      XDG_CONFIG_HOME: "/config",
      XDG_STATE_HOME: "/state",
      XDG_RUNTIME_DIR: "/run/user/1000",
    },
  };
  assert.equal(inspireConfigDirectory(options), "/config/inspire");
  assert.equal(inspireCacheDirectory(options), "/cache/inspire");
  assert.equal(inspireStateDirectory(options), "/state/inspire");
  assert.equal(inspireRuntimeDirectory(options), "/run/user/1000/inspire");
});

test("ignores relative platform directory overrides", () => {
  const options = {
    platform: "linux",
    home: "/home/a",
    temporary: "/tmp",
    environment: {
      XDG_CONFIG_HOME: "relative-config",
      XDG_CACHE_HOME: "relative-cache",
      XDG_STATE_HOME: "relative-state",
      XDG_RUNTIME_DIR: "relative-runtime",
    },
  };
  assert.equal(inspireConfigDirectory(options), "/home/a/.config/inspire");
  assert.equal(inspireCacheDirectory(options), "/home/a/.cache/inspire");
  assert.equal(inspireStateDirectory(options), "/home/a/.local/state/inspire");
  assert.match(
    inspireRuntimeDirectory(options),
    /^\/tmp\/inspire-[^/]+\/inspire$/u,
  );
});

test("uses native macOS application support", () => {
  const options = { platform: "darwin", environment: {}, home: "/Users/a" };
  assert.equal(
    inspireConfigDirectory(options),
    "/Users/a/Library/Application Support/Inspire",
  );
  assert.equal(
    inspireCacheDirectory(options),
    "/Users/a/Library/Caches/Inspire",
  );
  assert.equal(
    inspireStateDirectory(options),
    "/Users/a/Library/Application Support/Inspire",
  );
});

test("preserves redirected Windows roots after copying case-insensitive exports", () => {
  const options = {
    platform: "win32",
    environment: { AppData: "R:\\Roaming", LocalAppData: "S:\\Local" },
    home: "C:\\Users\\fixture",
    temporary: "C:\\Temp",
  };
  assert.equal(inspireConfigDirectory(options), "R:\\Roaming\\Inspire");
  assert.equal(inspireCacheDirectory(options), "S:\\Local\\Inspire\\Cache");
  assert.equal(inspireStateDirectory(options), "S:\\Local\\Inspire");
  assert.equal(inspireRuntimeDirectory(options), "S:\\Local\\Inspire\\runtime");
  assert.equal(
    inspireConfigDirectory({
      platform: "linux",
      home: "/home/fixture",
      environment: { xdg_config_home: "/wrong-case" },
    }),
    "/home/fixture/.config/inspire",
  );
});
