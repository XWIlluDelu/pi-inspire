import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspireCacheDirectory,
  inspireConfigDirectory,
  inspireRuntimeDirectory,
  inspireStateDirectory,
  resolveUserPath,
  supportsPosixPermissions,
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
  const environment = {
    XDG_CACHE_HOME: "/cache",
    XDG_CONFIG_HOME: "/config",
    XDG_STATE_HOME: "/state",
    XDG_RUNTIME_DIR: "/run/user/1000",
  };
  assert.equal(
    inspireConfigDirectory({ platform: "linux", environment, home: "/home/a" }),
    "/config/inspire",
  );
  assert.equal(
    inspireCacheDirectory({ platform: "linux", environment, home: "/home/a" }),
    "/cache/inspire",
  );
  assert.equal(
    inspireStateDirectory({ platform: "linux", environment, home: "/home/a" }),
    "/state/inspire",
  );
  assert.equal(
    inspireRuntimeDirectory({
      platform: "linux",
      environment,
      temporary: "/tmp",
    }),
    "/run/user/1000/inspire",
  );
});

test("ignores relative platform directory overrides", () => {
  const environment = {
    XDG_CONFIG_HOME: "relative-config",
    XDG_CACHE_HOME: "relative-cache",
    XDG_STATE_HOME: "relative-state",
    XDG_RUNTIME_DIR: "relative-runtime",
  };
  assert.equal(
    inspireConfigDirectory({ platform: "linux", environment, home: "/home/a" }),
    "/home/a/.config/inspire",
  );
  assert.equal(
    inspireCacheDirectory({ platform: "linux", environment, home: "/home/a" }),
    "/home/a/.cache/inspire",
  );
  assert.equal(
    inspireStateDirectory({ platform: "linux", environment, home: "/home/a" }),
    "/home/a/.local/state/inspire",
  );
  assert.match(
    inspireRuntimeDirectory({
      platform: "linux",
      environment,
      temporary: "/tmp",
    }),
    /^\/tmp\/inspire-[^/]+\/inspire$/u,
  );
});

test("uses native macOS application support", () => {
  assert.equal(
    inspireConfigDirectory({
      platform: "darwin",
      environment: {},
      home: "/Users/a",
    }),
    "/Users/a/Library/Application Support/Inspire",
  );
  assert.equal(
    inspireCacheDirectory({
      platform: "darwin",
      environment: {},
      home: "/Users/a",
    }),
    "/Users/a/Library/Caches/Inspire",
  );
  assert.equal(
    inspireStateDirectory({
      platform: "darwin",
      environment: {},
      home: "/Users/a",
    }),
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

test("uses Windows roaming, local, and runtime roots", () => {
  const environment = {
    APPDATA: "C:\\Users\\a\\AppData\\Roaming",
    LOCALAPPDATA: "C:\\Users\\a\\AppData\\Local",
  };
  assert.equal(
    inspireConfigDirectory({
      platform: "win32",
      environment,
      home: "C:\\Users\\a",
    }),
    "C:\\Users\\a\\AppData\\Roaming/Inspire".replaceAll("/", "\\"),
  );
  assert.equal(
    inspireCacheDirectory({
      platform: "win32",
      environment,
      home: "C:\\Users\\a",
    }),
    "C:\\Users\\a\\AppData\\Local/Inspire/Cache".replaceAll("/", "\\"),
  );
  assert.equal(
    inspireStateDirectory({
      platform: "win32",
      environment,
      home: "C:\\Users\\a",
    }),
    "C:\\Users\\a\\AppData\\Local/Inspire".replaceAll("/", "\\"),
  );
  assert.equal(
    inspireRuntimeDirectory({
      platform: "win32",
      environment,
      temporary: "C:\\Temp",
    }),
    "C:\\Users\\a\\AppData\\Local/Inspire/runtime".replaceAll("/", "\\"),
  );
  assert.equal(supportsPosixPermissions("win32"), false);
  assert.equal(supportsPosixPermissions("darwin"), true);
});
