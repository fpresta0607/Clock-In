import { defaultBridge } from "./bridge.js";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { describe, expect, it, vi } from "vitest";

const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  project: "00000000-0000-4000-8000-000000000010",
  other: "00000000-0000-4000-8000-000000000011",
};

describe("defaultBridge", () => {
  it("rejects malformed account kinds and projects as unknown bridge errors", async () => {
    invoke.mockResolvedValueOnce({ kind: "unexpected" });

    await expect(defaultBridge.bootstrap()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({
      kind: "ready",
      user: { id: ids.user, email: "timer@example.com", name: "Timer" },
      projects: [{ id: ids.project, name: "Field work", color: 42 }],
      defaultProjectId: ids.project,
      selectedProjectId: null,
    });

    await expect(defaultBridge.bootstrap()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("decodes the signed-in account with where its time lands", async () => {
    invoke.mockResolvedValueOnce({
      kind: "ready",
      user: { id: ids.user, email: "timer@example.com", name: "Timer" },
      projects: [{ id: ids.project, name: "Field work", color: null }],
      defaultProjectId: ids.project,
      selectedProjectId: ids.other,
    });

    await expect(defaultBridge.bootstrap()).resolves.toEqual({
      kind: "ready",
      user: { id: ids.user, email: "timer@example.com", name: "Timer" },
      projects: [{ id: ids.project, name: "Field work", color: null }],
      defaultProjectId: ids.project,
      selectedProjectId: ids.other,
    });
  });

  const statusPayload = {
    enabled: true,
    running: true,
    observing: true,
    lastPollAgeSeconds: 12,
    lastUploadAt: "2026-08-06T15:00:00.000Z",
    segmentBacklog: 3,
    agentBacklog: 1,
    sessionBacklog: 2,
    hooks: [{ source: "claude_code", detected: true, installed: true, needsYou: false, configPath: "C:/Users/dev/.claude/settings.json" }],
    agentActive: { source: "kimi_code", since: "2026-08-06T14:40:00.000Z" },
    currentSession: {
      projectId: ids.project,
      attribution: "agent",
      since: "2026-08-06T14:30:00.000Z",
      idleSeconds: 120,
    apps: [],
    },
    openSpan: { processName: "WindowsTerminal.exe", since: "2026-08-06T14:58:00.000Z" },
    agentSessions: [],
    selectedProjectId: null,
  };

  it("decodes the monitor status payload and rejects malformed shapes", async () => {
    invoke.mockResolvedValueOnce(statusPayload);

    await expect(defaultBridge.monitorStatus()).resolves.toEqual(statusPayload);

    invoke.mockResolvedValueOnce({ ...statusPayload, hooks: "nope" });
    await expect(defaultBridge.monitorStatus()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({
      ...statusPayload,
      currentSession: { ...statusPayload.currentSession, attribution: "manual" },
    });
    await expect(defaultBridge.monitorStatus()).rejects.toMatchObject(
      { kind: "unknown" },
    );

    invoke.mockResolvedValueOnce({ ...statusPayload, sessionBacklog: -1 });
    await expect(defaultBridge.monitorStatus()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("pins a project and clears the pin with an explicit null", async () => {
    invoke.mockResolvedValueOnce({ ...statusPayload, selectedProjectId: ids.project });
    await expect(defaultBridge.sessionSelectProject(ids.project)).resolves.toMatchObject({
      selectedProjectId: ids.project,
    });
    expect(invoke).toHaveBeenLastCalledWith("session_select_project", { projectId: ids.project });

    invoke.mockResolvedValueOnce(statusPayload);
    await defaultBridge.sessionSelectProject(null);
    expect(invoke).toHaveBeenLastCalledWith("session_select_project", { projectId: null });
  });

  it("decodes the hook registration outcomes and rejects unknown statuses", async () => {
    invoke.mockResolvedValueOnce({ status: "registered", configPath: "C:/Users/dev/.claude/settings.json" });
    await expect(defaultBridge.hookRegister("claude_code")).resolves.toEqual({
      status: "registered",
      configPath: "C:/Users/dev/.claude/settings.json",
    });

    invoke.mockResolvedValueOnce({
      status: "manual",
      configPath: "C:/Users/dev/.codex/config.toml",
      snippet: "notify = [\"clock-in-hook\"]",
    });
    await expect(defaultBridge.hookRegister("codex")).resolves.toMatchObject({ status: "manual" });

    invoke.mockResolvedValueOnce({ status: "sideways", configPath: "C:/Users/dev/.codex/config.toml" });
    await expect(defaultBridge.hookRegister("codex")).rejects.toMatchObject({ kind: "unknown" });
  });

  it("round-trips settings and switches recording with a plain boolean", async () => {
    const settings = {
      enabled: true,
      awayThresholdMinutes: 10,
      agentOverrideEnabled: true,
      browserAutoInstall: true,
      agentUsageCapture: true,
      deviceId: "00000000-0000-4000-8000-000000000300",
    };
    invoke.mockResolvedValueOnce(settings);
    await expect(defaultBridge.settingsGet()).resolves.toEqual(settings);

    invoke.mockResolvedValueOnce({ ...settings, enabled: false });
    await expect(defaultBridge.monitorSetEnabled(false)).resolves.toMatchObject({ enabled: false });
    expect(invoke).toHaveBeenLastCalledWith("monitor_set_enabled", { enabled: false });

    invoke.mockResolvedValueOnce({ ...settings, awayThresholdMinutes: "ten" });
    await expect(defaultBridge.settingsGet()).rejects.toMatchObject({ kind: "unknown" });
  });

  it("sends only the provided stats filters and validates the attributed split", async () => {
    const stats = {
      filters: { from: "2026-08-06" },
      totalDurationSeconds: 7_200,
      attributedSeconds: 5_400,
      unattributedSeconds: 1_800,
      projects: [{
        project: { id: ids.project, name: "Field work" },
        durationSeconds: 7_200,
        attributedSeconds: 5_400,
        unattributedSeconds: 1_800,
        sessionCount: 3,
      }],
      apps: [{ processName: "Code.exe", durationSeconds: 4_800 }],
      activeSeconds: 7_000,
      agentSeconds: 3_600,
      concurrency: { t0Seconds: 3_400, t1Seconds: 3_600, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
      byAgent: [{ source: "claude_code", model: null, durationSeconds: 3_600 }],
      hourly: [],
      agents: [],
    };
    invoke.mockResolvedValueOnce(stats);

    // Instant bounds, not calendar dates: a bare date is read as a UTC day.
    const fromAt = "2026-08-06T05:00:00.000Z";
    const toExclusiveAt = "2026-08-07T05:00:00.000Z";
    await expect(defaultBridge.meStats(fromAt, toExclusiveAt)).resolves.toEqual(stats);
    expect(invoke).toHaveBeenLastCalledWith("me_stats", { fromAt, toExclusiveAt, userId: undefined });

    // Attributed time can never exceed the time it is part of.
    invoke.mockResolvedValueOnce({ ...stats, attributedSeconds: 9_000 });
    await expect(defaultBridge.meStats(fromAt, toExclusiveAt)).rejects.toMatchObject({ kind: "unknown" });
  });

  it("asks for a teammate's stats, and for all time, by leaving bounds off", async () => {
    const empty = {
      filters: {},
      totalDurationSeconds: 0,
      attributedSeconds: 0,
      unattributedSeconds: 0,
      activeSeconds: 0,
      agentSeconds: 0,
      concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
      byAgent: [],
      hourly: [],
      projects: [],
      apps: [],
      agents: [],
    };
    invoke.mockResolvedValueOnce(empty);
    await expect(defaultBridge.meStats(undefined, undefined, ids.user)).resolves.toEqual(empty);
    expect(invoke).toHaveBeenLastCalledWith("me_stats", {
      fromAt: undefined,
      toExclusiveAt: undefined,
      userId: ids.user,
    });
  });

  it("tolerates a stats payload from an API that predates the hourly series", async () => {
    invoke.mockResolvedValueOnce({
      filters: {},
      totalDurationSeconds: 0,
      attributedSeconds: 0,
      unattributedSeconds: 0,
      activeSeconds: 0,
      agentSeconds: 0,
      concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
      byAgent: [{ source: "claude_code", model: null, durationSeconds: 0 }],
      projects: [],
      apps: [],
    });

    await expect(defaultBridge.meStats(undefined, undefined)).resolves.toMatchObject({
      hourly: [],
      byAgent: [{ source: "claude_code", model: null, durationSeconds: 0 }],
    });
  });

  it("decodes hourly token fields, absent ones as null", async () => {
    const stats = {
      filters: {},
      totalDurationSeconds: 0,
      attributedSeconds: 0,
      unattributedSeconds: 0,
      activeSeconds: 3_600,
      agentSeconds: 1_800,
      concurrency: { t0Seconds: 0, t1Seconds: 3_600, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
      byAgent: [],
      hourly: [
        {
          hourStart: "2026-08-06T09:00:00.000Z",
          activeSeconds: 3_600,
          agentSeconds: 1_800,
          inputTokens: 12_000,
          outputTokens: 800,
          cacheCreationInputTokens: 400,
          cacheReadInputTokens: 60_000,
        },
        // An hour nothing reported tokens for keeps nulls, and an API from
        // before the fields shipped decodes to the same nulls.
        { hourStart: "2026-08-06T10:00:00.000Z", activeSeconds: 0, agentSeconds: 0 },
      ],
      projects: [],
      apps: [],
    };
    invoke.mockResolvedValueOnce(stats);

    await expect(defaultBridge.meStats(undefined, undefined)).resolves.toMatchObject({
      hourly: [
        { inputTokens: 12_000, outputTokens: 800, cacheCreationInputTokens: 400, cacheReadInputTokens: 60_000 },
        { inputTokens: null, outputTokens: null, cacheCreationInputTokens: null, cacheReadInputTokens: null },
      ],
    });

    invoke.mockResolvedValueOnce({
      ...stats,
      hourly: [{ ...stats.hourly[0], inputTokens: -1 }],
    });
    await expect(defaultBridge.meStats(undefined, undefined)).rejects.toMatchObject({ kind: "unknown" });
  });

  it("decodes agent activity in stats, absent tokensReported as unknown", async () => {
    invoke.mockResolvedValueOnce({
      filters: {},
      totalDurationSeconds: 0,
      attributedSeconds: 0,
      unattributedSeconds: 0,
      activeSeconds: 0,
      agentSeconds: 3_600,
      concurrency: { t0Seconds: 0, t1Seconds: 0, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
      byAgent: [],
      projects: [],
      apps: [],
      agents: [
        { agent: { id: "a1", source: "claude_code" }, shiftCount: 2, tokensReported: true },
        { agent: { id: "a2", source: "codex" }, shiftCount: 1 },
      ],
    });

    await expect(defaultBridge.meStats(undefined, undefined)).resolves.toMatchObject({
      agents: [
        { source: "claude_code", shiftCount: 2, tokensReported: true },
        // Absent on an older API decodes to null: it cannot say, so nobody is named blind.
        { source: "codex", shiftCount: 1, tokensReported: null },
      ],
    });
  });

  it("decodes the shifts-by-codebase map, and reads absence as empty rather than a crash", async () => {
    invoke.mockResolvedValueOnce({
      totalAgentSeconds: 5_400,
      groups: [{
        repo: "clock-in",
        agentSeconds: 5_400,
        shiftCount: 1,
        heldRate: 0.5,
        shifts: [{
          id: "00000000-0000-4000-8000-000000000601",
          source: "claude_code",
          owner: { id: "00000000-0000-4000-8000-000000000001", name: "Alex" },
          model: "claude-opus-5",
          startedAt: "2026-08-06T15:00:00.000Z",
          endedAt: "2026-08-06T16:00:00.000Z",
          agentSeconds: 5_400,
          commits: [{ subject: "feat: thing", verification: "merged" }],
        }],
      }],
    });
    await expect(defaultBridge.agentShifts("2026-08-01T00:00:00.000Z", "2026-08-08T00:00:00.000Z")).resolves.toMatchObject({
      totalAgentSeconds: 5_400,
      groups: [{ repo: "clock-in", heldRate: 0.5, shifts: [{ model: "claude-opus-5", commits: [{ verification: "merged" }] }] }],
    });

    // An API older than this build sends no groups at all: an empty map, not
    // an error, is what keeps the tab alive across the deploy window.
    invoke.mockResolvedValueOnce({});
    await expect(defaultBridge.agentShifts()).resolves.toEqual({ totalAgentSeconds: 0, groups: [] });

    // A group with a label-less repo and no decided commit keeps both nulls.
    invoke.mockResolvedValueOnce({ groups: [{ repo: null, shifts: [] }] });
    const bare = await defaultBridge.agentShifts();
    expect(bare.groups[0]).toMatchObject({ repo: null, heldRate: null, agentSeconds: 0 });
  });

  it("rejects a held rate outside [0, 1] rather than rendering a nonsense percent", async () => {
    invoke.mockResolvedValueOnce({ groups: [{ repo: "x", heldRate: 1.5, shifts: [] }] });
    await expect(defaultBridge.agentShifts()).rejects.toMatchObject({ kind: "unknown" });
  });
});
