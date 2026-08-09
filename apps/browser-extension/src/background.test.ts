import { afterEach, describe, expect, it, vi } from "vitest";

import { TICK_ALARM_NAME } from "./schedule.js";

type Listener = (...args: never[]) => void;

function listeners() {
  const registered: Listener[] = [];
  return {
    addListener: (listener: Listener) => registered.push(listener),
    emit: (...args: never[]) => {
      for (const listener of registered) listener(...args);
    },
  };
}

describe("background startup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it("does not let an alarm overwrite restored state before initialization completes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    let resolveStorage: (value: Record<string, unknown>) => void = () => undefined;
    const alarm = listeners();
    const activated = listeners();
    const updated = listeners();
    const focusChanged = listeners();
    const idleChanged = listeners();
    const portMessages = listeners();
    const portDisconnect = listeners();
    const set = vi.fn(() => Promise.resolve());
    const port = {
      postMessage: vi.fn(),
      onMessage: portMessages,
      onDisconnect: portDisconnect,
    };
    vi.stubGlobal("chrome", {
      storage: { local: { get: vi.fn(() => new Promise<Record<string, unknown>>((resolve) => { resolveStorage = resolve; })), set } },
      alarms: { onAlarm: alarm, clear: vi.fn(() => Promise.resolve(true)), create: vi.fn(), get: vi.fn(() => Promise.resolve(undefined)) },
      tabs: { onActivated: activated, onUpdated: updated, get: vi.fn(() => Promise.resolve({ id: 1 })), query: vi.fn(() => Promise.resolve([])) },
      windows: { WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1, onFocusChanged: focusChanged, getLastFocused: vi.fn(() => Promise.resolve({ focused: false })) },
      idle: { setDetectionInterval: vi.fn(), onStateChanged: idleChanged, queryState: vi.fn(() => Promise.resolve("active")) },
      runtime: { connectNative: vi.fn(() => port) },
    });

    await import("./background.js");
    alarm.emit({ name: TICK_ALARM_NAME } as never);
    await Promise.resolve();
    expect(set).not.toHaveBeenCalled();

    const savedAt = Date.now() - 1_000;
    resolveStorage({
      browserCollectionId: "collection-1",
      unmatchedTally: { weekStart: Date.UTC(2026, 7, 3), entries: {} },
      spanMachine: {
        version: 2,
        savedAt,
        active: { ruleId: "rule-1", since: savedAt - 60_000, sessionId: "durable-span", lastHeartbeatAt: savedAt, gapSince: null },
        suspended: [],
      },
      lastTickAt: savedAt,
    });
    await vi.advanceTimersByTimeAsync(0);
    alarm.emit({ name: TICK_ALARM_NAME } as never);
    await vi.advanceTimersByTimeAsync(0);

    expect(set).toHaveBeenCalled();
    const persisted = set.mock.calls.at(-1)?.[0] as { spanMachine: { suspended: Array<{ sessionId: string }> } };
    expect(persisted.spanMachine.suspended).toContainEqual(expect.objectContaining({ sessionId: "durable-span" }));
  });
});
