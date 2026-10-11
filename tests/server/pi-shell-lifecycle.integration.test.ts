import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fixture,
  eventsOf,
  settled,
  disposeOperationFixture,
} from "./fixtures/native-operation.js";

afterEach(disposeOperationFixture);

describe("native shell input", () => {
  it("streams direct native results, preserves cwd/context and reopens excluded results without a model turn", async () => {
    const f = await fixture(false);
    const included = f.delivery(
      "!printf 'NATIVE_INCLUDED'; node -e 'process.stdout.write(process.cwd())'; sleep 0.2; printf 'TAIL'",
    );
    await f.api.prompt(included);
    await f.api.prompt(included); // Reobserving the same receipt must not rerun a shell.
    await f.api.prompt(f.delivery("!!printf 'NATIVE_EXCLUDED'"));
    expect(f.modelRequests).toHaveLength(0);
    expect(eventsOf(f.piEvents, "agent_start")).toHaveLength(0);
    const deltas = eventsOf(f.piEvents, "bash_execution_update");
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.every((event) => typeof event.id === "string")).toBe(true);
    expect(
      eventsOf(f.runtimeEvents, "message_update").some((event) =>
        (event.message as Record<string, unknown>)?.output
          ?.toString()
          .includes("NATIVE_INCLUDED"),
      ),
    ).toBe(true);
    const snapshot = await f.runtime.snapshot();
    const bash = snapshot.active!.transcriptPage.messages.filter(
      (message) =>
        (message as Record<string, unknown>).role === "bashExecution",
    ) as Array<Record<string, unknown>>;
    expect(bash).toHaveLength(2);
    expect(bash[0]).toMatchObject({
      exitCode: 0,
      cancelled: false,
      excludeFromContext: false,
    });
    expect(bash[0]!.output).toContain(f.workspace);
    expect(bash[1]).toMatchObject({
      output: expect.stringContaining("NATIVE_EXCLUDED"),
      excludeFromContext: true,
    });
    expect(snapshot.bashRunning).toBe(false);
    expect(snapshot.active?.projectionConflict).toBeNull();
    await f.api.prompt(f.delivery("Explicit model turn."));
    await settled(f, 1);
    const modelContext = JSON.stringify(f.modelRequests[0]!.body.messages);
    expect(modelContext).toContain("NATIVE_INCLUDED");
    expect(modelContext).not.toContain("NATIVE_EXCLUDED");
    const history = await f.runtime.composerHistory(f.sessionId);
    expect(history.entries.map((entry) => entry.text)).toContain(
      "!!printf 'NATIVE_EXCLUDED'",
    );
    await f.runtime.nativeCommand({
      sessionId: f.sessionId,
      command: "reload",
    });
    const reopened = (await f.runtime.snapshot()).active!.transcriptPage
      .messages as Array<Record<string, unknown>>;
    expect(
      reopened.filter((message) => message.role === "bashExecution"),
    ).toHaveLength(2);
    expect(
      reopened.some(
        (message) =>
          String(message.output).includes("NATIVE_EXCLUDED") &&
          message.excludeFromContext === true,
      ),
    ).toBe(true);
    const persisted = await readFile(f.sessionFile, "utf8");
    expect(persisted).toContain('"role":"bashExecution"');
    expect(persisted).toContain('"excludeFromContext":true');
  }, 25_000);

  it("honors extension results/custom operations, nonzero status and native truncation metadata", async () => {
    const f = await fixture(false);
    await f.api.prompt(f.delivery("!!fixture-hook"));
    await f.api.prompt(f.delivery("!fixture-ops"));
    await f.api.prompt(f.delivery("!head -c 80000 /dev/zero | tr '\\000' x"));
    const snapshot = await f.runtime.snapshot();
    const messages = snapshot.active!.transcriptPage.messages as Array<
      Record<string, unknown>
    >;
    expect(
      messages.find((message) => message.command === "fixture-hook"),
    ).toMatchObject({
      output: "EXTENSION_BASH_RESULT",
      exitCode: 7,
      excludeFromContext: true,
    });
    expect(snapshot.extensionStatuses?.["fixture-user-bash"]).toBe(
      `true:${f.workspace}`,
    );
    expect(
      messages.find((message) => message.command === "fixture-ops")?.output,
    ).toContain("EXTENSION_CUSTOM_OPERATIONS");
    const truncated = messages.find((message) =>
      String(message.command).startsWith("head -c"),
    )!;
    expect(truncated).toMatchObject({ exitCode: 0, truncated: true });
    expect(truncated.fullOutputPath).toEqual(expect.any(String));
    expect(String(truncated.fullOutputPath)).toContain(f.directory);
    expect((await readFile(String(truncated.fullOutputPath))).length).toBe(
      80000,
    );
    const tree = await f.runtime.branchTree(f.sessionId);
    const shellNodes = tree.nodes.filter((node) => node.role === "shell");
    expect(shellNodes).toHaveLength(3);
    expect(
      shellNodes.every(
        (node) => node.canSwitch && !node.canEdit && !node.canFork,
      ),
    ).toBe(true);
    for (const [query, command, context] of [
      ["EXTENSION_BASH_RESULT", "!!fixture-hook", "Excluded from context"],
      ["EXTENSION_CUSTOM_OPERATIONS", "!fixture-ops", "Included in context"],
    ]) {
      const matches = await f.runtime.branchTree(f.sessionId, { query });
      const node = matches.nodes.find(
        (candidate) => candidate.role === "shell",
      )!;
      const detail = await f.runtime.branchEntry({
        sessionId: f.sessionId,
        viewId: snapshot.active!.transcriptPage.viewId,
        targetId: node.id,
        offset: 0,
      });
      expect(detail.text).toContain(command);
      expect(detail.text).toContain(context);
      expect(detail.text).not.toContain('"role"');
    }
    expect(f.modelRequests).toHaveLength(0);
    expect(snapshot.active?.projectionConflict).toBeNull();
  }, 20_000);

  it("uses abort_bash without model abort/dequeue and rejects a second shell while one is running", async () => {
    const f = await fixture(false);
    const worker = f.workers[0]!;
    const requests = vi.spyOn(worker, "request");
    const running = f.api.prompt(
      f.delivery("!printf 'CANCEL_READY'; sleep 30"),
    );
    // Own an early rejection even if the running-state assertion fails; the
    // original promise is still awaited below, so request failure still fails.
    void running.catch(() => {});
    await vi.waitFor(async () =>
      expect((await f.runtime.snapshot()).bashRunning).toBe(true),
    );
    await expect(f.api.prompt(f.delivery("!echo second"))).rejects.toThrow(
      /already running/,
    );
    await f.api.abort(f.sessionId);
    await running;
    expect(
      requests.mock.calls.some(([command]) => command.type === "abort_bash"),
    ).toBe(true);
    expect(
      requests.mock.calls.some(
        ([command]) =>
          command.type === "abort" || command.type === "clear_queue",
      ),
    ).toBe(false);
    expect(worker.stop).not.toHaveBeenCalled();
    const snapshot = await f.runtime.snapshot();
    expect(snapshot.bashRunning).toBe(false);
    const cancelled = (
      snapshot.active!.transcriptPage.messages as Array<Record<string, unknown>>
    ).find((message) => message.role === "bashExecution");
    expect(cancelled).toMatchObject({
      cancelled: true,
      command: "printf 'CANCEL_READY'; sleep 30",
    });
    expect(snapshot.active?.projectionConflict).toBeNull();
    expect(f.modelRequests).toHaveLength(0);
  }, 20_000);

  it("keeps extension-hook dialogs answerable and retires only the selected worker on explicit hook Stop", async () => {
    const f = await fixture(false);
    const first = f.api.prompt(f.delivery("!fixture-await-bash"));
    await vi.waitFor(async () =>
      expect(
        (await f.runtime.snapshot()).pendingExtensionUiRequests,
      ).toHaveLength(1),
    );
    const dialog = (await f.runtime.snapshot()).pendingExtensionUiRequests![0]!;
    await f.runtime.extensionUiResponse({
      sessionId: f.sessionId,
      id: dialog.id,
      confirmed: true,
    });
    await first;
    expect(f.workers[0]!.stop).not.toHaveBeenCalled();
    const stopped = f.api.prompt(f.delivery("!fixture-await-bash"));
    void stopped.catch(() => {});
    await vi.waitFor(async () =>
      expect(
        (await f.runtime.snapshot()).pendingExtensionUiRequests,
      ).toHaveLength(1),
    );
    await f.api.abort(f.sessionId);
    await expect(stopped).rejects.toMatchObject({ outcomeUnknown: true });
    expect(f.workers[0]!.stop).toHaveBeenCalledWith("bash");
    expect((await f.runtime.snapshot()).pendingExtensionUiRequests).toEqual([]);
    const final = await f.runtime.snapshot();
    expect(final.bashRunning).toBe(false);
    const interrupted = (
      final.active!.transcriptPage.messages as Array<Record<string, unknown>>
    ).find((message) => message.__inspireBashInterrupted === true);
    expect(interrupted).toMatchObject({
      command: "fixture-await-bash",
      __inspireBashRunning: false,
      __inspireBashError: expect.stringContaining("result was confirmed"),
    });
    expect(interrupted?.exitCode).toBeUndefined();
    expect(interrupted?.cancelled).toBeUndefined();
    expect(
      (
        final.active!.transcriptPage.messages as Array<Record<string, unknown>>
      ).some((message) => message.__inspireBashRunning === true),
    ).toBe(false);
    expect(
      (await readFile(f.sessionFile, "utf8")).split("HOOK_CONFIRMED"),
    ).toHaveLength(2);
    expect(f.modelRequests).toHaveLength(0);
  }, 20_000);

  it("settles streamed output honestly when its isolated worker exits unexpectedly", async () => {
    const f = await fixture(false);
    const running = f.api.prompt(f.delivery("!printf 'BEFORE_EXIT'; sleep 30"));
    void running.catch(() => {});
    await vi.waitFor(() =>
      expect(
        f.runtimeEvents.some(
          (event) =>
            (event.message as Record<string, unknown>)?.output ===
            "BEFORE_EXIT",
        ),
      ).toBe(true),
    );
    const pid = f.workers[0]!.pid;
    expect(pid).toEqual(expect.any(Number));
    process.kill(pid!, "SIGKILL"); // This fixture-created worker, never a live session.
    await expect(running).rejects.toMatchObject({ outcomeUnknown: true });
    const snapshot = await f.runtime.snapshot();
    expect(snapshot.bashRunning).toBe(false);
    expect(
      (
        snapshot.active!.transcriptPage.messages as Array<
          Record<string, unknown>
        >
      ).find((message) => message.role === "bashExecution"),
    ).toMatchObject({
      output: "BEFORE_EXIT",
      __inspireBashRunning: false,
      __inspireBashInterrupted: true,
    });
    expect(await readFile(f.sessionFile, "utf8")).not.toContain("BEFORE_EXIT");
    expect(f.modelRequests).toHaveLength(0);
  }, 20_000);

  it("accepts explicit model input during a shell and gives model Stop first ownership", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const f = await fixture(false, 35_000, gate);
    const requests = vi.spyOn(f.workers[0]!, "request");
    const shell = f.api.prompt(
      f.delivery("!printf 'SHELL_ACTIVE'; sleep 2; printf 'SHELL_DONE'"),
    );
    void shell.catch(() => {});
    try {
      await vi.waitFor(async () =>
        expect((await f.runtime.snapshot()).bashRunning).toBe(true),
      );
      expect((await f.runtime.snapshot()).runState).toBe("idle");
      await f.api.prompt(f.delivery("Explicit model input during shell."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      await f.api.abort(f.sessionId);
      expect(
        requests.mock.calls.some(([command]) => command.type === "abort"),
      ).toBe(true);
      expect(
        requests.mock.calls.some(([command]) => command.type === "abort_bash"),
      ).toBe(false);
      expect((await f.runtime.snapshot()).bashRunning).toBe(true);
      await shell;
      const messages = (await f.runtime.snapshot()).active!.transcriptPage
        .messages as Array<Record<string, unknown>>;
      expect(
        messages.find((message) => message.role === "bashExecution"),
      ).toMatchObject({
        output: expect.stringContaining("SHELL_ACTIVESHELL_DONE"),
        cancelled: false,
        exitCode: 0,
      });
      expect(f.modelRequests).toHaveLength(1);
    } finally {
      release();
    }
  }, 20_000);

  it("executes during native pre-prompt compaction without joining the model queue", async () => {
    const f = await fixture(true, 1_500);
    const model = f.api.prompt(f.delivery("Model input that compacts first."));
    void model.catch(() => {});
    await vi.waitFor(async () =>
      expect((await f.runtime.snapshot()).runState).toBe("compacting"),
    );
    await f.api.prompt(f.delivery("!!printf 'WHILE_COMPACTING'"));
    expect((await f.runtime.snapshot()).runState).toBe("compacting");
    expect(f.modelRequests).toHaveLength(0);
    await model;
    await settled(f, 1);
    expect(f.modelRequests).toHaveLength(1);
    expect(
      (await f.runtime.snapshot()).active!.transcriptPage.messages.some(
        (message) =>
          String((message as Record<string, unknown>).output).includes(
            "WHILE_COMPACTING",
          ),
      ),
    ).toBe(true);
  }, 20_000);

  it("runs alongside an agent and persists deferred shell output at settlement without another model turn", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    const f = await fixture(false, 35_000, gate);
    try {
      await f.api.prompt(f.delivery("Background model turn."));
      await vi.waitFor(() => expect(f.modelRequests).toHaveLength(1));
      await f.api.prompt(f.delivery("!printf 'WHILE_MODEL_ACTIVE'"));
      expect((await f.runtime.snapshot()).runState).toBe("running");
      expect(await readFile(f.sessionFile, "utf8")).not.toContain(
        "WHILE_MODEL_ACTIVE",
      );
      expect(
        (await f.runtime.snapshot()).active!.transcriptPage.messages.some(
          (message) =>
            String((message as Record<string, unknown>).output).includes(
              "WHILE_MODEL_ACTIVE",
            ),
        ),
      ).toBe(true);
      release();
      await settled(f, 1);
      expect(await readFile(f.sessionFile, "utf8")).toContain(
        "WHILE_MODEL_ACTIVE",
      );
      expect(f.modelRequests).toHaveLength(1);
      expect(
        (await f.runtime.snapshot()).active!.transcriptPage.messages.filter(
          (message) =>
            (message as Record<string, unknown>).role === "bashExecution",
        ),
      ).toHaveLength(1);
    } finally {
      release();
    }
  }, 20_000);
});
