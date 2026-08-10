import { afterEach, describe, expect, it, vi } from "vitest";

import { RECONNECT_ALARM_NAME, SPAN_ADVANCE_ALARM_NAME, TICK_ALARM_NAME } from "./schedule.js";

type Listener = (...args: never[]) => void;
type BrowserTab = Omit<Pick<chrome.tabs.Tab, "id" | "windowId" | "url" | "incognito">, "windowId"> & { windowId?: number };
type BrowserWindow = Pick<chrome.windows.Window, "id" | "focused">;

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
  tabs: BrowserTab[],
  queryTabs?: (query: chrome.tabs.QueryInfo) => Promise<BrowserTab[]>,
  getLastFocused: () => Promise<BrowserWindow> = () => Promise.resolve({ focused: true, id: 1 }),
  getTab?: (tabId: number) => Promise<BrowserTab | undefined>,
  getIdleState: () => Promise<"active" | "idle" | "locked"> = () => Promise.resolve("active"),
  stored: Record<string, unknown> = {},
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
    storage: { local: { get: vi.fn(() => Promise.resolve(stored)), set: vi.fn(() => Promise.resolve()) } },
    alarms: { onAlarm: alarm, clear: vi.fn(() => Promise.resolve(true)), create: vi.fn(), get: vi.fn(() => Promise.resolve(undefined)) },
    tabs: {
      onActivated: activated,
      onUpdated: updated,
      get: vi.fn((tabId: number) => getTab?.(tabId) ?? Promise.resolve(tabsById.get(tabId))),
      query: vi.fn((query: chrome.tabs.QueryInfo) => queryTabs?.(query) ?? Promise.resolve(activeTabId === undefined ? [] : [tabsById.get(activeTabId)])),
    },
    windows: { WINDOW_ID_CURRENT: -2, WINDOW_ID_NONE: -1, onFocusChanged: focusChanged, getLastFocused: vi.fn(getLastFocused) },
    idle: { setDetectionInterval: vi.fn(), onStateChanged: idleChanged, queryState: vi.fn(getIdleState) },
    runtime: { connectNative: vi.fn(() => port) },
  });
  return {
    alarm,
    activated,
    updated,
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

function lastHostMessage(port: { postMessage: ReturnType<typeof vi.fn> }, type: string): Record<string, unknown> | undefined {
  const messages = hostMessages(port);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message !== undefined && message["type"] === type) return message;
  }
  return undefined;
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
    const writes: Record<string, unknown>[] = [];
    const set = vi.fn((value: Record<string, unknown>) => {
      writes.push(value);
      return Promise.resolve();
    });
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
    const persisted = writes.at(-1);
    expect(persisted).toEqual(expect.objectContaining({
      spanMachine: expect.objectContaining({
        suspended: expect.arrayContaining([expect.objectContaining({ sessionId: "durable-span" })]),
      }),
    }));
  });

  it("does not resume a restored span after idle revalidation fails", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-08-09T12:00:00.000Z");
    vi.setSystemTime(start);
    const savedAt = start - 1_000;
    const harness = backgroundHarness(
      [{ id: 1, windowId: 1, url: "https://github.com/acme/project", incognito: false }],
      undefined,
      undefined,
      undefined,
      () => Promise.reject(new Error("idle unavailable")),
      {
        browserCollectionId: "collection-one",
        lastTickAt: savedAt,
        spanMachine: {
          version: 2,
          savedAt,
          active: {
            ruleId: "rule-1",
            since: savedAt - 60_000,
            sessionId: "durable-span",
            lastHeartbeatAt: savedAt,
            gapSince: null,
          },
          suspended: [],
        },
      },
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

    await vi.advanceTimersByTimeAsync(60_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    const messages = spanMessages(harness.port);
    expect(messages).not.toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ event: "heartbeat", externalSessionId: "durable-span" }),
    }));
    expect(messages).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ event: "ended", externalSessionId: "durable-span", occurredAt: new Date(savedAt).toISOString() }),
    }));
  });

  it("abandons an attention result that fences its restored machine", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-08-09T12:00:00.000Z");
    vi.setSystemTime(start);
    const idleResolvers: Array<(state: "active" | "idle" | "locked") => void> = [];
    const focusResolvers: Array<(window: BrowserWindow) => void> = [];
    const savedAt = start - 1_000;
    const harness = backgroundHarness(
      [{ id: 1, windowId: 1, url: "https://github.com/acme/project", incognito: false }],
      undefined,
      () => new Promise((resolve) => { focusResolvers.push(resolve); }),
      undefined,
      () => new Promise((resolve) => { idleResolvers.push(resolve); }),
      {
        browserCollectionId: "collection-one",
        lastTickAt: savedAt,
        spanMachine: {
          version: 2,
          savedAt,
          active: {
            ruleId: "rule-1",
            since: savedAt - 60_000,
            sessionId: "durable-span",
            lastHeartbeatAt: savedAt,
            gapSince: null,
          },
          suspended: [],
        },
      },
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

    await vi.advanceTimersByTimeAsync(30_000);
    idleResolvers[0]?.("active");
    focusResolvers[0]?.({ focused: true, id: 1 });
    await settle();

    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    expect(spanMessages(harness.port)).not.toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ event: "started" }),
    }));
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

  it("revalidates before crediting an unmatched late tick", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-08-09T12:00:00.000Z");
    vi.setSystemTime(start);
    const harness = backgroundHarness([{ id: 1, url: "https://example.com", incognito: false }]);

    await import("./background.js");
    await settle();
    harness.portMessages.emit({ type: "rules", collectionEnabled: true, collectionId: "collection-one", rules: [] } as never);
    await settle();

    await vi.advanceTimersByTimeAsync(45_000);
    harness.alarm.emit({ name: TICK_ALARM_NAME } as never);
    await settle();

    const afterLateTick = lastHostMessage(harness.port, "tally");
    expect(afterLateTick).toEqual(expect.objectContaining({ entries: [] }));

    await vi.advanceTimersByTimeAsync(30_000);
    harness.alarm.emit({ name: TICK_ALARM_NAME } as never);
    await settle();

    const afterRevalidation = lastHostMessage(harness.port, "tally");
    expect(afterRevalidation).toEqual(expect.objectContaining({
      entries: [{ origin: "example.com", seconds: 30 }],
    }));
  });

  it("closes at the last tick when a heartbeat deadline arrives late", async () => {
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

    await vi.advanceTimersByTimeAsync(30_000);
    harness.alarm.emit({ name: TICK_ALARM_NAME } as never);
    await settle();
    await vi.advanceTimersByTimeAsync(31_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    const messages = spanMessages(harness.port);
    expect(messages).not.toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ event: "heartbeat" }),
    }));
    expect(messages).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ event: "ended", occurredAt: new Date(start + 45_000).toISOString() }),
    }));
  });

  it("does not revive a span when a tab update arrives after a missed deadline", async () => {
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

    await vi.advanceTimersByTimeAsync(31_000);
    harness.updated.emit(
      1 as never,
      { url: "https://github.com/acme/changed" } as never,
      { id: 1, windowId: 1, url: "https://github.com/acme/changed", incognito: false } as never,
    );
    await settle();
    expect(spanMessages(harness.port)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    expect(spanMessages(harness.port)).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ event: "started", occurredAt: new Date(start + 31_000).toISOString() }),
    }));
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

    const tally = lastHostMessage(harness.port, "tally");
    expect(tally).toEqual(expect.objectContaining({
      entries: expect.arrayContaining([
        { origin: "example.com", seconds: 10 },
        { origin: "example.net", seconds: 20 },
      ]),
    }));
  });

  it("does not credit a prior tab while an activation read is pending", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-08-09T12:00:00.000Z");
    vi.setSystemTime(start);
    let resolveActivatedTab: (tab: BrowserTab | undefined) => void = () => undefined;
    const harness = backgroundHarness(
      [
        { id: 1, windowId: 1, url: "https://a.example.com", incognito: false },
        { id: 2, windowId: 1, url: "https://github.com/acme/project", incognito: false },
      ],
      undefined,
      undefined,
      (tabId) => tabId === 2
        ? new Promise((resolve) => { resolveActivatedTab = resolve; })
        : Promise.resolve({ id: 1, windowId: 1, url: "https://a.example.com", incognito: false }),
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

    harness.activated.emit({ tabId: 2, windowId: 1 } as never);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: TICK_ALARM_NAME } as never);
    await settle();

    expect(spanMessages(harness.port)).toHaveLength(0);
    const tally = lastHostMessage(harness.port, "tally");
    expect(tally).toEqual(expect.objectContaining({ entries: [] }));

    resolveActivatedTab({ id: 2, windowId: 1, url: "https://github.com/acme/project", incognito: false });
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    expect(spanMessages(harness.port)).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ event: "started", occurredAt: new Date(start + 15_000).toISOString() }),
    }));
  });

  it("does not retain a prior rule while a rules refresh read is pending", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-08-09T12:00:00.000Z");
    vi.setSystemTime(start);
    let delayRefresh = false;
    let resolveRefresh: (tab: BrowserTab | undefined) => void = () => undefined;
    const tab = { id: 1, windowId: 1, url: "https://github.com/acme/project", incognito: false };
    const harness = backgroundHarness(
      [tab],
      undefined,
      undefined,
      () => delayRefresh
        ? new Promise((resolve) => { resolveRefresh = resolve; })
        : Promise.resolve(tab),
    );

    await import("./background.js");
    await settle();
    harness.portMessages.emit({
      type: "rules",
      collectionEnabled: true,
      collectionId: "collection-one",
      rules: [{ id: "rule-one", pattern: "github.com/acme/*" }],
    } as never);
    await settle();

    delayRefresh = true;
    harness.portMessages.emit({
      type: "rules",
      collectionEnabled: true,
      collectionId: "collection-one",
      rules: [{ id: "rule-two", pattern: "github.com/acme/*" }],
    } as never);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    expect(spanMessages(harness.port)).toHaveLength(0);

    resolveRefresh(tab);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    expect(spanMessages(harness.port)).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        event: "started",
        ruleId: "rule-two",
        occurredAt: new Date(start + 15_000).toISOString(),
      }),
    }));
  });

  it("does not retain a prior tab while a focused-window read is pending", async () => {
    vi.useFakeTimers();
    const start = Date.parse("2026-08-09T12:00:00.000Z");
    vi.setSystemTime(start);
    let resolveWindowTwo: (tabs: BrowserTab[]) => void = () => undefined;
    const harness = backgroundHarness(
      [
        { id: 1, windowId: 1, url: "https://github.com/acme/one", incognito: false },
        { id: 2, windowId: 2, url: "https://github.com/acme/two", incognito: false },
      ],
      (query) => query.windowId === 2
        ? new Promise((resolve) => { resolveWindowTwo = resolve; })
        : Promise.resolve([{ id: 1, windowId: 1, url: "https://github.com/acme/one", incognito: false }]),
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
    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    expect(spanMessages(harness.port)).toHaveLength(0);

    resolveWindowTwo([{ id: 2, windowId: 2, url: "https://github.com/acme/two", incognito: false }]);
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    expect(spanMessages(harness.port)).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({ event: "started", occurredAt: new Date(start + 15_000).toISOString() }),
    }));
  });

  it("ignores a stale tab query after focus moves to another window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    const pendingQueries: Array<(tabs: BrowserTab[]) => void> = [];
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

  it("discards a delayed attention revalidation after focus changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-09T12:00:00.000Z"));
    let resolveFocusedWindow: (window: BrowserWindow) => void = () => undefined;
    const harness = backgroundHarness(
      [
        { id: 1, windowId: 1, url: "https://github.com/acme/project", incognito: false },
        { id: 2, windowId: 2, url: "https://example.net", incognito: false },
      ],
      (query) => Promise.resolve([
        query.windowId === 1
          ? { id: 1, windowId: 1, url: "https://github.com/acme/project", incognito: false }
          : { id: 2, windowId: 2, url: "https://example.net", incognito: false },
      ]),
      () => new Promise((resolve) => { resolveFocusedWindow = resolve; }),
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
    resolveFocusedWindow({ focused: true, id: 1 });
    await settle();
    await vi.advanceTimersByTimeAsync(15_000);
    harness.alarm.emit({ name: SPAN_ADVANCE_ALARM_NAME } as never);
    await settle();

    expect(spanMessages(harness.port)).toHaveLength(0);
  });

  it("splits unmatched focus time at the local week boundary", async () => {
    const originalTimezone = process.env.TZ;
    try {
      process.env.TZ = "America/Chicago";
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-10T04:59:30.000Z"));
      const harness = backgroundHarness([{ id: 1, url: "https://a.example.com", incognito: false }]);

      await import("./background.js");
      await settle();
      harness.portMessages.emit({ type: "rules", collectionEnabled: true, collectionId: "collection-one", rules: [] } as never);
      await settle();
      await vi.advanceTimersByTimeAsync(30_000);
      harness.alarm.emit({ name: TICK_ALARM_NAME } as never);
      await settle();
      await vi.advanceTimersByTimeAsync(30_000);
      harness.alarm.emit({ name: TICK_ALARM_NAME } as never);
      await settle();
      await vi.advanceTimersByTimeAsync(30_000);
      harness.alarm.emit({ name: TICK_ALARM_NAME } as never);
      await settle();

      const tally = lastHostMessage(harness.port, "tally");
      expect(tally).toEqual(expect.objectContaining({
        entries: [{ origin: "example.com", seconds: 60 }],
      }));
    } finally {
      if (originalTimezone === undefined) delete process.env.TZ;
      else process.env.TZ = originalTimezone;
    }
  });

  it("retries span delivery until the host acknowledges its durable append", async () => {
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

    const first = spanMessages(harness.port)[0];
    expect(first).toBeDefined();
    harness.portMessages.emit({ type: "span-retry", collectionId: "collection-one", event: first?.["event"] } as never);
    harness.alarm.emit({ name: RECONNECT_ALARM_NAME } as never);
    await settle();
    expect(spanMessages(harness.port)).toHaveLength(2);

    harness.portMessages.emit({ type: "span-ack", collectionId: "collection-one", event: first?.["event"] } as never);
    harness.alarm.emit({ name: RECONNECT_ALARM_NAME } as never);
    await settle();
    expect(spanMessages(harness.port)).toHaveLength(2);
  });
});
