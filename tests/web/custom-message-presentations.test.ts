import { afterEach, describe, expect, it } from "vitest";
import { toolPresentationConfigurationSchema } from "../../shared/tool-presentation-config";
import { createCustomMessagePresentationRegistry } from "../../src/custom-message-presentations";
import {
  configureToolPresentationRegistry,
  customMessagePresentationRegistry,
  thinkingPresentationRegistry,
  toolPresentationRegistry,
} from "../../src/tool-presentations/registry";
import {
  customMessageConfiguration,
  incomingIntercom,
} from "./fixtures/custom-message-presentation";

const resolve = createCustomMessagePresentationRegistry(
  customMessageConfiguration.customMessages,
).resolve;

afterEach(() => configureToolPresentationRegistry());

describe("custom-message reading projections", () => {
  it("uses exact structured text without editing, summarizing, or truncating the body", () => {
    const body =
      "**Exact**\n\n" + "message\n".repeat(20_000) + "\nFinal paragraph";
    const message = incomingIntercom(body);
    const original = JSON.stringify(message);
    expect(resolve(message)).toEqual({
      title: "Inspire: composer editing",
      source: "Intercom",
      body,
    });
    expect(JSON.stringify(message)).toBe(original);
  });

  it("tries the sender id when the optional name is blank or absent", () => {
    const message = incomingIntercom();
    const details = message.details as { from: { name?: string; id: string } };
    for (const name of [undefined, "", "   "]) {
      details.from.name = name;
      expect(resolve(message)?.title).toBe(details.from.id);
    }
    details.from.name = "An_unbroken_sender_".repeat(50);
    expect(resolve(message)?.title).toBe(details.from.name);
  });

  it("rejects incompatible shapes and mixed content without a second interpretation", () => {
    const message = incomingIntercom();
    expect(resolve({ ...message, customType: "other_message" })).toBeNull();
    expect(resolve({ ...message, details: undefined })).toBeNull();
    expect(
      resolve({ ...message, details: { from: { name: 5 }, bodyText: "body" } }),
    ).toBeNull();
    expect(
      resolve({
        ...message,
        details: { from: { name: "sender" }, bodyText: {} },
      }),
    ).toBeNull();
    expect(
      resolve({ ...message, content: [{ type: "text", text: "text" }] }),
    ).toBeNull();
  });

  it("requires actual field absence so external or malformed provenance cannot become local attribution", () => {
    const message = incomingIntercom();
    const details = message.details as Record<string, unknown>;
    for (const crossMachine of [
      { origin: { name: "remote", machine: "host" }, trust: "unverified" },
      null,
      false,
      "",
    ]) {
      expect(
        resolve({
          ...message,
          details: { ...details, message: { crossMachine } },
        }),
      ).toBeNull();
    }
    const inherited = Object.create({ from: { name: "forged sender" } });
    inherited.bodyText = "body";
    expect(resolve({ ...message, details: inherited })).toBeNull();
  });

  it("loads and clears custom-message rules with the existing tool and Thinking bootstrap generation", () => {
    configureToolPresentationRegistry({
      ...customMessageConfiguration,
      thinking: {
        summary: [{ value: { path: "thinking.text", format: "first-line" } }],
        blocks: [{ type: "markdown", source: { path: "thinking.text" } }],
      },
    });
    expect(
      customMessagePresentationRegistry.resolve(incomingIntercom()),
    ).not.toBeNull();
    expect(
      thinkingPresentationRegistry.resolve("Reasoning\n\nBody"),
    ).not.toBeNull();
    expect(
      toolPresentationRegistry.resolve({
        call: {
          type: "toolCall",
          id: "read",
          name: "read",
          arguments: { path: "a.ts" },
        },
      }),
    ).not.toBeNull();
    configureToolPresentationRegistry();
    expect(
      customMessagePresentationRegistry.resolve(incomingIntercom()),
    ).toBeNull();
    expect(thinkingPresentationRegistry.resolve("Reasoning")).toBeNull();
  });
});

describe("custom-message configuration schema", () => {
  it("accepts arbitrary bounded customType strings and resolves their exact spelling", () => {
    const type = "审核 消息 / review";
    const configuration = toolPresentationConfigurationSchema.parse({
      version: 1,
      rules: {},
      mappings: {},
      customMessages: {
        [type]: customMessageConfiguration.customMessages!.intercom_message,
      },
    });
    const registry = createCustomMessagePresentationRegistry(
      configuration.customMessages,
    );
    expect(
      registry.resolve({ ...incomingIntercom(), customType: type })?.title,
    ).toBe("Inspire: composer editing");
    expect(
      registry.resolve({ ...incomingIntercom(), customType: `${type} ` }),
    ).toBeNull();
    for (const invalid of ["", "x".repeat(129)]) {
      expect(
        toolPresentationConfigurationSchema.safeParse({
          ...configuration,
          customMessages: { [invalid]: configuration.customMessages![type] },
        }).success,
      ).toBe(false);
    }
  });

  it("keeps existing version-1 tool and Thinking profiles valid", () => {
    expect(
      toolPresentationConfigurationSchema.safeParse(customMessageConfiguration)
        .success,
    ).toBe(true);
    expect(
      toolPresentationConfigurationSchema.safeParse({
        version: 1,
        rules: {},
        mappings: {},
      }).success,
    ).toBe(true);
  });

  it.each([
    { title: [] },
    { title: ["details.__proto__.name"] },
    { title: ["details.constructor.name"] },
    { body: "args.message" },
    { body: "thinking.text" },
    { body: "details." },
    { source: " " },
    { requireAbsent: ["result.details.origin"] },
    { timestamp: "details.message.timestamp" },
    { format: "first-line" },
  ])("rejects unsafe selectors and unsupported fields: %j", (invalid) => {
    expect(
      toolPresentationConfigurationSchema.safeParse({
        ...customMessageConfiguration,
        customMessages: {
          intercom_message: {
            ...customMessageConfiguration.customMessages!.intercom_message,
            ...invalid,
          },
        },
      }).success,
    ).toBe(false);
  });
});
