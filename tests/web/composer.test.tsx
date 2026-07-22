// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it } from "vitest";
import { Composer } from "../../src/components/Composer";
import { store } from "../../src/store";
import {
  activeSnapshot,
  bootstrapPayload,
  FakeWebSocket,
  installFakeWebSocket,
  installFetch,
  jsonBody,
} from "./helpers";

let promptBodies: Record<string, unknown>[];
let promptFails: boolean;

beforeAll(async () => {
  promptBodies = [];
  promptFails = false;
  installFakeWebSocket();
  installFetch((url, init) => {
    if (url.startsWith("/api/bootstrap")) return { body: bootstrapPayload({ snapshot: activeSnapshot() }) };
    if (url.startsWith("/api/snapshot")) return { body: activeSnapshot() };
    if (url.startsWith("/api/sessions")) return { body: { sessions: [], total: 0, offset: 0, limit: 40 } };
    if (url.startsWith("/api/attachments")) {
      return {
        body: {
          attachments: [
            { id: "att-1", fileName: "notes.txt", mimeType: "text/plain", size: 5, kind: "file" },
          ],
        },
      };
    }
    if (url.startsWith("/api/files")) {
      return { body: { files: [{ path: "src/index.ts", name: "index.ts" }] } };
    }
    if (url.startsWith("/api/prompt")) {
      const body = jsonBody(init);
      if (promptFails) return { status: 500, body: { error: "boom" } };
      promptBodies.push(body);
      return { status: 202, body: { accepted: true } };
    }
    if (url.startsWith("/api/preferences")) return { body: jsonBody(init) };
    return undefined;
  });
  await store.init("token");
  FakeWebSocket.instances.at(-1)?.open();
});

async function attachFile(name = "notes.txt") {
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await userEvent.upload(input, new File(["hello"], name, { type: "text/plain" }));
}

function typeDraft(text: string) {
  fireEvent.change(screen.getByLabelText("Message"), { target: { value: text } });
}

function clearLeftovers() {
  for (const item of store.getState().attachments) store.removeAttachment(item.localId);
  for (const path of store.getState().projectFiles) store.removeProjectFile(path);
  store.dismissError();
}

describe("composer attachments", () => {
  it("uploads a selected file and sends its attachment id, then clears on accept", async () => {
    clearLeftovers();
    render(<Composer />);
    await attachFile();
    // chip appears with name/type/size once the upload resolves
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText(/text\/plain · 5 B/)).toBeInTheDocument();

    typeDraft("check this");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(promptBodies.length).toBeGreaterThan(0));
    expect(promptBodies.at(-1)).toMatchObject({ message: "check this", attachmentIds: ["att-1"] });
    // accepted submission clears the draft and attachments
    expect(screen.getByLabelText("Message")).toHaveValue("");
    expect(screen.queryByText("notes.txt")).not.toBeInTheDocument();
  });

  it("retains the draft and attachments when submission fails", async () => {
    clearLeftovers();
    promptFails = true;
    render(<Composer />);
    await attachFile();
    expect(await screen.findByText("notes.txt")).toBeInTheDocument();

    typeDraft("keep me");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() => expect(store.getState().error).toBe("boom"));
    expect(screen.getByLabelText("Message")).toHaveValue("keep me");
    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    promptFails = false;
    clearLeftovers();
  });
});

describe("project file picker", () => {
  it("adds a searched project file and sends it with the prompt", async () => {
    clearLeftovers();
    render(<Composer />);
    fireEvent.click(screen.getByRole("button", { name: "Add project files" }));
    fireEvent.change(screen.getByLabelText("Search project files"), { target: { value: "index" } });

    const row = await screen.findByRole("option", { name: /index\.ts/ });
    fireEvent.click(row);
    expect(screen.getByLabelText("Remove src/index.ts")).toBeInTheDocument();

    typeDraft("with context");
    fireEvent.click(screen.getByRole("button", { name: "Send message" }));

    await waitFor(() =>
      expect(promptBodies.at(-1)).toMatchObject({ message: "with context", projectFiles: ["src/index.ts"] }),
    );
    // accepted submission clears the referenced files
    expect(screen.queryByLabelText("Remove src/index.ts")).not.toBeInTheDocument();
    clearLeftovers();
  });
});
