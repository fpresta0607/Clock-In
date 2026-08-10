import { describe, expect, it } from "vitest";

import {
  activitySegmentBatchRequestSchema,
  activitySegmentBatchResponseSchema,
  activitySegmentKindValues,
  activitySegmentUploadSchema,
  agentEventKindValues,
  agentSessionEventBatchRequestSchema,
  agentSessionEventBatchResponseSchema,
  agentSessionEventSchema,
  agentSourceValues,
  apiErrorSchema,
  currentSessionResponseSchema,
  leaderboardResponseSchema,
  meResponseSchema,
  isAttributed,
  meStatsResponseSchema,
  observedSessionBatchRequestSchema,
  sessionAttributionValues,
  pathMappingCreateRequestSchema,
  pathMappingListResponseSchema,
  pathMappingUpdateRequestSchema,
  projectListItemSchema,
  projectPathMappingSchema,
  reportFiltersSchema,
  reportResponseSchema,
  sessionStartRequestSchema,
  sessionStartResponseSchema,
  sessionSchema,
  sessionStatusValues,
  sessionStopRequestSchema,
  sessionStopResponseSchema,
} from "./contracts.js";

const ids = {
  client: "84c996f1-3a07-452c-a476-4ca320488c22",
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  project: "4952827b-1d8f-4c37-8c84-9d7db2c960b6",
  session: "77f941cf-f4bb-4b03-9170-2e82fd8187e9",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
};

const startedAt = "2026-08-06T14:00:00.000Z";
const stoppedAt = "2026-08-06T15:03:04.000Z";

const reportRow = {
  id: ids.session,
  user: { id: ids.user, name: "Alex Morgan" },
  project: { id: ids.project, name: "Website redesign" },
  description: null,
  status: "stopped",
  startedAt,
  stoppedAt,
  idleSeconds: 120,
  durationSeconds: 3_600,
  attribution: "manual",
  attribution: "agent",
  attributedSeconds: 3_600,
  unattributedSeconds: 0,
};

describe("authentication contracts", () => {
  it("accepts the signed-in account with its organization", () => {
    expect(
      meResponseSchema.parse({
        user: { id: ids.user, email: "alex@example.com", name: "Alex Morgan", organizationId: ids.organization },
      }),
    ).toMatchObject({ user: { id: ids.user, organizationId: ids.organization } });
  });

  it("rejects an account without an organization or with unknown fields", () => {
    expect(() => meResponseSchema.parse({ user: { id: ids.user, email: "alex@example.com", name: "Alex Morgan" } })).toThrow();
    expect(() => meResponseSchema.parse({
      user: { id: ids.user, email: "alex@example.com", name: "Alex Morgan", organizationId: ids.organization },
      accessToken: "leaked",
    })).toThrow();
  });
});

describe("project contracts", () => {
  it("accepts a project list item with its active state", () => {
    expect(
      projectListItemSchema.parse({
        id: ids.project,
        name: "Website redesign",
        color: "#2563eb",
        createdAt: "2026-08-10T12:00:00.000Z",
        isArchived: false,
        isDefault: true,
      }),
    ).toMatchObject({ id: ids.project, isArchived: false, isDefault: true });
  });
});

describe("session contracts", () => {
  it("covers every supported session status", () => {
    expect(sessionStatusValues).toEqual(["running", "stopped", "needs_review"]);
  });

  it("accepts a start request with a client-generated id", () => {
    expect(
      sessionStartRequestSchema.parse({
        clientId: ids.client,
        projectId: ids.project,
        deviceId: ids.user,
        description: "Prepare the landing page",
        startedAt,
      }),
    ).toMatchObject({ clientId: ids.client, projectId: ids.project, deviceId: ids.user });
  });

  it("allows a start to use the member's selected default project", () => {
    expect(sessionStartRequestSchema.parse({ clientId: ids.client, deviceId: ids.user, description: "General work" })).toEqual({
      clientId: ids.client,
      deviceId: ids.user,
      description: "General work",
    });
  });

  it("rejects a start without a recording device", () => {
    expect(() => sessionStartRequestSchema.parse({
      clientId: ids.client,
      projectId: ids.project,
      description: "Prepare the landing page",
      startedAt,
    })).toThrow();
  });

  it("accepts the persisted running session returned after a start", () => {
    expect(
      sessionStartResponseSchema.parse({
        session: {
          id: ids.session,
          clientId: ids.client,
          projectId: ids.project,
          status: "running",
          description: "Prepare the landing page",
          startedAt,
          stoppedAt: null,
          idleSeconds: 0,
          durationSeconds: null,
          attribution: "manual",
        },
      }),
    ).toMatchObject({ session: { id: ids.session, status: "running" } });
  });

  it("accepts completed persisted sessions from an idempotent start response", () => {
    const completedSession = {
      id: ids.session,
      clientId: ids.client,
      projectId: ids.project,
      description: null,
      startedAt,
      stoppedAt,
      idleSeconds: 0,
      durationSeconds: 3_784,
      attribution: "manual",
    };

    expect(sessionStartResponseSchema.parse({ session: { ...completedSession, status: "stopped" } })).toMatchObject({
      session: { status: "stopped", durationSeconds: 3_784 },
    });
    expect(sessionStartResponseSchema.parse({ session: { ...completedSession, status: "needs_review" } })).toMatchObject({
      session: { status: "needs_review", durationSeconds: 3_784 },
    });
  });

  it("accepts a stop request and the stopped session response", () => {
    expect(sessionStopRequestSchema.parse({ stoppedAt, idleSeconds: 120 })).toEqual({ stoppedAt, idleSeconds: 120 });
    expect(
      sessionStopResponseSchema.parse({
        session: {
          id: ids.session,
          clientId: ids.client,
          projectId: ids.project,
          status: "stopped",
          description: null,
          startedAt,
          stoppedAt,
          idleSeconds: 120,
          durationSeconds: 3664,
          attribution: "manual",
        },
      }),
    ).toMatchObject({ session: { status: "stopped", durationSeconds: 3664 } });
  });

  it("rejects a running session from a stop response", () => {
    expect(() => sessionStopResponseSchema.parse({
      session: {
        id: ids.session,
        clientId: ids.client,
        projectId: ids.project,
        status: "running",
        description: null,
        startedAt,
        stoppedAt: null,
        idleSeconds: 0,
        durationSeconds: null,
        attribution: "manual",
      },
    })).toThrow();
  });

  it("represents an absent or running current session", () => {
    expect(currentSessionResponseSchema.parse({ session: null })).toEqual({ session: null });
    expect(
      currentSessionResponseSchema.parse({
        session: {
          id: ids.session,
          clientId: ids.client,
          projectId: ids.project,
          status: "running",
          description: null,
          startedAt,
          stoppedAt: null,
          idleSeconds: 0,
          durationSeconds: null,
          attribution: "manual",
        },
      }),
    ).toMatchObject({ session: { status: "running" } });
  });

  it("accepts a batch of observed sessions and refuses to call them manual", () => {
    const observed = {
      clientId: ids.client,
      projectId: ids.project,
      attribution: "default",
      startedAt,
      stoppedAt,
      idleSeconds: 0,
    };
    expect(observedSessionBatchRequestSchema.parse({ sessions: [observed] })).toMatchObject({
      sessions: [{ attribution: "default", idleSeconds: 0 }],
    });
    // idleSeconds is optional on the wire so a desktop with nothing to trim can omit it.
    const { idleSeconds: _omitted, ...withoutIdle } = observed;
    expect(observedSessionBatchRequestSchema.parse({ sessions: [withoutIdle] })).toMatchObject({
      sessions: [{ idleSeconds: 0 }],
    });
    // "manual" belongs to the retired timer; the desktop can never claim it.
    expect(() => observedSessionBatchRequestSchema.parse({ sessions: [{ ...observed, attribution: "manual" }] })).toThrow();
    expect(() => observedSessionBatchRequestSchema.parse({ sessions: [] })).toThrow();
    expect(() => observedSessionBatchRequestSchema.parse({ sessions: [{ ...observed, idleSeconds: -1 }] })).toThrow();
  });

  it("marks every session attribution and knows which ones are attributed", () => {
    expect(sessionAttributionValues).toEqual(["manual", "selected", "agent", "default"]);
    expect(sessionAttributionValues.filter(isAttributed)).toEqual(["manual", "selected", "agent"]);
    expect(isAttributed("default")).toBe(false);
  });

  it("rejects session timestamps and durations that contradict the status", () => {
    const runningSession = {
      id: ids.session,
      clientId: ids.client,
      projectId: ids.project,
      status: "running",
      description: null,
      startedAt,
      stoppedAt: null,
      idleSeconds: 0,
      durationSeconds: null,
      attribution: "manual",
    };

    expect(() => sessionSchema.parse({ ...runningSession, stoppedAt })).toThrow();
    expect(() => sessionSchema.parse({ ...runningSession, durationSeconds: 1 })).toThrow();
    expect(() => sessionSchema.parse({ ...runningSession, status: "stopped", stoppedAt: null, durationSeconds: 1 })).toThrow();
    expect(() => sessionSchema.parse({ ...runningSession, status: "needs_review", stoppedAt, durationSeconds: null })).toThrow();
  });

  it("rejects a completed session as the current session", () => {
    const completedSession = {
      id: ids.session,
      clientId: ids.client,
      projectId: ids.project,
      description: null,
      startedAt,
      stoppedAt,
      idleSeconds: 0,
      durationSeconds: 3_784,
    };

    expect(() => currentSessionResponseSchema.parse({ session: { ...completedSession, status: "stopped" } })).toThrow();
    expect(() => currentSessionResponseSchema.parse({ session: { ...completedSession, status: "needs_review" } })).toThrow();
  });
});

describe("report and error contracts", () => {
  it("accepts inclusive report filters", () => {
    expect(
      reportFiltersSchema.parse({
        from: "2026-08-01",
        to: "2026-08-06",
        projectId: ids.project,
        userId: ids.user,
        page: "2",
        pageSize: "100",
      }),
    ).toEqual({ from: "2026-08-01", to: "2026-08-06", projectId: ids.project, userId: ids.user, page: 2, pageSize: 100 });
  });

  it("accepts exact instant report bounds and rejects ambiguous ranges", () => {
    expect(reportFiltersSchema.parse({
      fromAt: "2026-03-08T06:00:00.000Z",
      toExclusiveAt: "2026-03-09T05:00:00.000Z",
    })).toMatchObject({
      fromAt: "2026-03-08T06:00:00.000Z",
      toExclusiveAt: "2026-03-09T05:00:00.000Z",
    });
    expect(() => reportFiltersSchema.parse({ fromAt: "2026-03-08T06:00:00.000Z" })).toThrow();
    expect(() => reportFiltersSchema.parse({
      from: "2026-03-08",
      fromAt: "2026-03-08T06:00:00.000Z",
      toExclusiveAt: "2026-03-09T05:00:00.000Z",
    })).toThrow();
  });

  it("defaults and bounds coercible report pagination", () => {
    expect(reportFiltersSchema.parse({})).toMatchObject({ page: 1, pageSize: 50 });
    expect(() => reportFiltersSchema.parse({ page: "0" })).toThrow();
    expect(() => reportFiltersSchema.parse({ pageSize: "201" })).toThrow();
  });

  it("rejects impossible calendar dates", () => {
    expect(() => reportFiltersSchema.parse({ from: "2026-99-99" })).toThrow();
    expect(() => reportFiltersSchema.parse({ to: "2026-02-29" })).toThrow();
  });

  it("accepts completed organization report rows and normalized filters", () => {
    expect(reportResponseSchema.parse({
      filters: { from: "2026-08-01", to: "2026-08-06", projectId: ids.project, userId: ids.user },
      totalDurationSeconds: 3_600,
      pagination: { page: 1, pageSize: 50, totalRows: 1, totalPages: 1 },
      rows: [reportRow],
    })).toMatchObject({ totalDurationSeconds: 3_600, rows: [{ status: "stopped", attributedSeconds: 3_600 }] });
  });

  it("requires attributed seconds on report rows and leaderboard entries", () => {
    const { attributedSeconds: _dropped, ...unattributedRow } = reportRow;
    expect(() => reportResponseSchema.parse({
      filters: {},
      totalDurationSeconds: 0,
      pagination: { page: 1, pageSize: 50, totalRows: 1, totalPages: 1 },
      rows: [unattributedRow],
    })).toThrow();
    expect(() => reportResponseSchema.parse({
      filters: {},
      totalDurationSeconds: 0,
      pagination: { page: 1, pageSize: 50, totalRows: 1, totalPages: 1 },
      rows: [{ ...reportRow, attributedSeconds: -1 }],
    })).toThrow();

    const entry = {
      rank: 1,
      user: { id: ids.user, name: "Alex Morgan" },
      durationSeconds: 3_600,
      sessionCount: 2,
      attributedSeconds: 1_800,
      unattributedSeconds: 1_800,
    };
    expect(
      leaderboardResponseSchema.parse({ filters: {}, totalDurationSeconds: 3_600, entries: [entry] }),
    ).toMatchObject({ entries: [{ rank: 1, attributedSeconds: 1_800 }] });
    const { attributedSeconds: _droppedFromEntry, ...unattributedEntry } = entry;
    expect(() => leaderboardResponseSchema.parse({ filters: {}, totalDurationSeconds: 0, entries: [unattributedEntry] })).toThrow();
    expect(() => leaderboardResponseSchema.parse({ filters: {}, totalDurationSeconds: 0, entries: [{ ...entry, attributedSeconds: 1.5 }] })).toThrow();
  });

  it("rejects running rows and incomplete report rows", () => {
    const row = {
      id: ids.session,
      user: { id: ids.user, name: "Alex Morgan" },
      project: { id: ids.project, name: "Website redesign" },
      description: null,
      status: "running",
      startedAt,
      stoppedAt: null,
      idleSeconds: 0,
      durationSeconds: null,
      attribution: "manual",
    };
    expect(() => reportResponseSchema.parse({ filters: {}, totalDurationSeconds: 0, rows: [row] })).toThrow();
  });

  it("uses stable API error codes and actionable messages", () => {
    expect(apiErrorSchema.parse({ error: { code: "session_already_running", message: "Stop the active session first." } })).toEqual({
      error: { code: "session_already_running", message: "Stop the active session first." },
    });
    expect(() => apiErrorSchema.parse({ error: { code: "unrecognized", message: "Nope" } })).toThrow();
  });
});


describe("activity segment contracts", () => {
  const segment = {
    clientId: ids.client,
    deviceId: "3f6f0dbb-9a3b-4d62-9b70-5f87a9c6c6f0",
    kind: "active",
    processName: "Code.exe",
    startedAt,
    endedAt: stoppedAt,
  };

  it("covers every supported activity segment kind", () => {
    expect(activitySegmentKindValues).toEqual(["active", "idle", "locked", "suspended"]);
  });

  it("accepts a bounded batch of client-stamped segments", () => {
    expect(activitySegmentUploadSchema.parse(segment)).toEqual(segment);
    expect(activitySegmentUploadSchema.parse({ ...segment, processName: undefined })).toEqual({ ...segment, processName: undefined });
    const { processName: _dropped, ...withoutProcess } = segment;
    expect(activitySegmentUploadSchema.parse(withoutProcess)).toEqual(withoutProcess);
    expect(
      activitySegmentBatchRequestSchema.parse({ segments: [segment, { ...segment, kind: "idle", processName: undefined }] })
        .segments,
    ).toHaveLength(2);
  });

  it("rejects malformed segments and out-of-bounds batches", () => {
    expect(() => activitySegmentUploadSchema.parse({ ...segment, kind: "working" })).toThrow();
    expect(() => activitySegmentUploadSchema.parse({ ...segment, processName: "x".repeat(201) })).toThrow();
    expect(() => activitySegmentUploadSchema.parse({ ...segment, clientId: "not-a-uuid" })).toThrow();
    expect(() => activitySegmentUploadSchema.parse({ ...segment, startedAt: "yesterday" })).toThrow();
    expect(() => activitySegmentUploadSchema.parse({ ...segment, windowTitle: "leaked" })).toThrow();
    expect(() => activitySegmentBatchRequestSchema.parse({ segments: [] })).toThrow();
    expect(() => activitySegmentBatchRequestSchema.parse({ segments: Array.from({ length: 501 }, () => segment) })).toThrow();
    expect(() => activitySegmentBatchRequestSchema.parse({ segments: [segment], deviceId: ids.client })).toThrow();
  });

  it("accepts a per-row accepted/rejected batch response", () => {
    expect(
      activitySegmentBatchResponseSchema.parse({
        accepted: 1,
        rejected: [{ clientId: ids.client, reason: "Segment ends before it starts." }],
      }),
    ).toEqual({ accepted: 1, rejected: [{ clientId: ids.client, reason: "Segment ends before it starts." }] });
    expect(() => activitySegmentBatchResponseSchema.parse({ accepted: -1, rejected: [] })).toThrow();
    expect(() => activitySegmentBatchResponseSchema.parse({ accepted: 0, rejected: [{ clientId: "nope", reason: "x" }] })).toThrow();
    expect(() => activitySegmentBatchResponseSchema.parse({ accepted: 0, rejected: [{ clientId: ids.client }] })).toThrow();
  });
});

describe("agent session contracts", () => {
  const event = {
    source: "kimi_code",
    externalSessionId: "session-42",
    event: "started",
    occurredAt: startedAt,
    cwd: "C:/dev/Clock-In",
  };

  it("covers every supported agent source and event kind", () => {
    expect(agentSourceValues).toEqual(["claude_code", "codex", "kimi_code", "cursor", "browser", "other"]);
    expect(agentEventKindValues).toEqual(["started", "ended", "heartbeat"]);
  });

  it("accepts a bounded batch of agent session events", () => {
    expect(agentSessionEventSchema.parse(event)).toEqual(event);
    expect(
      agentSessionEventBatchRequestSchema.parse({ events: [event, { ...event, event: "ended", occurredAt: stoppedAt }] }).events,
    ).toHaveLength(2);
  });

  it("accepts browser span events carrying a rule id instead of a cwd", () => {
    const browserEvent = {
      source: "browser",
      externalSessionId: "span-7",
      event: "started",
      occurredAt: startedAt,
      ruleId: ids.session,
    };
    expect(agentSessionEventSchema.parse(browserEvent)).toEqual(browserEvent);
    expect(
      agentSessionEventBatchRequestSchema.parse({ events: [browserEvent, { ...browserEvent, event: "heartbeat" }] }).events,
    ).toHaveLength(2);
  });

  it("requires exactly one of cwd and ruleId, keyed to the event source", () => {
    const browserEvent = {
      source: "browser",
      externalSessionId: "span-7",
      event: "started",
      occurredAt: startedAt,
      ruleId: ids.session,
    };
    // A browser span identifies a rule, never a filesystem path.
    expect(() => agentSessionEventSchema.parse({ ...browserEvent, ruleId: undefined })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...browserEvent, cwd: "C:/dev/Clock-In" })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...browserEvent, ruleId: "not-a-uuid" })).toThrow();
    // Agent CLI sources identify a working directory, never a rule.
    expect(() => agentSessionEventSchema.parse({ ...event, ruleId: ids.session })).toThrow();
    const { cwd: _dropped, ...withoutCwd } = event;
    expect(() => agentSessionEventSchema.parse(withoutCwd)).toThrow();
  });

  it("rejects malformed events and out-of-bounds batches", () => {
    expect(() => agentSessionEventSchema.parse({ ...event, source: "claude-code" })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...event, event: "resumed" })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...event, externalSessionId: "" })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...event, externalSessionId: "x".repeat(201) })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...event, cwd: "" })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...event, cwd: "x".repeat(1_001) })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...event, occurredAt: "2026-08-06" })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...event, transcript: "leaked" })).toThrow();
    expect(() => agentSessionEventBatchRequestSchema.parse({ events: [] })).toThrow();
    expect(() => agentSessionEventBatchRequestSchema.parse({ events: Array.from({ length: 501 }, () => event) })).toThrow();
  });

  it("accepts a per-event accepted/rejected batch response", () => {
    expect(
      agentSessionEventBatchResponseSchema.parse({
        results: [
          { externalSessionId: "session-42", accepted: true },
          { externalSessionId: "session-43", accepted: false, reason: "Event timestamp is too far in the future." },
        ],
      }),
    ).toEqual({
      results: [
        { externalSessionId: "session-42", accepted: true },
        { externalSessionId: "session-43", accepted: false, reason: "Event timestamp is too far in the future." },
      ],
    });
    expect(() => agentSessionEventBatchResponseSchema.parse({ results: [{ externalSessionId: "s", accepted: "yes" }] })).toThrow();
    expect(() => agentSessionEventBatchResponseSchema.parse({ results: [{ externalSessionId: "", accepted: true }] })).toThrow();
  });
});

describe("path mapping contracts", () => {
  const mapping = {
    id: ids.session,
    kind: "path_prefix",
    pathPrefix: "C:/dev/Clock-In",
    repoUrl: "https://github.com/siqstack/clock-in.git",
    projectId: ids.project,
  };

  it("accepts a mapping with an optional repository URL", () => {
    expect(projectPathMappingSchema.parse(mapping)).toEqual(mapping);
    expect(projectPathMappingSchema.parse({ ...mapping, repoUrl: null })).toEqual({ ...mapping, repoUrl: null });
    const { repoUrl: _dropped, ...withoutRepo } = mapping;
    expect(projectPathMappingSchema.parse(withoutRepo)).toEqual(withoutRepo);
  });

  it("rejects malformed mappings and unknown fields", () => {
    expect(() => projectPathMappingSchema.parse({ ...mapping, pathPrefix: "" })).toThrow();
    expect(() => projectPathMappingSchema.parse({ ...mapping, pathPrefix: "x".repeat(501) })).toThrow();
    expect(() => projectPathMappingSchema.parse({ ...mapping, kind: "domain" })).toThrow();
    expect(() => projectPathMappingSchema.parse({ ...mapping, projectId: "not-a-uuid" })).toThrow();
    expect(() => projectPathMappingSchema.parse({ ...mapping, branch: "main" })).toThrow();
  });

  it("accepts url rules as scheme-less host patterns with a single trailing glob", () => {
    for (const pattern of ["github.com/acme/*", "*.figma.com/files/*", "app.linear.app/acme/*", "quickbooks.com"]) {
      expect(projectPathMappingSchema.parse({ ...mapping, kind: "url_rule", pathPrefix: pattern })).toEqual({
        ...mapping,
        kind: "url_rule",
        pathPrefix: pattern,
      });
    }
  });

  it("rejects url rules with a scheme, an uppercase host, or a misplaced glob", () => {
    for (const pattern of [
      "https://github.com/acme/*",
      "GitHub.com/acme/*",
      "github.com/*/acme",
      "github.com/acme/*/pulls",
      "github.com/acme/*foo",
      "github.com/acme?tab=issues",
      "github .com/acme/*",
    ]) {
      expect(() => projectPathMappingSchema.parse({ ...mapping, kind: "url_rule", pathPrefix: pattern })).toThrow();
    }
    // Path prefixes are not URL rules and stay unvalidated.
    expect(projectPathMappingSchema.parse({ ...mapping, pathPrefix: "C:/dev/*" })).toEqual({ ...mapping, pathPrefix: "C:/dev/*" });
  });

  it("accepts create and update requests without a server-assigned id", () => {
    const { id: _dropped, ...createRequest } = mapping;
    expect(pathMappingCreateRequestSchema.parse(createRequest)).toEqual(createRequest);
    expect(() => pathMappingCreateRequestSchema.parse(mapping)).toThrow();
    expect(() => pathMappingCreateRequestSchema.parse({ pathPrefix: mapping.pathPrefix })).toThrow();

    // Kind defaults to a path prefix on create; url rules validate their pattern.
    const { kind: _kind, ...withoutKind } = createRequest;
    expect(pathMappingCreateRequestSchema.parse(withoutKind)).toEqual(createRequest);
    expect(
      pathMappingCreateRequestSchema.parse({ ...withoutKind, kind: "url_rule", pathPrefix: "github.com/acme/*" }),
    ).toEqual({ ...withoutKind, kind: "url_rule", pathPrefix: "github.com/acme/*" });
    expect(() =>
      pathMappingCreateRequestSchema.parse({ ...withoutKind, kind: "url_rule", pathPrefix: "https://github.com/*" }),
    ).toThrow();

    expect(pathMappingUpdateRequestSchema.parse({})).toEqual({});
    expect(pathMappingUpdateRequestSchema.parse({ pathPrefix: "D:/work", repoUrl: null })).toEqual({ pathPrefix: "D:/work", repoUrl: null });
    expect(pathMappingUpdateRequestSchema.parse({ kind: "url_rule", pathPrefix: "*.figma.com/files/*" })).toEqual({
      kind: "url_rule",
      pathPrefix: "*.figma.com/files/*",
    });
    expect(() => pathMappingUpdateRequestSchema.parse({ kind: "url_rule", pathPrefix: "github.com/*/acme" })).toThrow();
    expect(() => pathMappingUpdateRequestSchema.parse({ id: ids.session })).toThrow();
    expect(() => pathMappingUpdateRequestSchema.parse({ pathPrefix: "" })).toThrow();
  });

  it("accepts a list response of mappings", () => {
    expect(pathMappingListResponseSchema.parse({ mappings: [mapping] })).toEqual({ mappings: [mapping] });
    expect(pathMappingListResponseSchema.parse({ mappings: [] })).toEqual({ mappings: [] });
    expect(() => pathMappingListResponseSchema.parse({ mappings: [mapping], total: 1 })).toThrow();
  });
});

describe("personal stats contracts", () => {
  const stats = {
    filters: { from: "2026-08-01", to: "2026-08-06" },
    totalDurationSeconds: 7_200,
    attributedSeconds: 5_400,
    unattributedSeconds: 1_800,
    projects: [
      {
        project: { id: ids.project, name: "Website redesign" },
        durationSeconds: 7_200,
        attributedSeconds: 5_400,
        unattributedSeconds: 1_800,
        sessionCount: 2,
      },
    ],
    apps: [
      { processName: "Code.exe", durationSeconds: 4_800 },
      { processName: "chrome.exe", durationSeconds: 1_200 },
    ],
    sites: [
      {
        mapping: { id: ids.user, pattern: "github.com/acme/*", projectId: ids.project },
        durationSeconds: 900,
      },
      {
        mapping: { id: ids.session, pattern: "quickbooks.com", projectId: null },
        durationSeconds: 300,
      },
    ],
  };

  it("accepts a per-project attributed/unattributed split with a per-app breakdown", () => {
    expect(meStatsResponseSchema.parse(stats)).toEqual(stats);
    expect(meStatsResponseSchema.parse({ ...stats, filters: {}, projects: [], apps: [], sites: [] })).toEqual({ ...stats, filters: {}, projects: [], apps: [], sites: [] });
    expect(meStatsResponseSchema.parse({
      ...stats,
      filters: { fromAt: "2026-08-06T05:00:00.000Z", toExclusiveAt: "2026-08-07T05:00:00.000Z" },
    })).toMatchObject({ filters: { fromAt: "2026-08-06T05:00:00.000Z", toExclusiveAt: "2026-08-07T05:00:00.000Z" } });
  });

  it("rejects unsafe or negative counters and unknown fields", () => {
    expect(() => meStatsResponseSchema.parse({ ...stats, attributedSeconds: -1 })).toThrow();
    expect(() => meStatsResponseSchema.parse({ ...stats, totalDurationSeconds: 1.5 })).toThrow();
    expect(() => meStatsResponseSchema.parse({ ...stats, totalDurationSeconds: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
    expect(() => meStatsResponseSchema.parse({ ...stats, filters: { from: "2026-99-99" } })).toThrow();
    expect(() => meStatsResponseSchema.parse({ ...stats, filters: { fromAt: "2026-08-06T05:00:00.000Z" } })).toThrow();
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      filters: { from: "2026-08-06", fromAt: "2026-08-06T05:00:00.000Z", toExclusiveAt: "2026-08-07T05:00:00.000Z" },
    })).toThrow();
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      projects: [{ ...stats.projects[0], attributedSeconds: undefined }],
    })).toThrow();
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      projects: [{ ...stats.projects[0], project: { ...stats.projects[0]!.project, color: "#2563eb" } }],
    })).toThrow();
    expect(() => meStatsResponseSchema.parse({ ...stats, apps: undefined })).toThrow();
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      apps: [{ processName: "Code.exe", durationSeconds: -1 }],
    })).toThrow();
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      apps: [{ processName: "Code.exe", durationSeconds: 60, title: "main.ts" }],
    })).toThrow();
    expect(() => meStatsResponseSchema.parse({ ...stats, sites: undefined })).toThrow();
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      sites: [{ mapping: { id: ids.user, pattern: "github.com/acme/*", projectId: ids.project }, durationSeconds: -1 }],
    })).toThrow();
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      sites: [{ mapping: { id: ids.user, pattern: "github.com/acme/*", projectId: undefined }, durationSeconds: 60 }],
    })).toThrow();
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      sites: [{ mapping: { id: ids.user, pattern: "github.com/acme/*", projectId: null, url: "https://github.com/acme" }, durationSeconds: 60 }],
    })).toThrow();
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      sites: [{ mapping: { id: ids.user, pattern: "x".repeat(501), projectId: null }, durationSeconds: 60 }],
    })).toThrow();
  });
});
