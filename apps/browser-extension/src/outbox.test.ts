import { describe, expect, it } from "vitest";

import { Outbox, reconnectBackoffMs } from "./outbox.js";

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

  it("drops the oldest events when the ring is full", () => {
    const outbox = new Outbox<number>(3);
    for (let n = 1; n <= 5; n += 1) {
      outbox.push(n);
    }
    expect(outbox.size).toBe(3);
    expect(outbox.drain()).toEqual([3, 4, 5]);
  });

  it("restores from a storage snapshot, keeping the newest capacity events", () => {
    const outbox = new Outbox<number>(2, [1, 2, 3]);
    expect(outbox.snapshot()).toEqual([2, 3]);
    outbox.push(4);
    expect(outbox.snapshot()).toEqual([3, 4]);
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
