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
      byAgent: [{ source: "claude_code", model: null, durationSeconds: 3_600, sessionCount: 1, maxConcurrent: 1, medianSeconds: 3_600 }],
      hourly: [],
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
    };
    invoke.mockResolvedValueOnce(empty);
    await expect(defaultBridge.meStats(undefined, undefined, ids.user)).resolves.toEqual(empty);
    expect(invoke).toHaveBeenLastCalledWith("me_stats", {
      fromAt: undefined,
      toExclusiveAt: undefined,
      userId: ids.user,
    });
  });

  it("tolerates a stats payload from an API that predates hourly and session details", async () => {
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
      // Absent fields decode to null - absence shown as absence, not zero.
      byAgent: [{ source: "claude_code", model: null, durationSeconds: 0, sessionCount: null, maxConcurrent: null, medianSeconds: null }],
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

  it("decodes the pay-run report, with zero-activity agents and a null held rate", async () => {
    const report = {
      headcount: { total: 1, active: 1, retired: 0 },
      rows: [{
        agent: {
          id: ids.project,
          name: "Claude Code @ Field work",
          source: "claude_code",
          status: "anonymous",
          owner: { id: ids.user, name: "Timer User" },
          project: { id: ids.project, name: "Field work" },
        },
        agentSeconds: 0,
        shiftCount: 0,
        commitsRecorded: 0,
        commitsPending: 0,
        commitsMerged: 0,
        commitsReverted: 0,
        commitsOrphaned: 0,
        heldRate: null,
        models: ["claude-fable-5"],
        tokens: { inputTokens: 12_000, outputTokens: 800, cacheCreationInputTokens: 400, cacheReadInputTokens: 60_000 },
        tokensReported: true,
      }],
    };
    invoke.mockResolvedValueOnce(report);

    const fromAt = "2026-08-06T05:00:00.000Z";
    const toExclusiveAt = "2026-08-07T05:00:00.000Z";
    await expect(defaultBridge.agentsReport(fromAt, toExclusiveAt)).resolves.toEqual(report);
    expect(invoke).toHaveBeenLastCalledWith("agents_report", { fromAt, toExclusiveAt, scope: undefined });

    // An API from before the models and token fields shipped decodes them as
    // empty and absent: no models named, null totals, nothing reported.
    invoke.mockResolvedValueOnce({
      headcount: report.headcount,
      rows: report.rows.map(({ models: _models, tokens: _tokens, tokensReported: _tokensReported, ...row }) => row),
    });
    await expect(defaultBridge.agentsReport(fromAt, toExclusiveAt)).resolves.toMatchObject({
      rows: [{ models: [], tokens: null, tokensReported: false }],
    });

    // A malformed totals object is still a hard failure.
    invoke.mockResolvedValueOnce({
      headcount: report.headcount,
      rows: [{ ...report.rows[0], tokens: { inputTokens: -1 } }],
    });
    await expect(defaultBridge.agentsReport(fromAt, toExclusiveAt)).rejects.toMatchObject({ kind: "unknown" });
  });

  it("decodes an agent with a null project and a decided held rate, and rejects an out-of-range one", async () => {
    const row = {
      agent: {
        id: ids.project,
        name: "Codex @ nowhere",
        source: "codex",
        status: "registered",
        owner: { id: ids.user, name: "Timer User" },
        project: null,
      },
      agentSeconds: 3_600,
      shiftCount: 1,
      commitsRecorded: 2,
      commitsPending: 0,
      commitsMerged: 1,
      commitsReverted: 1,
      commitsOrphaned: 0,
      heldRate: 0.5,
    };
    invoke.mockResolvedValueOnce({ headcount: { total: 1, active: 1, retired: 0 }, rows: [row] });
    await expect(defaultBridge.agentsReport()).resolves.toMatchObject({ rows: [row] });

    invoke.mockResolvedValueOnce({
      headcount: { total: 1, active: 1, retired: 0 },
      rows: [{ ...row, heldRate: 1.5 }],
    });
    await expect(defaultBridge.agentsReport()).rejects.toMatchObject({ kind: "unknown" });

    invoke.mockResolvedValueOnce({
      headcount: { total: 1, active: 1, retired: 0 },
      rows: [{ ...row, agent: { ...row.agent, status: "fired" } }],
    });
    await expect(defaultBridge.agentsReport()).rejects.toMatchObject({ kind: "unknown" });
  });
});
