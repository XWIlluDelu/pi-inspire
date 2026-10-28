import { expect, it } from "vitest";
import {
  readNavigationDisclosure,
  saveNavigationDisclosure,
} from "../../src/workbench-session";

it("stores navigation choices independently with their own initial defaults", () => {
  expect(readNavigationDisclosure("recentSessions")).toBe(true);
  expect(readNavigationDisclosure("hiddenSessions")).toBe(false);
  saveNavigationDisclosure("recentSessions", false);
  saveNavigationDisclosure("hiddenSessions", true);
  expect(readNavigationDisclosure("recentSessions")).toBe(false);
  expect(readNavigationDisclosure("hiddenSessions")).toBe(true);
  saveNavigationDisclosure("recentSessions", true);
  expect(readNavigationDisclosure("hiddenSessions")).toBe(true);
});

it("ignores malformed disclosure values without losing valid neighboring choices", () => {
  sessionStorage.setItem(
    "inspire:workbench:v1:navigation-disclosures",
    JSON.stringify({ recentSessions: "false", hiddenSessions: true }),
  );
  expect(readNavigationDisclosure("recentSessions")).toBe(true);
  expect(readNavigationDisclosure("hiddenSessions")).toBe(true);
  saveNavigationDisclosure("recentSessions", false);
  expect(readNavigationDisclosure("recentSessions")).toBe(false);
  expect(readNavigationDisclosure("hiddenSessions")).toBe(true);
});
