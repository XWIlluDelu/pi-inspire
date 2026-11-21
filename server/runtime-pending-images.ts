import type { PendingInput, UploadedAttachment } from "../shared/contracts.js";
import type { AttachmentStore } from "./attachments.js";
import type { PiRpcResponseFence } from "./pi-rpc.js";
import {
  pendingImageHash as hash,
  userMessageEvidence,
  type UserMessageEvidence,
} from "./pending-image-evidence.js";
import type { PendingImageEvidence } from "./runtime-pending-image-evidence.js";
import type { PendingContent } from "./runtime-pending.js";

type Mode = "steer" | "followUp";
type Image = { type: "image"; data: string; mimeType: string };
export interface PendingImageDelivery {
  mode: Mode;
  text: string;
  fingerprint: string;
  imageIds: string[];
  copiedIds: Set<string>;
  state:
    | "prepared"
    | "sending"
    | "queued"
    | "removed"
    | "uncorrelated"
    | "released";
}
interface Row {
  text: string;
  delivery: PendingImageDelivery | null;
  ambiguousRemoval?: boolean;
  /** Pi can retain the caption after consuming an image-only message. */
  consumed?: boolean;
}
interface Rows {
  steering: Row[];
  followUp: Row[];
}
interface PendingImageClear {
  fence: PiRpcResponseFence;
  rows: Rows | null;
  candidates: Set<PendingImageDelivery>;
}
function sameRows(rows: Row[], input: string[]): boolean {
  return (
    rows.length === input.length &&
    rows.every((row, i) => row.text === input[i])
  );
}

/** Earliest single removal, including when several adjacent captions match. */
function removedRow(rows: Row[], next: string[]): number {
  if (rows.length !== next.length + 1) return -1;
  let index = next.length;
  while (index > 0 && rows[index]!.text === next[index - 1]) index--;
  for (let i = 0; i < index; i++) if (rows[i]!.text !== next[i]) return -1;
  return index;
}

/** Artifact ownership at observed Pi boundaries, never a scheduler or queue authority.
 * Unknown rows have no bytes. Original content fingerprints, not captions, identify
 * consumed images; public row changes provide order and multiplicity for clear. */
export class PendingImageRecovery {
  private rows: Rows;
  private deliveries = new Set<PendingImageDelivery>();
  private removed: Row[] = [];
  private clears = new Set<PendingImageClear>();
  private baseline?: Promise<string | null | undefined>;
  private rawSeen = new Map<string, number>();
  private corroborated = new Map<string, number>();
  private cleanup: Promise<void> = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly store: AttachmentStore,
    input: PendingInput | null,
    private readonly report: (error: unknown) => void,
    private readonly readEvidence: (
      since?: string | null,
    ) => Promise<PendingImageEvidence>,
  ) {
    this.rows = {
      steering: (input?.steering ?? []).map((text) => ({
        text,
        delivery: null,
      })),
      followUp: (input?.followUp ?? []).map((text) => ({
        text,
        delivery: null,
      })),
    };
  }

  async prepare(): Promise<void> {
    // One native append cursor per image lifetime, not a full history read.
    this.baseline ??= this.readEvidence().then(
      ({ cursor }) => cursor,
      (error) => {
        this.report(error);
        return undefined;
      },
    );
    await this.baseline;
  }

  async begin(
    mode: Mode,
    text: string,
    images: Image[],
    ids: readonly string[],
    recalled: Image[],
  ): Promise<PendingImageDelivery> {
    const held = await this.store.holdPendingImages(ids, recalled);
    const delivery: PendingImageDelivery = {
      mode,
      text,
      fingerprint: hash([text, images]),
      ...held,
      state: "prepared",
    };
    if (this.disposed) {
      await this.store.rejectPendingImages(held.imageIds, delivery.copiedIds);
      throw new Error("Image delivery worker was retired");
    }
    this.deliveries.add(delivery);
    return delivery;
  }

  isPrepared(delivery: PendingImageDelivery): boolean {
    return (
      !this.disposed &&
      this.deliveries.has(delivery) &&
      delivery.state === "prepared"
    );
  }

  dispatched(delivery: PendingImageDelivery): void {
    delivery.state = "sending";
  }

  private release(delivery: PendingImageDelivery): void {
    if (delivery.state === "prepared") {
      this.cleanup = Promise.all([this.cleanup, this.rejected(delivery)])
        .then(() => undefined)
        .catch(this.report);
      return;
    }
    if (delivery.state === "released") return;
    delivery.state = "released";
    this.deliveries.delete(delivery);
    const removing = this.store.releasePendingImages(delivery.imageIds);
    this.cleanup = Promise.all([this.cleanup, removing])
      .then(() => undefined)
      .catch(this.report);
  }

  async rejected(delivery: PendingImageDelivery): Promise<void> {
    if (!this.deliveries.delete(delivery)) return;
    delivery.state = "released";
    await this.store.rejectPendingImages(delivery.imageIds, delivery.copiedIds);
  }

  accepted(delivery: PendingImageDelivery, disposition?: unknown): void {
    if (disposition === "handled" || disposition === "started")
      this.release(delivery);
    else if (delivery.state === "sending") delivery.state = "uncorrelated";
  }

  observeQueue(input: PendingInput): void {
    if (this.disposed) return;
    let clearing = false;
    if (!input.steering.length && !input.followUp.length) {
      // The response fence flips in the RPC reader, before subsequent frames.
      for (const clear of this.clears)
        if (!clear.fence.received) {
          clearing = true;
          clear.rows = {
            steering: [...this.rows.steering],
            followUp: [...this.rows.followUp],
          };
          for (const delivery of this.deliveries)
            clear.candidates.add(delivery);
        }
    }
    const previousRows = { ...this.rows };
    for (const [key, mode] of [
      ["steering", "steer"],
      ["followUp", "followUp"],
    ] as const) {
      const previous = this.rows[key];
      const next = input[key];
      if (sameRows(previous, next)) continue;
      if (
        next.length === previous.length + 1 &&
        previous.every((row, i) => row.text === next[i])
      ) {
        const text = next.at(-1)!;
        const delivery =
          [...this.deliveries].find(
            (item) =>
              item.state === "sending" &&
              item.mode === mode &&
              item.text === text,
          ) ?? null;
        if (delivery) delivery.state = "queued";
        this.rows[key] = [...previous, { text, delivery }];
        continue;
      }
      const removedIndex = removedRow(previous, next);
      if (removedIndex >= 0) {
        const row = previous[removedIndex]!;
        if (!clearing && !row.consumed) {
          row.ambiguousRemoval = (
            key === "steering" ? previousRows.followUp : previousRows.steering
          ).some(
            (other) =>
              other.text === row.text &&
              other.delivery?.fingerprint !== row.delivery?.fingerprint,
          );
          this.removed.push(row);
          if (row.delivery?.state === "queued") row.delivery.state = "removed";
        }
        this.rows[key] = previous.toSpliced(removedIndex, 1);
      } else {
        for (const row of previous) {
          if (!clearing && !row.consumed) {
            this.removed.push(row);
            if (row.delivery?.state === "queued")
              row.delivery.state = next.length ? "uncorrelated" : "removed";
          }
        }
        this.rows[key] = next.map((text) => ({ text, delivery: null }));
      }
    }
  }

  private consume(content: UserMessageEvidence): boolean {
    const removalIndex = this.removed.findIndex(
      (row) => hash(row.text) === content.textFingerprint,
    );
    const removed =
      removalIndex < 0 ? null : this.removed.splice(removalIndex, 1)[0]!;
    if (removed && !removed.delivery) return false;
    const delivery = [...this.deliveries].find(
      (item) =>
        item.fingerprint === content.fingerprint &&
        (item.state === "queued" ||
          item.state === "removed" ||
          item.state === "uncorrelated"),
    );
    if (!delivery) {
      if (removed?.delivery) this.release(removed.delivery);
      else if (content.textFingerprint === hash("") && content.imageCount) {
        const emptyRows = [...this.rows.steering, ...this.rows.followUp].filter(
          (row) => !row.text && !row.consumed,
        );
        if (emptyRows.length === 1 && emptyRows[0]?.delivery) {
          this.release(emptyRows[0].delivery);
          emptyRows[0].delivery = null;
          emptyRows[0].consumed = true;
          return true;
        }
        let changed = false;
        for (const row of emptyRows)
          if (row.delivery) {
            changed ||= row.delivery.state === "queued";
            row.delivery.state = "uncorrelated";
          }
        return changed;
      }
      return false;
    }
    // Pi's caption-only removal can choose Steer even when a previously drained
    // Queue message actually starts. Corroborating bytes correct that ownership.
    const rows = [
      ...this.rows.steering,
      ...this.rows.followUp,
      ...[...this.clears].flatMap((clear) =>
        clear.rows ? [...clear.rows.steering, ...clear.rows.followUp] : [],
      ),
    ];
    let changed = false;
    for (const row of rows)
      if (row.delivery === delivery) {
        changed = true;
        row.delivery =
          removed?.delivery && removed.delivery !== delivery
            ? removed.delivery
            : null;
        if (row.delivery) row.delivery.state = "queued";
        else row.consumed = true;
      }
    this.release(delivery);
    return changed;
  }

  observeMessage(value: unknown): boolean {
    const content = userMessageEvidence(value);
    if (!content) return false;
    const count = (this.rawSeen.get(content.identity) ?? 0) + 1;
    this.rawSeen.set(content.identity, count);
    return count > (this.corroborated.get(content.identity) ?? 0)
      ? this.consume(content)
      : false;
  }

  private content(rows: Rows): PendingContent {
    const project = (values: Row[]) =>
      values
        .filter((row) => !row.consumed)
        .map(({ text, delivery }) => ({
          text,
          ...(delivery?.state === "queued"
            ? {
                imageCount: delivery.imageIds.length,
                imageAttachmentIds: delivery.imageIds,
              }
            : {}),
        }));
    return {
      steering: project(rows.steering),
      followUp: project(rows.followUp),
    };
  }

  /** One unconsumed view for display and full-text read coordinates. */
  project(): PendingContent {
    return this.content(this.rows);
  }

  /** Filter a clear receipt only when its exact rows were observed at the fence. */
  clearedInput(clear: PendingImageClear, input: PendingInput): PendingInput {
    const rows = clear.rows;
    if (
      !rows ||
      !sameRows(rows.steering, input.steering) ||
      !sameRows(rows.followUp, input.followUp)
    )
      return input;
    const content = this.content(rows);
    return {
      steering: content.steering.map((row) => row.text),
      followUp: content.followUp.map((row) => row.text),
    };
  }

  settled(): void {
    // Keep only row evidence across runs; never forget native stale captions.
    if (this.deliveries.size) return;
    this.removed = [];
    this.baseline = undefined;
    this.rawSeen.clear();
    this.corroborated.clear();
  }

  beginClear(fence: PiRpcResponseFence): PendingImageClear {
    const clear = { fence, rows: null, candidates: new Set(this.deliveries) };
    this.clears.add(clear);
    return clear;
  }

  private uncertain(clear: PendingImageClear): Set<string> {
    const uncertain = new Set<string>();
    const rows = clear.rows
      ? [...clear.rows.steering, ...clear.rows.followUp]
      : [];
    for (const row of rows)
      if (row.delivery) {
        for (const removed of this.removed)
          if (
            removed.ambiguousRemoval &&
            removed.delivery &&
            removed.text === row.text &&
            removed.delivery !== row.delivery &&
            removed.delivery.fingerprint !== row.delivery.fingerprint &&
            removed.delivery.state === "removed"
          )
            uncertain.add(row.text);
      }
    return uncertain;
  }

  async corroborate(clear: PendingImageClear): Promise<void> {
    if (!this.uncertain(clear).size) return;
    const cursor = await this.baseline;
    if (cursor === undefined) return;
    try {
      const { messages } = await this.readEvidence(cursor);
      const counts = new Map<string, number>();
      for (const content of messages) {
        const count = (counts.get(content.identity) ?? 0) + 1;
        counts.set(content.identity, count);
        if (
          count >
          Math.max(
            this.rawSeen.get(content.identity) ?? 0,
            this.corroborated.get(content.identity) ?? 0,
          )
        ) {
          this.consume(content);
          this.corroborated.set(content.identity, count);
        }
      }
    } catch (error) {
      this.report(error);
    }
  }

  async finishClear(
    clear: PendingImageClear,
    input: PendingInput,
    recover: boolean,
  ): Promise<{ attachments?: UploadedAttachment[]; warning?: string }> {
    this.clears.delete(clear);
    const rows = clear.rows;
    const matches =
      rows &&
      sameRows(rows.steering, input.steering) &&
      sameRows(rows.followUp, input.followUp);
    const uncertain = this.uncertain(clear);
    const attachments: UploadedAttachment[] = [];
    let lost = false;
    const restored = new Set<PendingImageDelivery>();
    for (const row of rows ? [...rows.steering, ...rows.followUp] : []) {
      const delivery = row.delivery;
      if (!delivery || restored.has(delivery) || delivery.state === "released")
        continue;
      restored.add(delivery);
      if (
        recover &&
        matches &&
        !uncertain.has(row.text) &&
        delivery.state !== "uncorrelated"
      ) {
        try {
          attachments.push(
            ...this.store.restorePendingImages(delivery.imageIds),
          );
          delivery.state = "released";
          this.deliveries.delete(delivery);
        } catch (error) {
          lost = true;
          this.report(error);
        }
      } else if (recover) lost = true;
    }
    for (const delivery of clear.candidates)
      if (delivery.state !== "sending") {
        if (
          recover &&
          delivery.state === "uncorrelated" &&
          input.steering.length + input.followUp.length > 0
        )
          lost = true;
        this.release(delivery);
      }
    await this.cleanup;
    return {
      ...(attachments.length ? { attachments } : {}),
      ...(lost
        ? {
            warning:
              "Some pending images could not be correlated safely with Pi's returned input. Re-add those images before resending.",
          }
        : {}),
    };
  }

  cancelClear(clear: PendingImageClear): void {
    this.clears.delete(clear);
  }
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const delivery of this.deliveries) this.release(delivery);
    this.rows = { steering: [], followUp: [] };
    this.removed = [];
    this.clears.clear();
    await this.cleanup;
  }
}
