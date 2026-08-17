import { describe, expect, it } from "vitest";

import { agentRuntimeIds } from "./agent-runtimes.js";
import {
  activitySegmentBatchRequestSchema,
  agentMergeRequestSchema,
  agentPatchRequestSchema,
  agentPaystubFiltersSchema,
  agentPaystubResponseSchema,
  agentsReportFiltersSchema,
  agentsReportResponseSchema,
  agentsReportRowSchema,
  agentSchema,
  agentsListResponseSchema,
  agentStatusValues,
  agentUsageBatchRequestSchema,
  agentUsageBatchResponseSchema,
  agentUsageUploadSchema,
  shiftCommitBatchRequestSchema,
  shiftCommitBatchResponseSchema,
  shiftCommitUploadSchema,
  shiftCommitVerificationValues,
  shiftCommitViewSchema,
  activitySegmentBatchResponseSchema,
  activitySegmentKindValues,
  activitySegmentUploadSchema,
  agentEventKindValues,
  agentSessionEventBatchRequestSchema,
  agentSessionEventBatchResponseSchema,
  agentSessionEventSchema,
  apiErrorSchema,
  currentSessionResponseSchema,
  hourlyBucketSchema,
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
      activeSeconds: 3_600,
      agentSeconds: 5_400,
      concurrency: { t0Seconds: 1_800, t1Seconds: 0, t2Seconds: 1_800, t3PlusSeconds: 0, awaySeconds: 1_800 },
      byAgent: [{ source: "claude_code", model: null, durationSeconds: 5_400, sessionCount: 1, maxConcurrent: 1, medianSeconds: 5_400 }],
    };
    expect(
      leaderboardResponseSchema.parse({ filters: {}, totalDurationSeconds: 3_600, medianSessionSeconds: 1_800, entries: [entry] }),
    ).toMatchObject({ entries: [{ rank: 1, attributedSeconds: 1_800 }] });
    const { attributedSeconds: _droppedFromEntry, ...unattributedEntry } = entry;
    expect(() => leaderboardResponseSchema.parse({ filters: {}, totalDurationSeconds: 0, medianSessionSeconds: null, entries: [unattributedEntry] })).toThrow();
    expect(() => leaderboardResponseSchema.parse({ filters: {}, totalDurationSeconds: 0, medianSessionSeconds: null, entries: [{ ...entry, attributedSeconds: 1.5 }] })).toThrow();
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

  it("covers every event kind and takes any canonically shaped runtime", () => {
    expect(agentEventKindValues).toEqual(["started", "ended", "heartbeat"]);
    // The roster names runtimes; it does not gate them. A CLI nobody has
    // declared yet is recorded under its own id, so adding one never waits on
    // a contract change.
    for (const source of [...agentRuntimeIds, "agent_9", "muse"]) {
      expect(agentSessionEventSchema.parse({ ...event, source }).source).toBe(source);
    }
  });

  it("records the model beside the runtime, and neither implies the other", () => {
    const withModel = { ...event, source: "pi", model: "deepseek-v4-pro" };
    expect(agentSessionEventSchema.parse(withModel)).toEqual(withModel);
    // A runtime that names no model records none rather than a guess.
    expect(agentSessionEventSchema.parse({ ...event, source: "pi" }).model).toBeUndefined();
    expect(() => agentSessionEventSchema.parse({ ...event, model: "" })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...event, model: "x".repeat(201) })).toThrow();
  });

  it("accepts a bounded batch of agent session events", () => {
    expect(agentSessionEventSchema.parse(event)).toEqual(event);
    expect(
      agentSessionEventBatchRequestSchema.parse({ events: [event, { ...event, event: "ended", occurredAt: stoppedAt }] }).events,
    ).toHaveLength(2);
  });

  it("rejects an agent event carrying a ruleId and requires a cwd", () => {
    expect(() => agentSessionEventSchema.parse({ ...event, ruleId: ids.session })).toThrow();
    const { cwd: _dropped, ...withoutCwd } = event;
    expect(() => agentSessionEventSchema.parse(withoutCwd)).toThrow();
  });

  it("rejects malformed events and out-of-bounds batches", () => {
    expect(() => agentSessionEventSchema.parse({ ...event, source: "claude-code" })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...event, source: "Claude Code" })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...event, source: "9lives" })).toThrow();
    expect(() => agentSessionEventSchema.parse({ ...event, source: "x".repeat(41) })).toThrow();
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
    activeSeconds: 7_000,
    agentSeconds: 3_600,
    concurrency: { t0Seconds: 3_400, t1Seconds: 3_600, t2Seconds: 0, t3PlusSeconds: 0, awaySeconds: 0 },
    byAgent: [{ source: "claude_code", model: null, durationSeconds: 3_600, sessionCount: 1, maxConcurrent: 1, medianSeconds: 3_600 }],
    hourly: [],
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
    agents: [
      {
        agent: { id: ids.session, name: "Claude Code @ Website redesign", source: "claude_code", status: "anonymous", project: { id: ids.project, name: "Website redesign" }, createdAt: startedAt },
        agentSeconds: 3_600,
        shiftCount: 1,
        commitsRecorded: 1,
        commitsPending: 0,
        commitsMerged: 1,
        commitsReverted: 0,
        commitsOrphaned: 0,
        heldRate: 1,
        models: ["claude-fable-5"],
        repos: ["clock-in"],
        tokens: { inputTokens: 12_000, outputTokens: 800, cacheCreationInputTokens: 400, cacheReadInputTokens: 60_000 },
        tokensReported: true,
      },
    ],
  };

  it("accepts a per-project attributed/unattributed split with a per-app breakdown", () => {
    expect(meStatsResponseSchema.parse(stats)).toEqual(stats);
    expect(meStatsResponseSchema.parse({ ...stats, filters: {}, projects: [], apps: [], sites: [], agents: [] })).toEqual({ ...stats, filters: {}, projects: [], apps: [], sites: [], agents: [] });
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
    expect(() => meStatsResponseSchema.parse({ ...stats, agents: undefined })).toThrow();
    // The caller's own agent rows never carry an owner - it is redundant here.
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      agents: [{ ...stats.agents[0], agent: { ...stats.agents[0]!.agent, owner: { id: ids.user, name: "Alex Morgan" } } }],
    })).toThrow();
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      agents: [{ ...stats.agents[0], heldRate: 1.5 }],
    })).toThrow();
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      agents: [{ ...stats.agents[0], tokens: { ...stats.agents[0]!.tokens, inputTokens: -1 } }],
    })).toThrow();
    expect(() => meStatsResponseSchema.parse({
      ...stats,
      agents: [{ ...stats.agents[0], tokens: undefined }],
    })).toThrow();
  });

  it("keeps hourly token fields nullable so an unreported hour never reads as zero", () => {
    const bucket = {
      hourStart: startedAt,
      activeSeconds: 3_600,
      agentSeconds: 1_800,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
    };
    expect(hourlyBucketSchema.parse(bucket)).toEqual(bucket);
    const reported = { ...bucket, inputTokens: 12_000, cacheReadInputTokens: 60_000 };
    expect(hourlyBucketSchema.parse(reported)).toEqual(reported);
    // An invented zero is a different fact than "nothing reported" - but the
    // schema only insists the fields exist and stay nonnegative integers.
    expect(() => hourlyBucketSchema.parse({ ...bucket, inputTokens: undefined })).toThrow();
    expect(() => hourlyBucketSchema.parse({ ...bucket, outputTokens: -1 })).toThrow();
    expect(() => hourlyBucketSchema.parse({ ...bucket, cacheReadInputTokens: 1.5 })).toThrow();
  });
});

describe("roster agent contracts", () => {
  const agent = {
    id: ids.session,
    name: "Claude Code @ Website redesign",
    source: "claude_code",
    status: "anonymous",
    owner: { id: ids.user, name: "Alex Morgan" },
    project: { id: ids.project, name: "Website redesign" },
    createdAt: startedAt,
  };

  it("covers every agent status and accepts a listed agent", () => {
    expect(agentStatusValues).toEqual(["anonymous", "registered", "retired"]);
    expect(() => agentSchema.parse(agent)).not.toThrow();
    expect(() => agentSchema.parse({ ...agent, project: null })).not.toThrow();
    expect(() => agentsListResponseSchema.parse({ agents: [agent] })).not.toThrow();
  });

  it("rejects malformed agents", () => {
    expect(() => agentSchema.parse({ ...agent, name: "" })).toThrow();
    expect(() => agentSchema.parse({ ...agent, name: "x".repeat(201) })).toThrow();
    expect(() => agentSchema.parse({ ...agent, status: "fired" })).toThrow();
    expect(() => agentSchema.parse({ ...agent, source: "Claude Code" })).toThrow();
    expect(() => agentSchema.parse({ ...agent, extra: true })).toThrow();
  });

  it("requires at least one field on a patch and refuses anonymous as a target", () => {
    expect(() => agentPatchRequestSchema.parse({ name: "Reviewer" })).not.toThrow();
    expect(() => agentPatchRequestSchema.parse({ status: "registered", ownerUserId: ids.user })).not.toThrow();
    expect(() => agentPatchRequestSchema.parse({})).toThrow();
    // Anonymous is where agents start, never where a patch sends them.
    expect(() => agentPatchRequestSchema.parse({ status: "anonymous" })).toThrow();
    expect(() => agentPatchRequestSchema.parse({ name: "Reviewer", extra: true })).toThrow();
  });

  it("names the merge loser in the body; the path names the winner", () => {
    expect(() => agentMergeRequestSchema.parse({ loserId: ids.session })).not.toThrow();
    expect(() => agentMergeRequestSchema.parse({})).toThrow();
    expect(() => agentMergeRequestSchema.parse({ loserId: "not-a-uuid" })).toThrow();
  });

  it("takes paystub bounds like every other report filter", () => {
    expect(() => agentPaystubFiltersSchema.parse({})).not.toThrow();
    expect(() => agentPaystubFiltersSchema.parse({ fromAt: startedAt, toExclusiveAt: stoppedAt })).not.toThrow();
    // Instant bounds arrive together and never mixed with calendar dates.
    expect(() => agentPaystubFiltersSchema.parse({ fromAt: startedAt })).toThrow();
    expect(() => agentPaystubFiltersSchema.parse({ from: "2026-08-06", fromAt: startedAt, toExclusiveAt: stoppedAt })).toThrow();
  });

  it("accepts a complete paystub, commit record included", () => {
    expect(shiftCommitVerificationValues).toEqual(["pending", "merged", "reverted", "orphaned"]);
    const commit = {
      id: ids.client,
      repoRoot: "C:/dev/clock-in",
      branch: "feat/roster",
      sha: "a".repeat(40),
      subject: "feat(api): roster agents",
      authoredAt: startedAt,
      verification: "merged",
      verifiedAt: stoppedAt,
    };
    expect(() => shiftCommitViewSchema.parse(commit)).not.toThrow();
    expect(() => shiftCommitViewSchema.parse({ ...commit, branch: null, verification: "pending", verifiedAt: null })).not.toThrow();
    expect(() => shiftCommitViewSchema.parse({ ...commit, sha: "xyz" })).toThrow();

    const paystub = {
      agent,
      filters: { fromAt: startedAt, toExclusiveAt: stoppedAt },
      totals: {
        agentSeconds: 3_600,
        shiftCount: 1,
        commitsRecorded: 1,
        commitsPending: 0,
        commitsMerged: 1,
        commitsReverted: 0,
        commitsOrphaned: 0,
        heldRate: 1,
        tokens: { inputTokens: 12_000, outputTokens: 800, cacheCreationInputTokens: 400, cacheReadInputTokens: 60_000 },
        tokensReported: true,
        ownerActiveSeconds: 1_800,
        awaySeconds: 1_800,
      },
      models: [{ model: "claude-fable-5", agentSeconds: 3_600, shiftCount: 1, maxConcurrent: 1, medianSeconds: 3_600, tokens: { inputTokens: 12_000, outputTokens: 800, cacheCreationInputTokens: 400, cacheReadInputTokens: 60_000 } }],
      codebases: [{ repo: "clock-in", agentSeconds: 3_600, shiftCount: 1 }],
      shifts: [{
        id: ids.session,
        startedAt,
        endedAt: stoppedAt,
        model: "claude-fable-5",
        durationSeconds: 3_600,
        repo: "clock-in",
        commits: [commit],
      }],
      trend: [{ periodStartAt: startedAt, agentSeconds: 3_600, shiftCount: 1, heldRate: 1 }],
      hourly: [],
    };
    expect(() => agentPaystubResponseSchema.parse(paystub)).not.toThrow();
    // Before any commit or token capture exists the same shape carries zeros
    // and nulls: a model that reported nothing keeps null tokens, so absence
    // stays absence.
    expect(() => agentPaystubResponseSchema.parse({
      ...paystub,
      totals: {
        ...paystub.totals,
        commitsRecorded: 0,
        commitsMerged: 0,
        heldRate: null,
        tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
        tokensReported: false,
      },
      models: [{ model: null, agentSeconds: 3_600, shiftCount: 1, maxConcurrent: 1, medianSeconds: 3_600, tokens: null }],
      codebases: [{ repo: null, agentSeconds: 3_600, shiftCount: 1 }],
      shifts: [{ ...paystub.shifts[0], repo: null, commits: [] }],
      trend: [{ periodStartAt: startedAt, agentSeconds: 0, shiftCount: 0, heldRate: null }],
    })).not.toThrow();
    expect(() => agentPaystubResponseSchema.parse({
      ...paystub,
      totals: { ...paystub.totals, heldRate: 1.5 },
    })).toThrow();
    expect(() => agentPaystubResponseSchema.parse({
      ...paystub,
      totals: { ...paystub.totals, tokens: undefined },
    })).toThrow();
    expect(() => agentPaystubResponseSchema.parse({
      ...paystub,
      models: [{ ...paystub.models[0], tokens: { inputTokens: 0 } }],
    })).toThrow();
    // The owner split and the per-model session facts are optional the way
    // every field added after a response shipped is: the API and the
    // dashboard deploy separately, so a client must read absence as absence.
    expect(() => agentPaystubResponseSchema.parse({
      ...paystub,
      totals: { ...paystub.totals, ownerActiveSeconds: undefined, awaySeconds: undefined },
      models: [{ model: "claude-fable-5", agentSeconds: 3_600, shiftCount: 1, tokens: null }],
    })).not.toThrow();
    // A codebase label is a name, never a path.
    expect(() => agentPaystubResponseSchema.parse({
      ...paystub,
      shifts: [{ ...paystub.shifts[0], repo: "x".repeat(201) }],
    })).toThrow();
  });

  it("takes report bounds with a project scope, like the leaderboard", () => {
    expect(() => agentsReportFiltersSchema.parse({})).not.toThrow();
    expect(() => agentsReportFiltersSchema.parse({ scope: "unassigned" })).not.toThrow();
    expect(() => agentsReportFiltersSchema.parse({ fromAt: startedAt, toExclusiveAt: stoppedAt })).not.toThrow();
    expect(() => agentsReportFiltersSchema.parse({ fromAt: startedAt })).toThrow();
    expect(() => agentsReportFiltersSchema.parse({ from: "2026-08-06", fromAt: startedAt, toExclusiveAt: stoppedAt })).toThrow();
  });

  it("ranks the pay-run report by hours or tokens when asked, and nothing else", () => {
    expect(agentsReportFiltersSchema.parse({ sort: "hours" })).toEqual({ sort: "hours" });
    expect(agentsReportFiltersSchema.parse({ sort: "tokens" })).toEqual({ sort: "tokens" });
    expect(() => agentsReportFiltersSchema.parse({ sort: "commits" })).toThrow();
  });

  it("reports every roster agent with its held share and an active/retired headcount", () => {
    const row = {
      agent,
      agentSeconds: 3_600,
      shiftCount: 1,
      commitsRecorded: 1,
      commitsPending: 0,
      commitsMerged: 1,
      commitsReverted: 0,
      commitsOrphaned: 0,
      heldRate: 1,
      models: ["claude-fable-5"],
      repos: ["clock-in"],
      tokens: { inputTokens: 12_000, outputTokens: 800, cacheCreationInputTokens: 400, cacheReadInputTokens: 60_000 },
      tokensReported: true,
    };
    expect(() => agentsReportRowSchema.parse(row)).not.toThrow();
    // A roster agent with no activity in range still gets a row: zeros, a null
    // rate, and no models named. tokensReported false marks the zeros as "no
    // rows", never as a measured zero.
    expect(() => agentsReportRowSchema.parse({
      ...row,
      agentSeconds: 0,
      shiftCount: 0,
      commitsRecorded: 0,
      commitsMerged: 0,
      heldRate: null,
      models: [],
      repos: [],
      tokens: { inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      tokensReported: false,
    })).not.toThrow();
    expect(() => agentsReportRowSchema.parse({ ...row, heldRate: 1.5 })).toThrow();
    expect(() => agentsReportRowSchema.parse({ ...row, models: Array.from({ length: 21 }, (_, index) => `model-${index}`) })).toThrow();
    expect(() => agentsReportRowSchema.parse({ ...row, tokens: { ...row.tokens, outputTokens: -1 } })).toThrow();
    expect(() => agentsReportRowSchema.parse({ ...row, tokensReported: undefined })).toThrow();

    const report = {
      filters: {},
      headcount: { total: 4, active: 3, retired: 1 },
      rows: [row],
    };
    expect(() => agentsReportResponseSchema.parse(report)).not.toThrow();
    expect(() => agentsReportResponseSchema.parse({ ...report, rows: [] })).not.toThrow();
    expect(() => agentsReportResponseSchema.parse({ ...report, headcount: { ...report.headcount, total: -1 } })).toThrow();
    expect(() => agentsReportResponseSchema.parse({ ...report, headcount: { ...report.headcount, extra: 1 } })).toThrow();
  });
});

describe("shift commit upload contracts", () => {
  const upload = {
    clientId: ids.client,
    source: "claude_code",
    externalSessionId: "session-1",
    repoRoot: "C:/dev/clock-in",
    branch: "feat/roster",
    sha: "a".repeat(40),
    subject: "feat(api): shift commits",
    authoredAt: startedAt,
    verification: "pending",
  };

  it("accepts a decided upload and a pending one without a branch", () => {
    expect(() => shiftCommitUploadSchema.parse(upload)).not.toThrow();
    expect(() => shiftCommitUploadSchema.parse({
      ...upload,
      branch: undefined,
      verification: "merged",
      verifiedAt: stoppedAt,
    })).not.toThrow();
  });

  it("rejects an unshaped sha and unknown fields", () => {
    expect(() => shiftCommitUploadSchema.parse({ ...upload, sha: "not-a-sha" })).toThrow();
    expect(() => shiftCommitUploadSchema.parse({ ...upload, extra: true })).toThrow();
  });

  it("accepts a bounded batch and a per-commit accepted/rejected response", () => {
    expect(() => shiftCommitBatchRequestSchema.parse({ commits: [upload] })).not.toThrow();
    expect(() => shiftCommitBatchRequestSchema.parse({ commits: [] })).toThrow();
    expect(() => shiftCommitBatchRequestSchema.parse({ commits: Array.from({ length: 501 }, () => upload) })).toThrow();
    expect(() => shiftCommitBatchResponseSchema.parse({
      accepted: 1,
      // unknown_session is the one retryable reason; the client keeps the row unsynced.
      rejected: [{ clientId: ids.client, reason: "unknown_session" }],
    })).not.toThrow();
  });
});

describe("agent usage upload contracts", () => {
  const upload = {
    clientId: ids.client,
    source: "claude_code",
    externalSessionId: "session-1",
    bucketStartAt: startedAt,
    model: "claude-opus-4-8",
    sidechain: false,
    inputTokens: 12_000,
    outputTokens: 3_400,
    cacheCreationInputTokens: 800,
    cacheReadInputTokens: 45_000,
  };

  it("accepts a named-model upload and one whose runtime named no model", () => {
    expect(() => agentUsageUploadSchema.parse(upload)).not.toThrow();
    expect(() => agentUsageUploadSchema.parse({ ...upload, model: undefined })).not.toThrow();
  });

  it("rejects unknown fields and negative, fractional, or unsafe counters", () => {
    expect(() => agentUsageUploadSchema.parse({ ...upload, extra: true })).toThrow();
    expect(() => agentUsageUploadSchema.parse({ ...upload, inputTokens: -1 })).toThrow();
    expect(() => agentUsageUploadSchema.parse({ ...upload, outputTokens: 1.5 })).toThrow();
    expect(() => agentUsageUploadSchema.parse({ ...upload, cacheReadInputTokens: Number.MAX_SAFE_INTEGER + 1 })).toThrow();
  });

  it("rejects an empty model and an empty external session id", () => {
    expect(() => agentUsageUploadSchema.parse({ ...upload, model: "" })).toThrow();
    expect(() => agentUsageUploadSchema.parse({ ...upload, externalSessionId: "" })).toThrow();
  });

  it("accepts a bounded batch and a per-entry accepted/rejected response", () => {
    expect(() => agentUsageBatchRequestSchema.parse({ usage: [upload] })).not.toThrow();
    expect(() => agentUsageBatchRequestSchema.parse({ usage: [] })).toThrow();
    expect(() => agentUsageBatchRequestSchema.parse({ usage: Array.from({ length: 501 }, () => upload) })).toThrow();
    expect(() => agentUsageBatchResponseSchema.parse({
      accepted: 1,
      // unknown_session is the one retryable reason; the client keeps the row unsynced.
      rejected: [{ clientId: ids.client, reason: "unknown_session" }],
    })).not.toThrow();
  });
});
