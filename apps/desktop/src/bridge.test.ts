import { defaultBridge } from "./bridge.js";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { describe, expect, it, vi } from "vitest";

describe("defaultBridge", () => {
  it("rejects malformed bootstrap kinds and projects as unknown bridge errors", async () => {
    invoke.mockResolvedValueOnce({ kind: "unexpected" });

    await expect(defaultBridge.bootstrap()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({
      kind: "idle",
      user: { id: "00000000-0000-4000-8000-000000000001", email: "timer@example.com", name: "Timer" },
      projects: [{ id: "00000000-0000-4000-8000-000000000010", name: "Field work", color: 42 }],
    });

    await expect(defaultBridge.bootstrap()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("rejects malformed timer timestamps and pending retry counts", async () => {
    invoke.mockResolvedValueOnce({
      kind: "running",
      user: { id: "00000000-0000-4000-8000-000000000001", email: "timer@example.com", name: "Timer" },
      projects: [],
      running: {
        clientId: "00000000-0000-4000-8000-000000000100",
        projectId: "00000000-0000-4000-8000-000000000010",
        sessionId: "00000000-0000-4000-8000-000000000200",
        description: "Inspect relay",
        startedAt: "not-a-timestamp",
      },
      source: "server-only",
    });
    await expect(defaultBridge.bootstrap()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({ remaining: -1 });
    await expect(defaultBridge.retryPending()).rejects.toMatchObject({ kind: "unknown" });
  });

  const statusPayload = {
    enabled: true,
    running: true,
    lastUploadAt: "2026-08-06T15:00:00.000Z",
    segmentBacklog: 3,
    agentBacklog: 1,
    browserCapturePaused: false,
    hooks: [{ source: "claude_code", detected: true, installed: true, configPath: "C:/Users/dev/.claude/settings.json" }],
    browsers: [
      { browser: "chrome", label: "Chrome", state: "connected", storeUrl: "https://chromewebstore.google.com/" },
      { browser: "edge", label: "Edge", state: "registered", storeUrl: "https://microsoftedge.microsoft.com/addons/" },
    ],
    pendingSuggestion: {
      projectId: "00000000-0000-4000-8000-000000000010",
      source: "codex",
      since: "2026-08-06T14:58:00.000Z",
    },
    agentActive: { source: "kimi_code", since: "2026-08-06T14:40:00.000Z" },
    sessionIdleSeconds: 900,
    away: { startedAt: "2026-08-06T14:30:00.000Z", seconds: 1_500, ongoing: false, exceedsHardLimit: false },
  };

  it("decodes the monitor status payload and rejects malformed shapes", async () => {
    invoke.mockResolvedValueOnce(statusPayload);
    await expect(defaultBridge.monitorStatus()).resolves.toEqual(statusPayload);
    expect(invoke).toHaveBeenCalledWith("monitor_status", undefined);

    invoke.mockResolvedValueOnce({ ...statusPayload, hooks: "claude_code" });
    await expect(defaultBridge.monitorStatus()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({ ...statusPayload, browsers: [{ browser: "chrome", label: "Chrome", state: "half-connected", storeUrl: "u" }] });
    await expect(defaultBridge.monitorStatus()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({ ...statusPayload, pendingSuggestion: { projectId: "not-a-uuid", source: "codex", since: statusPayload.pendingSuggestion.since } });
    await expect(defaultBridge.monitorStatus()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({ ...statusPayload, agentActive: { source: "kimi_code", since: "not-a-timestamp" } });
    await expect(defaultBridge.monitorStatus()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({ ...statusPayload, away: { ...statusPayload.away, seconds: -5 } });
    await expect(defaultBridge.monitorStatus()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({ ...statusPayload, pendingSuggestion: null, agentActive: null, sessionIdleSeconds: null, away: null, lastUploadAt: null });
    await expect(defaultBridge.monitorStatus()).resolves.toMatchObject({ pendingSuggestion: null, agentActive: null, sessionIdleSeconds: null, away: null });
  });

  /// The shape `quota_status` serializes, as the host writes it for a machine
  /// with one readable provider and one that cannot be read.
  const quotaPayload = {
    status: "ready",
    checkedAt: "2026-08-10T15:28:29.562Z",
    detail: null,
    providers: [
      {
        provider: "claude",
        label: "Claude",
        sources: ["claude_code"],
        status: "known",
        account: { email: "dev@example.com", organization: "Example Org" },
        plan: "max",
        percentRemaining: 72,
        bindingWindowId: "seven_day",
        windows: [
          { id: "five_hour", label: "session", kind: "session", percentRemaining: 79, resetsAt: "2026-08-10T19:30:00.443029+00:00" },
          { id: "seven_day", label: "week", kind: "weekly", percentRemaining: 72, resetsAt: "2026-08-13T21:00:00.000Z" },
        ],
        detail: null,
        reason: null,
        stale: false,
      },
      {
        provider: "cursor",
        label: "Cursor",
        sources: ["cursor"],
        status: "unknown",
        account: null,
        plan: null,
        percentRemaining: null,
        bindingWindowId: null,
        windows: [],
        detail: "This tool's quota could not be read on this machine.",
        reason: "sqlite3_unavailable",
        stale: false,
      },
    ],
  };

  it("decodes the quota snapshot and rejects readings the dial could not draw", async () => {
    invoke.mockResolvedValueOnce(quotaPayload);
    await expect(defaultBridge.quotaStatus()).resolves.toEqual(quotaPayload);
    expect(invoke).toHaveBeenCalledWith("quota_status", undefined);

    // Before the host's first reading lands, and when no source answered at all.
    invoke.mockResolvedValueOnce({ status: "pending", checkedAt: null, detail: null, providers: [] });
    await expect(defaultBridge.quotaStatus()).resolves.toMatchObject({ status: "pending", providers: [] });

    invoke.mockResolvedValueOnce({ status: "unavailable", checkedAt: null, detail: "quota-axi: not installed", providers: [] });
    await expect(defaultBridge.quotaStatus()).resolves.toMatchObject({ status: "unavailable", detail: "quota-axi: not installed" });

    invoke.mockResolvedValueOnce({ ...quotaPayload, status: "surprise" });
    await expect(defaultBridge.quotaStatus()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({ ...quotaPayload, providers: "claude" });
    await expect(defaultBridge.quotaStatus()).rejects.toMatchObject({ kind: "unknown" });

    // A known reading has to carry the number the arc is drawn from.
    invoke.mockResolvedValueOnce({
      ...quotaPayload,
      providers: [{ ...quotaPayload.providers[0], percentRemaining: null }],
    });
    await expect(defaultBridge.quotaStatus()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({
      ...quotaPayload,
      providers: [{ ...quotaPayload.providers[0], percentRemaining: 140 }],
    });
    await expect(defaultBridge.quotaStatus()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({
      ...quotaPayload,
      providers: [{ ...quotaPayload.providers[0], windows: [{ id: "seven_day", label: "week", kind: "weekly", percentRemaining: "most", resetsAt: null }] }],
    });
    await expect(defaultBridge.quotaStatus()).rejects.toMatchObject({ kind: "unknown" });

    // A provider that names only part of the login still decodes: the dial
    // reports whichever half it was given rather than dropping the reading.
    invoke.mockResolvedValueOnce({
      ...quotaPayload,
      providers: [{ ...quotaPayload.providers[0], account: { email: "dev@example.com" } }],
    });
    await expect(defaultBridge.quotaStatus()).resolves.toMatchObject({
      providers: [{ account: { email: "dev@example.com", organization: null } }],
    });
  });

  it("decodes the hook registration outcomes and rejects unknown statuses", async () => {
    const manual = {
      status: "manual",
      configPath: "C:/Users/dev/.codex/config.toml",
      snippet: "notify = [\"C:/bin/clock-in-hook.exe\", \"--source\", \"codex\"]",
    };
    invoke.mockResolvedValueOnce(manual);
    await expect(defaultBridge.hookRegister("codex")).resolves.toEqual(manual);
    expect(invoke).toHaveBeenCalledWith("hook_register", { source: "codex" });

    invoke.mockResolvedValueOnce({ status: "registered", configPath: "C:/Users/dev/.claude/settings.json" });
    await expect(defaultBridge.hookRegister("claude_code")).resolves.toMatchObject({ status: "registered" });
    expect(invoke).toHaveBeenCalledWith("hook_register", { source: "claude_code" });

    invoke.mockResolvedValueOnce({ status: "already-registered", configPath: "C:/Users/dev/.claude/settings.json" });
    await expect(defaultBridge.hookRegister("claude_code")).resolves.toMatchObject({ status: "already-registered" });

    invoke.mockResolvedValueOnce({ status: "surprise", configPath: "C:/Users/dev/.codex/config.toml" });
    await expect(defaultBridge.hookRegister("codex")).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({ status: "manual", configPath: "C:/Users/dev/.codex/config.toml" });
    await expect(defaultBridge.hookRegister("codex")).rejects.toMatchObject({ kind: "unknown" });
  });

  const settingsPayload = {
    enabled: true,
    awayThresholdMinutes: 10,
    hardAwayLimitMinutes: 60,
    autoStopOnLock: false,
    agentOverrideEnabled: true,
    onboarded: true,
    deviceId: "00000000-0000-4000-8000-000000000300",
  };

  it("round-trips monitor settings and toggles monitoring with a plain boolean", async () => {
    invoke.mockResolvedValueOnce(settingsPayload);
    await expect(defaultBridge.settingsGet()).resolves.toEqual(settingsPayload);
    expect(invoke).toHaveBeenCalledWith("settings_get", undefined);

    invoke.mockResolvedValueOnce({ ...settingsPayload, enabled: false });
    await expect(defaultBridge.monitorSetEnabled(false)).resolves.toMatchObject({ enabled: false });
    expect(invoke).toHaveBeenCalledWith("monitor_set_enabled", { enabled: false });

    invoke.mockResolvedValueOnce({ ...settingsPayload, awayThresholdMinutes: 15 });
    await expect(defaultBridge.settingsUpdate({ awayThresholdMinutes: 15 })).resolves.toMatchObject({ awayThresholdMinutes: 15 });
    expect(invoke).toHaveBeenCalledWith("settings_update", { input: { awayThresholdMinutes: 15 } });

    invoke.mockResolvedValueOnce({ ...settingsPayload, awayThresholdMinutes: "10" });
    await expect(defaultBridge.settingsGet()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("sends canonical stats bounds and validates the split", async () => {
    const stats = {
      filters: { fromAt: "2026-08-06T05:00:00.000Z", toExclusiveAt: "2026-08-07T05:00:00.000Z" },
      totalDurationSeconds: 7_200,
      corroboratedSeconds: 5_400,
      projects: [
        {
          project: { id: "00000000-0000-4000-8000-000000000010", name: "Field work" },
          durationSeconds: 7_200,
          corroboratedSeconds: 5_400,
          sessionCount: 3,
        },
      ],
      apps: [
        { processName: "Code.exe", durationSeconds: 4_800 },
        { processName: "chrome.exe", durationSeconds: 1_200 },
      ],
      sites: [
        { mapping: { id: "00000000-0000-4000-8000-000000000400", pattern: "*.quickbooks.com", projectId: "00000000-0000-4000-8000-000000000010" }, durationSeconds: 900 },
      ],
    };
    invoke.mockResolvedValueOnce(stats);
    await expect(defaultBridge.meStats("2026-08-06T05:00:00.000Z", "2026-08-07T05:00:00.000Z")).resolves.toEqual(stats);
    expect(invoke).toHaveBeenCalledWith("me_stats", {
      fromAt: "2026-08-06T05:00:00.000Z",
      toExclusiveAt: "2026-08-07T05:00:00.000Z",
    });

    invoke.mockResolvedValueOnce({ ...stats, filters: {} });
    await expect(defaultBridge.meStats()).resolves.toMatchObject({ filters: { from: undefined, to: undefined, fromAt: undefined, toExclusiveAt: undefined } });
    expect(invoke).toHaveBeenCalledWith("me_stats", {});

    invoke.mockResolvedValueOnce({ ...stats, corroboratedSeconds: 9_999 });
    await expect(defaultBridge.meStats()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({ ...stats, projects: [{ project: { id: "nope", name: "Field work" }, durationSeconds: 1, corroboratedSeconds: 0, sessionCount: 1 }] });
    await expect(defaultBridge.meStats()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({ ...stats, apps: [{ processName: "Code.exe", durationSeconds: -1 }] });
    await expect(defaultBridge.meStats()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({ ...stats, apps: undefined });
    await expect(defaultBridge.meStats()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("maps path-mapping commands and rejects malformed rows", async () => {
    const mapping = {
      id: "00000000-0000-4000-8000-000000000400",
      kind: "path_prefix",
      pathPrefix: "C:/dev/Clock-In",
      repoUrl: null,
      projectId: "00000000-0000-4000-8000-000000000010",
    };
    invoke.mockResolvedValueOnce([mapping]);
    await expect(defaultBridge.pathMappingsList()).resolves.toEqual([mapping]);
    expect(invoke).toHaveBeenCalledWith("path_mappings_list", undefined);

    invoke.mockResolvedValueOnce(mapping);
    await expect(defaultBridge.pathMappingsCreate({ pathPrefix: "C:/dev/Clock-In", projectId: mapping.projectId })).resolves.toEqual(mapping);
    expect(invoke).toHaveBeenCalledWith("path_mappings_create", { input: { pathPrefix: "C:/dev/Clock-In", projectId: mapping.projectId } });

    invoke.mockResolvedValueOnce({ ...mapping, pathPrefix: "C:/dev/other" });
    await expect(defaultBridge.pathMappingsUpdate(mapping.id, { pathPrefix: "C:/dev/other" })).resolves.toMatchObject({ pathPrefix: "C:/dev/other" });
    expect(invoke).toHaveBeenCalledWith("path_mappings_update", { id: mapping.id, input: { pathPrefix: "C:/dev/other" } });

    invoke.mockResolvedValueOnce(undefined);
    await expect(defaultBridge.pathMappingsDelete(mapping.id)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("path_mappings_delete", { id: mapping.id });

    invoke.mockResolvedValueOnce([{ ...mapping, repoUrl: 42 }]);
    await expect(defaultBridge.pathMappingsList()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce([{ ...mapping, kind: "glob_rule" }]);
    await expect(defaultBridge.pathMappingsList()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("maps the browser and suggestion commands", async () => {
    const chrome = { browser: "chrome", label: "Chrome", state: "registered", storeUrl: "https://chromewebstore.google.com/" };
    invoke.mockResolvedValueOnce(chrome);
    await expect(defaultBridge.browserRepair("chrome")).resolves.toEqual(chrome);
    expect(invoke).toHaveBeenCalledWith("browser_repair", { browser: "chrome" });

    invoke.mockResolvedValueOnce(undefined);
    await expect(defaultBridge.browserOpenStorePage("chrome")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("browser_open_store_page", { browser: "chrome" });

    const tally = [{ origin: "quickbooks.com", seconds: 10_800 }];
    invoke.mockResolvedValueOnce(tally);
    await expect(defaultBridge.suggestionsList()).resolves.toEqual(tally);
    expect(invoke).toHaveBeenCalledWith("suggestions_list", undefined);

    invoke.mockResolvedValueOnce(undefined);
    await expect(defaultBridge.suggestionNeverSuggest("quickbooks.com")).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("suggestion_never_suggest", { origin: "quickbooks.com" });

    invoke.mockResolvedValueOnce(undefined);
    await expect(defaultBridge.suggestionsClear()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("suggestions_clear", undefined);

    invoke.mockResolvedValueOnce([{ origin: "quickbooks.com", seconds: -1 }]);
    await expect(defaultBridge.suggestionsList()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("forwards a UI-decided idle figure on stop verbatim", async () => {
    invoke.mockResolvedValueOnce(undefined);
    const input = { sessionId: "00000000-0000-4000-8000-000000000200", stoppedAt: "2026-08-06T16:00:00.000Z", idleSeconds: 600 };
    await expect(defaultBridge.stop(input)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("timer_stop", { input });

    // An undecided stop sends null, and an authoritative "no idle" sends 0.
    invoke.mockResolvedValueOnce(undefined);
    const undecided = { ...input, idleSeconds: null };
    await expect(defaultBridge.stop(undecided)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("timer_stop", { input: undecided });

    invoke.mockResolvedValueOnce(undefined);
    const keepAll = { ...input, idleSeconds: 0 };
    await expect(defaultBridge.stop(keepAll)).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("timer_stop", { input: keepAll });

    invoke.mockResolvedValueOnce(undefined);
    await expect(defaultBridge.monitorDismissSuggestion()).resolves.toBeUndefined();
    expect(invoke).toHaveBeenCalledWith("monitor_dismiss_suggestion", undefined);
  });
});
