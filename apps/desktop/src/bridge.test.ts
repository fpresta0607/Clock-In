import { defaultBridge } from "./bridge.js";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke }));

import { describe, expect, it, vi } from "vitest";

const ids = {
  user: "00000000-0000-4000-8000-000000000001",
  project: "00000000-0000-4000-8000-000000000010",
  other: "00000000-0000-4000-8000-000000000011",
  mapping: "00000000-0000-4000-8000-000000000400",
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
    };
    invoke.mockResolvedValueOnce(stats);

    // Instant bounds, not calendar dates: a bare date is read as a UTC day.
    const fromAt = "2026-08-06T05:00:00.000Z";
    const toExclusiveAt = "2026-08-07T05:00:00.000Z";
    await expect(defaultBridge.meStats(fromAt, toExclusiveAt)).resolves.toEqual(stats);
    expect(invoke).toHaveBeenLastCalledWith("me_stats", { fromAt, toExclusiveAt });

    // Attributed time can never exceed the time it is part of.
    invoke.mockResolvedValueOnce({ ...stats, attributedSeconds: 9_000 });
    await expect(defaultBridge.meStats(fromAt, toExclusiveAt)).rejects.toMatchObject({ kind: "unknown" });
  });

  it("maps path-mapping commands and rejects malformed rows", async () => {
    const mapping = { id: ids.mapping, pathPrefix: "C:/dev/Clock-In", repoUrl: null, projectId: ids.project };
    invoke.mockResolvedValueOnce([mapping]);
    await expect(defaultBridge.pathMappingsList()).resolves.toEqual([mapping]);

    invoke.mockResolvedValueOnce(mapping);
    await defaultBridge.pathMappingsCreate({ pathPrefix: "C:/dev/Clock-In", projectId: ids.project });
    expect(invoke).toHaveBeenLastCalledWith("path_mappings_create", {
      input: { pathPrefix: "C:/dev/Clock-In", projectId: ids.project },
    });

    invoke.mockResolvedValueOnce([{ ...mapping, projectId: "not-a-uuid" }]);
    await expect(defaultBridge.pathMappingsList()).rejects.toMatchObject({ kind: "unknown" });
  });
});
