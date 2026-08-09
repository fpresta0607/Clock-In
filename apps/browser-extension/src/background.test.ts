import { afterEach, describe, expect, it, vi } from "vitest";

import { SPAN_ADVANCE_ALARM_NAME, TICK_ALARM_NAME } from "./schedule.js";

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

function backgroundHarness(
  tabs: chrome.tabs.Tab[],
  queryTabs?: () => Promise<chrome.tabs.Tab[]>,
) {
  const alarm = listeners();
  const activated = listeners();
  const updated = listeners();
  const focusChanged = listeners();
  const idleChanged = listeners();
  const portMessages = listeners();
  const portDisconnect = listeners();
  const tabsById = new Map(tabs.map((tab) => [tab.id, { ...tab, windowId: tab.windowId ?? 1 }]));
  let activeTabId = tabs[0]?.id;
  const port = {
    postMessage: vi.fn(),
    onMessage: portMessages,
    onDisconnect: portDisconnect,
  };
  vi.stubGlobal("chrome", {
    storage: { local: { get: vi.fn(() => Promise.resolve({})), set: vi.fn(() => Promise.resolve()) } },
    alarms: { onAlarm: alarm, clear: vi.fn(() => Promise.resolve(true)), create: vi.fn(), get: vi.fn(() => Promise.resolve(undefined)) },
    tabs: {
      onActivated: activated,
      onUpdated: updated,
      get: vi.fn((tabId: number) => Promise.resolve(tabsById.get(tabId))),
      query: vi.fn(() => queryTabs?.() ?? Promise.resolve(activeTabId === undefined ? [] : [tabsById.get(activeTabId)])),
    },
    windows: { WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1, onFocusChanged: focusChanged, getLastFocused: vi.fn(() => Promise.resolve({ focused: true, id: 1 })) },
    idle: { setDetectionInterval: vi.fn(), onStateChanged: idleChanged, queryState: vi.fn(() => Promise.resolve("active")) },
    runtime: { connectNative: vi.fn(() => port) },
  });
  return {
    alarm,
    activated,
    focusChanged,
    port,
    portMessages,
    setActiveTab: (tabId: number) => { activeTabId = tabId; },
  };
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function hostMessages(port: { postMessage: ReturnType<typeof vi.fn> }): Array<Record<string, unknown>> {
  return port.postMessage.mock.calls.map(([message]) => message as Record<string, unknown>);
}

function spanMessages(port: { postMessage: ReturnType<typeof vi.fn> }): Array<Record<string, unknown>> {
  return hostMessages(port).filter((message) => message["type"] === "span-event");
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

  it("closes stale attention before a delayed span alarm can revive it", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-08-09T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = backgroundHarness([{ id: 1, url: "https://github.com/acme/project", incognito: false }]);

    await import("./background.js");
    await settle();
    harness.portMessages.emit({
      type: "rules",
      collectionEnabled: true,
      collectionId: "collection-one",
      rules: [{ id: "rule-1", pattern: "github.com/acme/*" }],
    } as never);
    await settle();

    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();
    expect(spanMessages(harness.port)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(120_001);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    const afterGap = spanMessages(harness.port);
    expect(afterGap.filter((message) => (message["event"] as Record<string, unknown>)["event"] === "heartbeat")).toHaveLength(0);
    expect(afterGap).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ event: "ended", occurredAt: new Date(start + 15_000).toISOString() }),
    }));

    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();
    const starts = spanMessages(harness.port).filter(
      (message) => (message["event"] as Record<string, unknown>)["event"] === "started",
    );
    expect(starts).toHaveLength(2);
    expect((starts[1]?.["event"] as Record<string, unknown>)["occurredAt"]).toBe(new Date(start + 135_001).toISOString());
  });

  it("starts a fresh machine when collection ownership changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const harness = backgroundHarness([{ id: 1, url: "https://github.com/acme/project", incognito: false }]);

    await import("./background.js");
    await settle();
    harness.portMessages.emit({
      type: "rules",
      collectionEnabled: true,
      collectionId: "collection-one",
      rules: [{ id: "rule-1", pattern: "github.com/acme/*" }],
    } as never);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();
    const oldSessionId = (spanMessages(harness.port)[0]?.["event"] as Record<string, unknown>)["externalSessionId"];

    harness.portMessages.emit({
      type: "rules",
      collectionEnabled: true,
      collectionId: "collection-two",
      rules: [{ id: "rule-1", pattern: "github.com/acme/*" }],
    } as never);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    const secondCollection = spanMessages(harness.port).filter((message) => message["collectionId"] === "collection-two");
    expect(secondCollection).toContainEqual(expect.objectContaining({ event: expect.objectContaining({ event: "started" }) }));
    expect(secondCollection).not.toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ event: "ended", externalSessionId: oldSessionId }),
    }));
  });

  it("settles unmatched time before a tab verdict changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const harness = backgroundHarness([
      { id: 1, url: "https://a.example.com", incognito: false },
      { id: 2, url: "https://b.example.net", incognito: false },
    ]);

    await import("./background.js");
    await settle();
    harness.portMessages.emit({ type: "rules", collectionEnabled: true, collectionId: "collection-one", rules: [] } as never);
    await settle();

    await vi.advanceTimersByTimeAsync(10_000);
    harness.setActiveTab(2);
    harness.activated.emit({ tabId: 2, windowId: 1 } as never);
    await settle();
    await vi.advanceTimersByTimeAsync(20_000);
    harness.alarm.emit({ name: TICK_ALARM_NAME } as never);
    await settle();

    const tally = hostMessages(harness.port).findLast((message) => message["type"] === "tally");
    expect(tally).toEqual(expect.objectContaining({
      entries: expect.arrayContaining([
        { origin: "example.com", seconds: 10 },
        { origin: "example.net", seconds: 20 },
      ]),
    }));
  });

  it("ignores a stale tab query after focus moves to another window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const pendingQueries: Array<(tabs: chrome.tabs.Tab[]) => void> = [];
    const harness = backgroundHarness(
      [
        { id: 1, windowId: 1, url: "https://github.com/acme/project", incognito: false },
        { id: 2, windowId: 2, url: "https://example.net", incognito: false },
      ],
      () => new Promise((resolve) => { pendingQueries.push(resolve); }),
    );

    await import("./background.js");
    await settle();
    harness.portMessages.emit({
      type: "rules",
      collectionEnabled: true,
      collectionId: "collection-one",
      rules: [{ id: "rule-1", pattern: "github.com/acme/*" }],
    } as never);
    await settle();
    harness.focusChanged.emit(2 as never);
    await settle();
    expect(pendingQueries).toHaveLength(3);

    pendingQueries[2]?.([{ id: 2, windowId: 2, url: "https://example.net", incognito: false }]);
    pendingQueries[0]?.([{ id: 1, windowId: 1, url: "https://github.com/acme/project", incognito: false }]);
    pendingQueries[1]?.([{ id: 1, windowId: 1, url: "https://github.com/acme/project", incognito: false }]);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    expect(spanMessages(harness.port)).toHaveLength(0);
  });
});
