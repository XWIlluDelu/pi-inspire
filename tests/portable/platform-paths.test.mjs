import assert from "node:assert/strict";
import { test } from "node:test";
import {
  inspireCacheDirectory,
  inspireConfigDirectory,
  inspireRuntimeDirectory,
  inspireStateDirectory,
  supportsPosixPermissions,
} from "../../server/platform-paths.mjs";

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
