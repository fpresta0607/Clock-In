import { describe, expect, it } from "vitest";

import {
  MAX_RETAINED_OUTBOX_NAMESPACES,
  Outbox,
  canActivateOutboxNamespace,
  pruneOutboxNamespaces,
  reconnectBackoffMs,
} from "./outbox.js";

describe("Outbox", () => {
  it("queues and drains first-in-first-out", () => {
    const outbox = new Outbox<number>(10);
    outbox.push(1);
    outbox.push(2);
    outbox.push(3);
    expect(outbox.size).toBe(3);
    expect(outbox.drain()).toEqual([1, 2, 3]);
    expect(outbox.size).toBe(0);
    expect(outbox.drain()).toEqual([]);
  });

  it("refuses new events when the queue is full without discarding saved work", () => {
    const outbox = new Outbox<number>(3);
    for (let n = 1; n <= 5; n += 1) {
      if (n <= 3) expect(outbox.push(n)).toBe(true);
      else expect(outbox.push(n)).toBe(false);
    }
    expect(outbox.size).toBe(3);
    expect(outbox.drain()).toEqual([1, 2, 3]);
  });

  it("restores every saved event before applying new backpressure", () => {
    const outbox = new Outbox<number>(2, [1, 2, 3]);
    expect(outbox.snapshot()).toEqual([1, 2, 3]);
    expect(outbox.push(4)).toBe(false);
    expect(outbox.snapshot()).toEqual([1, 2, 3]);
  });

  it("evicts only drained inactive namespaces beyond the retention cap", () => {
    const outboxes = new Map<string, Outbox<number>>();
    for (let index = 0; index < MAX_RETAINED_OUTBOX_NAMESPACES + 2; index += 1) {
      outboxes.set(`drained-${index}`, new Outbox<number>());
    }
    const pending = new Outbox<number>();
    pending.push(1);
    outboxes.set("pending", pending);
    const active = new Outbox<number>();
    outboxes.set("active", active);

    pruneOutboxNamespaces(outboxes, "active");

    expect(outboxes.size).toBe(MAX_RETAINED_OUTBOX_NAMESPACES);
    expect(outboxes.get("pending")?.snapshot()).toEqual([1]);
    expect(outboxes.has("active")).toBe(true);
  });

  it("refuses a new namespace when every retained queue has unsynced evidence", () => {
    const outboxes = new Map<string, Outbox<number>>();
    for (let index = 0; index < MAX_RETAINED_OUTBOX_NAMESPACES; index += 1) {
      const outbox = new Outbox<number>();
      outbox.push(index);
      outboxes.set(`pending-${index}`, outbox);
    }

    expect(canActivateOutboxNamespace(outboxes, "new-workspace", "pending-0")).toBe(false);
    expect(outboxes.get("pending-0")?.snapshot()).toEqual([0]);
    expect(outboxes.size).toBe(MAX_RETAINED_OUTBOX_NAMESPACES);
    expect(canActivateOutboxNamespace(outboxes, "pending-3", "pending-0")).toBe(true);
  });

  it("makes room with drained inactive queues before activating a new namespace", () => {
    const outboxes = new Map<string, Outbox<number>>();
    for (let index = 0; index < MAX_RETAINED_OUTBOX_NAMESPACES; index += 1) {
      outboxes.set(`drained-${index}`, new Outbox<number>());
    }

    expect(canActivateOutboxNamespace(outboxes, "new-workspace", "drained-0")).toBe(true);
    expect(outboxes.size).toBe(MAX_RETAINED_OUTBOX_NAMESPACES - 1);
    expect(outboxes.has("drained-0")).toBe(true);
  });
});

describe("reconnectBackoffMs", () => {
  it("doubles from one second and caps at one minute", () => {
    expect(reconnectBackoffMs(0)).toBe(1_000);
    expect(reconnectBackoffMs(1)).toBe(2_000);
    expect(reconnectBackoffMs(2)).toBe(4_000);
    expect(reconnectBackoffMs(3)).toBe(8_000);
    expect(reconnectBackoffMs(6)).toBe(60_000);
    expect(reconnectBackoffMs(7)).toBe(60_000);
    expect(reconnectBackoffMs(100)).toBe(60_000);
  });
});
