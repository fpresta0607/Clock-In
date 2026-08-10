import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import type { AuthenticatedSubject } from "../auth.js";
import { parseEnv } from "../env.js";
import type {
  AgentSessionRepository,
  AgentSessionStaleCutoffs,
  AppTotalRecord,
  PathMappingRepository,
  ProjectRepository,
  ProjectTotalRecord,
  ReportQuery,
  ReportRepository,
  SessionRepository,
  SiteTotalRecord,
} from "../repositories.js";
import { createTestAuth } from "../test-tokens.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  otherOrganization: "1e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  teammate: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherProject: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
  AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth",
  NODE_ENV: "test",
});
const clockNow = new Date("2026-08-06T14:00:00.000Z");
const users = {
  [ids.user]: { id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization },
  [ids.teammate]: { id: ids.teammate, email: "blair@example.com", name: "Blair", organizationId: ids.organization },
};

let keys: Awaited<ReturnType<typeof createTestAuth>>["keys"];
let bearerHeader: string;
let teammateBearerHeader: string;

beforeAll(async () => {
  const auth = await createTestAuth(config, clockNow);
  keys = auth.keys;
  bearerHeader = await auth.bearer(ids.user);
  teammateBearerHeader = await auth.bearer(ids.teammate);
});

interface StoredSession {
  id: string;
  organizationId: string;
  userId: string;
  project: { id: string; name: string };
  status: "stopped" | "needs_review";
  startedAt: Date;
  stoppedAt: Date;
  idleSeconds: number;
  durationSeconds: number;
}

interface StoredSegment {
  organizationId: string;
  userId: string;
  kind: "active" | "idle" | "locked" | "suspended";
  processName?: string | null;
  startedAt: Date;
  endedAt: Date;
  receivedAt: Date;
}

interface StoredAgent {
  organizationId: string;
  userId: string;
  source: "claude_code" | "codex" | "kimi_code" | "cursor" | "browser" | "other";
  linkedSessionId: string | null;
  ruleId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  lastEventAt: Date;
  receivedAt: Date;
}

interface StoredMapping {
  id: string;
  organizationId: string;
  userId: string;
  kind: "path_prefix" | "url_rule";
  pattern: string;
  projectId: string;
}

const freshnessWindowMs = 7 * 24 * 60 * 60 * 1_000;

function overlapSeconds(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): number {
  return Math.max(0, Math.min(aEnd.getTime(), bEnd.getTime()) - Math.max(aStart.getTime(), bStart.getTime())) / 1_000;
}

/**
 * Mirrors the repository's corroboration semantics — the same completed-session
 * filters, freshness window, and duration cap as the SQL — so the route tests
 * exercise scoping and freshness through the real service and route stack.
 */
class MemoryReports implements ReportRepository {
  public readonly sessions: StoredSession[] = [];
  public readonly segments: StoredSegment[] = [];
  public readonly agents: StoredAgent[] = [];
  public readonly mappings: StoredMapping[] = [];

  private exactRange(query: ReportQuery): { from: Date; toExclusive: Date } | null {
    if (!query.clipToRange || query.from === undefined || query.toExclusive === undefined) return null;
    return { from: query.from, toExclusive: query.toExclusive };
  }

  private sessionDuration(session: StoredSession, query: ReportQuery): number {
    const range = this.exactRange(query);
    if (range === null) return session.durationSeconds;
    return Math.min(session.durationSeconds, Math.floor(overlapSeconds(session.startedAt, session.stoppedAt, range.from, range.toExclusive)));
  }

  private corroborated(session: StoredSession, query: ReportQuery): number {
    const range = this.exactRange(query);
    const sessionStart = range === null
      ? session.startedAt
      : new Date(Math.max(session.startedAt.getTime(), range.from.getTime()));
    const sessionEnd = range === null
      ? session.stoppedAt
      : new Date(Math.min(session.stoppedAt.getTime(), range.toExclusive.getTime()));
    let total = 0;
    for (const segment of this.segments) {
      if (segment.organizationId !== session.organizationId || segment.userId !== session.userId || segment.kind !== "active") continue;
      if (segment.receivedAt.getTime() > segment.endedAt.getTime() + freshnessWindowMs) continue;
      total += overlapSeconds(segment.startedAt, segment.endedAt, sessionStart, sessionEnd);
    }
    for (const agent of this.agents) {
      // Browser spans attribute; they never corroborate.
      if (agent.source === "browser") continue;
      if (agent.organizationId !== session.organizationId || agent.linkedSessionId !== session.id) continue;
      const occurredAt = agent.endedAt ?? agent.lastEventAt;
      if (agent.receivedAt.getTime() > occurredAt.getTime() + freshnessWindowMs) continue;
      total += overlapSeconds(agent.startedAt, occurredAt, sessionStart, sessionEnd);
    }
    return Math.min(this.sessionDuration(session, query), Math.floor(total));
  }

  private filtered(subject: AuthenticatedSubject, query: ReportQuery): StoredSession[] {
    const range = this.exactRange(query);
    return this.sessions.filter((session) => session.organizationId === subject.organizationId
      && (range === null
        ? (query.from === undefined || session.startedAt >= query.from)
          && (query.toExclusive === undefined || session.startedAt < query.toExclusive)
        : session.startedAt < range.toExclusive && session.stoppedAt > range.from)
      && (query.userId === undefined || session.userId === query.userId)
      && (query.projectId === undefined || session.project.id === query.projectId));
  }

  public async readProjectTotalsForMember(subject: AuthenticatedSubject, query: ReportQuery): Promise<ProjectTotalRecord[]> {
    const byProject = new Map<string, ProjectTotalRecord>();
    for (const session of this.filtered(subject, query)) {
      const existing = byProject.get(session.project.id)
        ?? { project: session.project, durationSeconds: 0, corroboratedSeconds: 0, sessionCount: 0 };
      existing.durationSeconds = (existing.durationSeconds as number) + this.sessionDuration(session, query);
      existing.corroboratedSeconds = (existing.corroboratedSeconds as number) + this.corroborated(session, query);
      existing.sessionCount = (existing.sessionCount as number) + 1;
      byProject.set(session.project.id, existing);
    }
    return [...byProject.values()].sort((a, b) =>
      (b.durationSeconds as number) - (a.durationSeconds as number) || a.project.id.localeCompare(b.project.id));
  }

  /**
   * Mirrors the app-totals SQL: active segments with a process name, inside the
   * freshness window, clamped to the requested range, heaviest first.
   */
  public async readAppTotalsForMember(subject: AuthenticatedSubject, query: ReportQuery): Promise<AppTotalRecord[]> {
    const byProcess = new Map<string, number>();
    for (const segment of this.segments) {
      if (segment.organizationId !== subject.organizationId || segment.userId !== subject.userId) continue;
      if (segment.kind !== "active" || segment.processName == null) continue;
      if (segment.receivedAt.getTime() > segment.endedAt.getTime() + freshnessWindowMs) continue;
      const start = query.from === undefined ? segment.startedAt : new Date(Math.max(segment.startedAt.getTime(), query.from.getTime()));
      const end = query.toExclusive === undefined ? segment.endedAt : new Date(Math.min(segment.endedAt.getTime(), query.toExclusive.getTime()));
      const seconds = Math.max(0, (end.getTime() - start.getTime()) / 1_000);
      if (seconds === 0) continue;
      byProcess.set(segment.processName, (byProcess.get(segment.processName) ?? 0) + seconds);
    }
    return [...byProcess.entries()]
      .map(([processName, durationSeconds]) => ({ processName, durationSeconds: Math.floor(durationSeconds) }))
      .filter((entry) => entry.durationSeconds > 0)
      .sort((a, b) => b.durationSeconds - a.durationSeconds || a.processName.localeCompare(b.processName));
  }

  /**
   * Mirrors the site-totals SQL: browser spans joined to the caller's live url
   * rules, clipped to fresh active segments and the requested range, heaviest
   * first. Spans whose rule was deleted drop out with the mapping row.
   * Concurrent spans on the same rule merge before summing: two tabs on one
   * rule never count the same wall-clock second twice. Overlapping active
   * segments (two devices at once) merge the same way, so a rule total never
   * exceeds actual focused wall-clock time. Empty totals return no row.
   */
  public async readSiteTotalsForMember(subject: AuthenticatedSubject, query: ReportQuery): Promise<SiteTotalRecord[]> {
    const mergeIntervals = (intervals: { start: number; end: number }[]): { start: number; end: number }[] => {
      const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
      const merged: { start: number; end: number }[] = [];
      for (const interval of sorted) {
        const last = merged[merged.length - 1];
        if (last !== undefined && interval.start <= last.end) {
          last.end = Math.max(last.end, interval.end);
        } else {
          merged.push({ ...interval });
        }
      }
      return merged;
    };

    const spansByRule = new Map<string, { mapping: StoredMapping; intervals: { start: number; end: number }[] }>();
    for (const span of this.agents) {
      if (span.organizationId !== subject.organizationId || span.userId !== subject.userId) continue;
      if (span.source !== "browser" || span.ruleId === null) continue;
      const mapping = this.mappings.find((candidate) => candidate.organizationId === subject.organizationId
        && candidate.userId === subject.userId && candidate.kind === "url_rule" && candidate.id === span.ruleId);
      if (mapping === undefined) continue;
      const spanEnd = span.endedAt ?? span.lastEventAt;
      if (span.receivedAt.getTime() > spanEnd.getTime() + freshnessWindowMs) continue;
      const entry = spansByRule.get(mapping.id) ?? { mapping, intervals: [] };
      entry.intervals.push({ start: span.startedAt.getTime(), end: spanEnd.getTime() });
      spansByRule.set(mapping.id, entry);
    }
    const activeSegments = mergeIntervals(this.segments
      .filter((segment) => segment.organizationId === subject.organizationId
        && segment.userId === subject.userId
        && segment.kind === "active"
        && segment.receivedAt.getTime() <= segment.endedAt.getTime() + freshnessWindowMs)
      .map((segment) => ({ start: segment.startedAt.getTime(), end: segment.endedAt.getTime() })));

    const totals: SiteTotalRecord[] = [];
    for (const { mapping, intervals } of spansByRule.values()) {
      let seconds = 0;
      for (const span of mergeIntervals(intervals)) {
        for (const segment of activeSegments) {
          const start = Math.max(span.start, segment.start, query.from?.getTime() ?? 0);
          const end = Math.min(span.end, segment.end, query.toExclusive?.getTime() ?? Number.MAX_SAFE_INTEGER);
          seconds += Math.max(0, end - start) / 1_000;
        }
      }
      const durationSeconds = Math.floor(seconds);
      if (durationSeconds <= 0) continue;
      totals.push({ mapping: { id: mapping.id, pattern: mapping.pattern, projectId: mapping.projectId }, durationSeconds });
    }
    return totals.sort((a, b) => (b.durationSeconds as number) - (a.durationSeconds as number) || a.mapping.id.localeCompare(b.mapping.id));
  }

  public async findProjectForOrganization(): Promise<never> {
    throw new Error("not used by me/stats");
  }
  public async findUserForOrganization(): Promise<never> {
    throw new Error("not used by me/stats");
  }
  public async readPageForOrganization(): Promise<never> {
    throw new Error("not used by me/stats");
  }
  public async readExportForOrganization(): Promise<never> {
    throw new Error("not used by me/stats");
  }
  public async readLeaderboardForOrganization(): Promise<never> {
    throw new Error("not used by me/stats");
  }
}

/** Only the reaper runs on this read path; it records every invocation. */
class ReapRecorder implements Partial<AgentSessionRepository> {
  public readonly reapCalls: { subject: AuthenticatedSubject; cutoffs: AgentSessionStaleCutoffs }[] = [];
  public async reapStale(subject: AuthenticatedSubject, cutoffs: AgentSessionStaleCutoffs) {
    this.reapCalls.push({ subject, cutoffs });
    return 0;
  }
}

// The agent-session route group refuses to mount without its sibling
// repositories, so the app needs these stubs even though me/stats never calls them.
class Projects implements Partial<ProjectRepository> {
  public async listForMember() { return []; }
  public async findForMember() { return null; }
}

class Timers implements Partial<SessionRepository> {
  public async findRunning() { return null; }
}

class PathMappings implements Partial<PathMappingRepository> {
  public async listForSubject() { return []; }
}

function session(overrides: Partial<StoredSession> = {}): StoredSession {
  return {
    id: crypto.randomUUID(),
    organizationId: ids.organization,
    userId: ids.user,
    project: { id: ids.project, name: "Timer" },
    status: "stopped",
    startedAt: new Date("2026-08-05T14:00:00.000Z"),
    stoppedAt: new Date("2026-08-05T15:00:00.000Z"),
    idleSeconds: 0,
    durationSeconds: 3_600,
    ...overrides,
  };
}

function createTestApp(reports = new MemoryReports(), agentSessions = new ReapRecorder()) {
  return createApp({
    config,
    keys,
    accounts: { resolve: async (identity) => users[identity.authUserId as keyof typeof users] },
    clock: () => clockNow,
    reportRepository: reports,
    agentSessionRepository: agentSessions as AgentSessionRepository,
    projectRepository: new Projects() as ProjectRepository,
    sessionRepository: new Timers() as SessionRepository,
    pathMappingRepository: new PathMappings() as PathMappingRepository,
  });
}

describe("me/stats routes", () => {
  it("requires a signed bearer token", async () => {
    const response = await createTestApp().request("http://api.test/me/stats");
    expect(response.status).toBe(401);
  });

  it("rejects malformed and reversed date filters", async () => {
    const headers = { authorization: bearerHeader };
    const app = createTestApp();

    const malformed = await app.request("http://api.test/me/stats?from=last-tuesday", { headers });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid stats filters." } });

    const reversed = await app.request("http://api.test/me/stats?from=2026-08-07&to=2026-08-06", { headers });
    expect(reversed.status).toBe(400);
    await expect(reversed.json()).resolves.toEqual({
      error: { code: "validation_error", message: "The report date range must be between zero and 366 days." },
    });

    const incompleteInstantRange = await app.request("http://api.test/me/stats?fromAt=2026-08-06T05%3A00%3A00.000Z", { headers });
    expect(incompleteInstantRange.status).toBe(400);
  });

  it("uses canonical instant bounds for a local-calendar day", async () => {
    const reports = new MemoryReports();
    reports.segments.push(
      { organizationId: ids.organization, userId: ids.user, kind: "active", processName: "chrome.exe",
        startedAt: new Date("2026-08-06T04:30:00.000Z"), endedAt: new Date("2026-08-06T05:30:00.000Z"), receivedAt: new Date("2026-08-06T05:31:00.000Z") },
      { organizationId: ids.organization, userId: ids.user, kind: "active", processName: "chrome.exe",
        startedAt: new Date("2026-08-07T04:30:00.000Z"), endedAt: new Date("2026-08-07T05:30:00.000Z"), receivedAt: new Date("2026-08-07T05:31:00.000Z") },
    );

    const response = await createTestApp(reports).request(
      "http://api.test/me/stats?fromAt=2026-08-06T05%3A00%3A00.000Z&toExclusiveAt=2026-08-07T05%3A00%3A00.000Z",
      { headers: { authorization: bearerHeader } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      filters: { fromAt: "2026-08-06T05:00:00.000Z", toExclusiveAt: "2026-08-07T05:00:00.000Z" },
      apps: [{ processName: "chrome.exe", durationSeconds: 3_600 }],
    });
  });

  it("clips completed projects and corroboration at a local DST boundary", async () => {
    const reports = new MemoryReports();
    const crossing = session({
      startedAt: new Date("2026-03-08T05:30:00.000Z"),
      stoppedAt: new Date("2026-03-08T06:30:00.000Z"),
      durationSeconds: 3_600,
    });
    reports.sessions.push(crossing);
    reports.segments.push({
      organizationId: ids.organization, userId: ids.user, kind: "active", processName: "clock-in.exe",
      startedAt: crossing.startedAt, endedAt: crossing.stoppedAt, receivedAt: new Date("2026-03-08T06:31:00.000Z"),
    });

    const response = await createTestApp(reports).request(
      "http://api.test/me/stats?fromAt=2026-03-08T06%3A00%3A00.000Z&toExclusiveAt=2026-03-09T05%3A00%3A00.000Z",
      { headers: { authorization: bearerHeader } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      totalDurationSeconds: 1_800,
      corroboratedSeconds: 1_800,
      projects: [{ project: { id: ids.project }, durationSeconds: 1_800, corroboratedSeconds: 1_800, sessionCount: 1 }],
    });
  });

  it("splits corroborated from uncorroborated time per project for the caller only", async () => {
    const reports = new MemoryReports();
    // Fully corroborated by an active segment.
    const full = session();
    reports.sessions.push(full);
    reports.segments.push({
      organizationId: ids.organization, userId: ids.user, kind: "active",
      startedAt: full.startedAt, endedAt: full.stoppedAt, receivedAt: new Date("2026-08-05T15:05:00.000Z"),
    });
    // Half corroborated; the second half of the window has no evidence.
    const half = session({ startedAt: new Date("2026-08-05T16:00:00.000Z"), stoppedAt: new Date("2026-08-05T17:00:00.000Z") });
    reports.sessions.push(half);
    reports.segments.push({
      organizationId: ids.organization, userId: ids.user, kind: "active",
      startedAt: new Date("2026-08-05T16:00:00.000Z"), endedAt: new Date("2026-08-05T16:30:00.000Z"), receivedAt: new Date("2026-08-05T16:35:00.000Z"),
    });
    // Corroborated by a linked agent session, not by OS activity.
    const agentBacked = session({
      project: { id: ids.otherProject, name: "Side" },
      startedAt: new Date("2026-08-06T11:00:00.000Z"), stoppedAt: new Date("2026-08-06T12:00:00.000Z"),
    });
    reports.sessions.push(agentBacked);
    reports.agents.push({
      organizationId: ids.organization, userId: ids.user, source: "kimi_code", ruleId: null, linkedSessionId: agentBacked.id,
      startedAt: new Date("2026-08-06T11:15:00.000Z"), endedAt: new Date("2026-08-06T11:45:00.000Z"),
      lastEventAt: new Date("2026-08-06T11:45:00.000Z"), receivedAt: new Date("2026-08-06T11:50:00.000Z"),
    });
    // A linked browser span covers the rest of the window, but browser spans
    // attribute — they never corroborate — so the totals stay byte-identical.
    reports.agents.push({
      organizationId: ids.organization, userId: ids.user, source: "browser", ruleId: "01c7e513-b094-4d4c-ae55-21790ae019a4",
      linkedSessionId: agentBacked.id,
      startedAt: new Date("2026-08-06T11:00:00.000Z"), endedAt: new Date("2026-08-06T12:00:00.000Z"),
      lastEventAt: new Date("2026-08-06T12:00:00.000Z"), receivedAt: new Date("2026-08-06T12:05:00.000Z"),
    });
    // A teammate's fully corroborated session must never surface here.
    const teammates = session({ userId: ids.teammate });
    reports.sessions.push(teammates);
    reports.segments.push({
      organizationId: ids.organization, userId: ids.teammate, kind: "active",
      startedAt: teammates.startedAt, endedAt: teammates.stoppedAt, receivedAt: new Date("2026-08-05T15:05:00.000Z"),
    });

    const response = await createTestApp(reports).request("http://api.test/me/stats", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      filters: {},
      totalDurationSeconds: 10_800,
      corroboratedSeconds: 7_200,
      projects: [
        { project: { id: ids.project, name: "Timer" }, durationSeconds: 7_200, corroboratedSeconds: 5_400, sessionCount: 2 },
        { project: { id: ids.otherProject, name: "Side" }, durationSeconds: 3_600, corroboratedSeconds: 1_800, sessionCount: 1 },
      ],
      // None of the segments in this test carry a process name, and the
      // browser span's rule is not one of the caller's mappings.
      apps: [],
      sites: [],
    });
  });

  it("excludes evidence received more than seven days after it occurred", async () => {
    const reports = new MemoryReports();
    const late = session();
    reports.sessions.push(late);
    reports.segments.push({
      organizationId: ids.organization, userId: ids.user, kind: "active",
      startedAt: late.startedAt, endedAt: late.stoppedAt,
      // Uploaded eight days after the segment ended: stored, but not corroborating.
      receivedAt: new Date(late.stoppedAt.getTime() + 8 * 24 * 60 * 60 * 1_000),
    });
    const agentLate = session({ project: { id: ids.otherProject, name: "Side" } });
    reports.sessions.push(agentLate);
    reports.agents.push({
      organizationId: ids.organization, userId: ids.user, source: "kimi_code", ruleId: null, linkedSessionId: agentLate.id,
      startedAt: agentLate.startedAt, endedAt: agentLate.stoppedAt, lastEventAt: agentLate.stoppedAt,
      receivedAt: new Date(agentLate.stoppedAt.getTime() + 8 * 24 * 60 * 60 * 1_000),
    });

    const response = await createTestApp(reports).request("http://api.test/me/stats", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      totalDurationSeconds: 7_200,
      corroboratedSeconds: 0,
      projects: [
        { project: { id: ids.project }, corroboratedSeconds: 0 },
        { project: { id: ids.otherProject }, corroboratedSeconds: 0 },
      ],
    });
  });

  it("applies inclusive calendar date bounds like the org reports", async () => {
    const reports = new MemoryReports();
    reports.sessions.push(session({ startedAt: new Date("2026-08-05T14:00:00.000Z"), stoppedAt: new Date("2026-08-05T15:00:00.000Z") }));
    reports.sessions.push(session({
      project: { id: ids.otherProject, name: "Side" },
      startedAt: new Date("2026-08-06T09:00:00.000Z"), stoppedAt: new Date("2026-08-06T10:00:00.000Z"),
    }));

    const app = createTestApp(reports);
    const headers = { authorization: bearerHeader };

    const fifthOnly = await app.request("http://api.test/me/stats?from=2026-08-05&to=2026-08-05", { headers });
    expect(fifthOnly.status).toBe(200);
    await expect(fifthOnly.json()).resolves.toMatchObject({
      filters: { from: "2026-08-05", to: "2026-08-05" },
      totalDurationSeconds: 3_600,
      projects: [{ project: { id: ids.project }, sessionCount: 1 }],
    });

    const sixthOnly = await app.request("http://api.test/me/stats?from=2026-08-06&to=2026-08-06", { headers });
    await expect(sixthOnly.json()).resolves.toMatchObject({
      totalDurationSeconds: 3_600,
      projects: [{ project: { id: ids.otherProject }, sessionCount: 1 }],
    });

    const empty = await app.request("http://api.test/me/stats?from=2026-08-01&to=2026-08-02", { headers });
    await expect(empty.json()).resolves.toEqual({ filters: { from: "2026-08-01", to: "2026-08-02" }, totalDurationSeconds: 0, corroboratedSeconds: 0, projects: [], apps: [], sites: [] });
  });

  it("closes stale agent sessions on the read path before computing stats", async () => {
    const agentSessions = new ReapRecorder();
    const response = await createTestApp(new MemoryReports(), agentSessions).request("http://api.test/me/stats", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    expect(agentSessions.reapCalls).toEqual([{
      subject: { organizationId: ids.organization, userId: ids.user, role: "member" },
      cutoffs: {
        default: new Date(clockNow.getTime() - 6 * 60 * 60 * 1_000),
        browser: new Date(clockNow.getTime() - 10 * 60 * 1_000),
      },
    }]);
  });

  it("never includes another member's sessions or evidence in the caller's stats", async () => {
    const reports = new MemoryReports();
    const own = session({ durationSeconds: 1_200, startedAt: new Date("2026-08-05T14:00:00.000Z"), stoppedAt: new Date("2026-08-05T14:20:00.000Z") });
    const teammates = session({ userId: ids.teammate });
    reports.sessions.push(own, teammates);
    // The teammate's evidence overlaps the caller's session window; it still must not count.
    reports.segments.push({
      organizationId: ids.organization, userId: ids.teammate, kind: "active",
      startedAt: own.startedAt, endedAt: own.stoppedAt, receivedAt: new Date("2026-08-05T14:25:00.000Z"),
    });
    reports.agents.push({
      organizationId: ids.organization, userId: ids.teammate, source: "kimi_code", ruleId: null, linkedSessionId: teammates.id,
      startedAt: teammates.startedAt, endedAt: teammates.stoppedAt, lastEventAt: teammates.stoppedAt,
      receivedAt: new Date("2026-08-05T15:05:00.000Z"),
    });

    const response = await createTestApp(reports).request("http://api.test/me/stats", { headers: { authorization: bearerHeader } });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ totalDurationSeconds: 1_200, corroboratedSeconds: 0 });

    // The teammate, in the same organization, sees their own corroborated session instead.
    const teammateResponse = await createTestApp(reports).request("http://api.test/me/stats", { headers: { authorization: teammateBearerHeader } });
    await expect(teammateResponse.json()).resolves.toMatchObject({ totalDurationSeconds: 3_600, corroboratedSeconds: 3_600 });
  });

  it("breaks down active time per foreground process for the caller only", async () => {
    const reports = new MemoryReports();
    const receivedAt = new Date("2026-08-05T15:05:00.000Z");
    reports.segments.push(
      // Two segments in the same app merge into one total.
      { organizationId: ids.organization, userId: ids.user, kind: "active", processName: "Code.exe",
        startedAt: new Date("2026-08-05T14:00:00.000Z"), endedAt: new Date("2026-08-05T15:00:00.000Z"), receivedAt },
      { organizationId: ids.organization, userId: ids.user, kind: "active", processName: "Code.exe",
        startedAt: new Date("2026-08-05T16:00:00.000Z"), endedAt: new Date("2026-08-05T16:30:00.000Z"), receivedAt },
      { organizationId: ids.organization, userId: ids.user, kind: "active", processName: "chrome.exe",
        startedAt: new Date("2026-08-05T15:00:00.000Z"), endedAt: new Date("2026-08-05T15:30:00.000Z"), receivedAt },
      // Idle and unnamed segments never count.
      { organizationId: ids.organization, userId: ids.user, kind: "idle", processName: "Code.exe",
        startedAt: new Date("2026-08-05T17:00:00.000Z"), endedAt: new Date("2026-08-05T18:00:00.000Z"), receivedAt },
      { organizationId: ids.organization, userId: ids.user, kind: "active",
        startedAt: new Date("2026-08-05T18:00:00.000Z"), endedAt: new Date("2026-08-05T19:00:00.000Z"), receivedAt },
      // Stale evidence (received eight days after it ended) is stored but excluded.
      { organizationId: ids.organization, userId: ids.user, kind: "active", processName: "slack.exe",
        startedAt: new Date("2026-08-05T19:00:00.000Z"), endedAt: new Date("2026-08-05T20:00:00.000Z"),
        receivedAt: new Date("2026-08-13T20:00:00.000Z") },
      // A teammate's app time must never surface in the caller's breakdown.
      { organizationId: ids.organization, userId: ids.teammate, kind: "active", processName: "steam.exe",
        startedAt: new Date("2026-08-05T14:00:00.000Z"), endedAt: new Date("2026-08-05T16:00:00.000Z"), receivedAt },
    );

    const response = await createTestApp(reports).request("http://api.test/me/stats", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      apps: [
        { processName: "Code.exe", durationSeconds: 5_400 },
        { processName: "chrome.exe", durationSeconds: 1_800 },
      ],
    });

    // A range covering none of the segments returns no app rows.
    const empty = await createTestApp(reports).request("http://api.test/me/stats?from=2026-08-06&to=2026-08-06", { headers: { authorization: bearerHeader } });
    await expect(empty.json()).resolves.toMatchObject({ apps: [] });
  });

  it("breaks down browser-span time per url rule, clipped to the caller's fresh active segments", async () => {
    const reports = new MemoryReports();
    const githubRule = "01c7e513-b094-4d4c-ae55-21790ae019a4";
    const figmaRule = "02c7e513-b094-4d4c-ae55-21790ae019a4";
    const deletedRule = "03c7e513-b094-4d4c-ae55-21790ae019a4";
    reports.mappings.push(
      { id: githubRule, organizationId: ids.organization, userId: ids.user, kind: "url_rule", pattern: "github.com/acme/*", projectId: ids.project },
      { id: figmaRule, organizationId: ids.organization, userId: ids.user, kind: "url_rule", pattern: "*.figma.com/files/*", projectId: ids.otherProject },
    );
    const receivedAt = new Date("2026-08-05T15:05:00.000Z");
    reports.segments.push(
      // Active in the browser 14:00-15:00; the github span runs longer than
      // the machine was active, so only the overlap counts.
      { organizationId: ids.organization, userId: ids.user, kind: "active", processName: "chrome.exe",
        startedAt: new Date("2026-08-05T14:00:00.000Z"), endedAt: new Date("2026-08-05T15:00:00.000Z"), receivedAt },
      // Idle time under a focused tab attributes nothing.
      { organizationId: ids.organization, userId: ids.user, kind: "idle",
        startedAt: new Date("2026-08-05T15:00:00.000Z"), endedAt: new Date("2026-08-05T16:00:00.000Z"), receivedAt },
    );
    reports.agents.push(
      // 14:30-15:30 on the github rule: only 14:30-15:00 overlaps an active segment.
      { organizationId: ids.organization, userId: ids.user, source: "browser", ruleId: githubRule, linkedSessionId: null,
        startedAt: new Date("2026-08-05T14:30:00.000Z"), endedAt: new Date("2026-08-05T15:30:00.000Z"),
        lastEventAt: new Date("2026-08-05T15:30:00.000Z"), receivedAt },
      // A second tab on the same rule, 14:35-14:55, is concurrent with the
      // first span: wall-clock time must not double count, so this adds nothing.
      { organizationId: ids.organization, userId: ids.user, source: "browser", ruleId: githubRule, linkedSessionId: null,
        startedAt: new Date("2026-08-05T14:35:00.000Z"), endedAt: new Date("2026-08-05T14:55:00.000Z"),
        lastEventAt: new Date("2026-08-05T14:55:00.000Z"), receivedAt },
      // A disjoint span on the same rule merges into one total (14:10-14:20).
      { organizationId: ids.organization, userId: ids.user, source: "browser", ruleId: githubRule, linkedSessionId: null,
        startedAt: new Date("2026-08-05T14:10:00.000Z"), endedAt: new Date("2026-08-05T14:20:00.000Z"),
        lastEventAt: new Date("2026-08-05T14:20:00.000Z"), receivedAt },
      // A still-running span counts to its last heartbeat (14:05-14:15 → but
      // only 5 minutes overlap the figma span below; this one is 14:00-14:05).
      { organizationId: ids.organization, userId: ids.user, source: "browser", ruleId: figmaRule, linkedSessionId: null,
        startedAt: new Date("2026-08-05T14:00:00.000Z"), endedAt: null,
        lastEventAt: new Date("2026-08-05T14:05:00.000Z"), receivedAt },
      // A span whose rule was deleted drops out with the mapping row.
      { organizationId: ids.organization, userId: ids.user, source: "browser", ruleId: deletedRule, linkedSessionId: null,
        startedAt: new Date("2026-08-05T14:00:00.000Z"), endedAt: new Date("2026-08-05T15:00:00.000Z"),
        lastEventAt: new Date("2026-08-05T15:00:00.000Z"), receivedAt },
      // Non-browser agent sessions never feed the site breakdown.
      { organizationId: ids.organization, userId: ids.user, source: "kimi_code", ruleId: null, linkedSessionId: null,
        startedAt: new Date("2026-08-05T14:00:00.000Z"), endedAt: new Date("2026-08-05T15:00:00.000Z"),
        lastEventAt: new Date("2026-08-05T15:00:00.000Z"), receivedAt },
      // A teammate's span on the same rule must never surface here.
      { organizationId: ids.organization, userId: ids.teammate, source: "browser", ruleId: githubRule, linkedSessionId: null,
        startedAt: new Date("2026-08-05T14:00:00.000Z"), endedAt: new Date("2026-08-05T15:00:00.000Z"),
        lastEventAt: new Date("2026-08-05T15:00:00.000Z"), receivedAt },
    );

    const response = await createTestApp(reports).request("http://api.test/me/stats", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sites: [
        { mapping: { id: githubRule, pattern: "github.com/acme/*", projectId: ids.project }, durationSeconds: 2_400 },
        { mapping: { id: figmaRule, pattern: "*.figma.com/files/*", projectId: ids.otherProject }, durationSeconds: 300 },
      ],
    });

    // A range covering none of the spans returns no site rows.
    const outside = await createTestApp(reports).request("http://api.test/me/stats?from=2026-08-06&to=2026-08-06", { headers: { authorization: bearerHeader } });
    await expect(outside.json()).resolves.toMatchObject({ sites: [] });
  });

  it("unions overlapping active segments so a rule total never exceeds wall-clock time", async () => {
    const reports = new MemoryReports();
    const githubRule = "01c7e513-b094-4d4c-ae55-21790ae019a4";
    reports.mappings.push(
      { id: githubRule, organizationId: ids.organization, userId: ids.user, kind: "url_rule", pattern: "github.com/acme/*", projectId: ids.project },
    );
    const receivedAt = new Date("2026-08-05T15:05:00.000Z");
    // Two devices active simultaneously: the segments overlap 14:15-14:45.
    reports.segments.push(
      { organizationId: ids.organization, userId: ids.user, kind: "active", processName: "chrome.exe",
        startedAt: new Date("2026-08-05T14:00:00.000Z"), endedAt: new Date("2026-08-05T14:45:00.000Z"), receivedAt },
      { organizationId: ids.organization, userId: ids.user, kind: "active", processName: "chrome.exe",
        startedAt: new Date("2026-08-05T14:15:00.000Z"), endedAt: new Date("2026-08-05T15:00:00.000Z"), receivedAt },
    );
    // One span covers the whole hour; unioned segments corroborate 60 minutes,
    // not the 75 the per-segment pairwise sum would produce.
    reports.agents.push(
      { organizationId: ids.organization, userId: ids.user, source: "browser", ruleId: githubRule, linkedSessionId: null,
        startedAt: new Date("2026-08-05T14:00:00.000Z"), endedAt: new Date("2026-08-05T15:00:00.000Z"),
        lastEventAt: new Date("2026-08-05T15:00:00.000Z"), receivedAt },
    );

    const response = await createTestApp(reports).request("http://api.test/me/stats", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      sites: [
        { mapping: { id: githubRule, pattern: "github.com/acme/*", projectId: ids.project }, durationSeconds: 3_600 },
      ],
    });
  });

  it("returns no site row when the span and segment overlap each other but not the requested range", async () => {
    const reports = new MemoryReports();
    const githubRule = "01c7e513-b094-4d4c-ae55-21790ae019a4";
    reports.mappings.push(
      { id: githubRule, organizationId: ids.organization, userId: ids.user, kind: "url_rule", pattern: "github.com/acme/*", projectId: ids.project },
    );
    const receivedAt = new Date("2026-08-06T01:05:00.000Z");
    // The span crosses into the 6th and overlaps the segment pairwise, but the
    // three-way intersection with the requested day (the 6th) is empty.
    reports.segments.push(
      { organizationId: ids.organization, userId: ids.user, kind: "active", processName: "chrome.exe",
        startedAt: new Date("2026-08-05T23:30:00.000Z"), endedAt: new Date("2026-08-05T23:45:00.000Z"), receivedAt },
    );
    reports.agents.push(
      { organizationId: ids.organization, userId: ids.user, source: "browser", ruleId: githubRule, linkedSessionId: null,
        startedAt: new Date("2026-08-05T23:00:00.000Z"), endedAt: new Date("2026-08-07T01:00:00.000Z"),
        lastEventAt: new Date("2026-08-07T01:00:00.000Z"), receivedAt },
    );

    const response = await createTestApp(reports).request("http://api.test/me/stats?from=2026-08-06&to=2026-08-06", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sites: [] });
    // Without the range clamp the overlap counts normally.
    const unranged = await createTestApp(reports).request("http://api.test/me/stats", { headers: { authorization: bearerHeader } });
    await expect(unranged.json()).resolves.toMatchObject({
      sites: [{ mapping: { id: githubRule }, durationSeconds: 900 }],
    });
  });

  it("excludes subsecond site intersections after flooring their total", async () => {
    const reports = new MemoryReports();
    const githubRule = "01c7e513-b094-4d4c-ae55-21790ae019a4";
    reports.mappings.push(
      { id: githubRule, organizationId: ids.organization, userId: ids.user, kind: "url_rule", pattern: "github.com/acme/*", projectId: ids.project },
    );
    const receivedAt = new Date("2026-08-05T14:00:01.000Z");
    reports.segments.push({
      organizationId: ids.organization, userId: ids.user, kind: "active", processName: "chrome.exe",
      startedAt: new Date("2026-08-05T14:00:00.000Z"), endedAt: new Date("2026-08-05T14:00:00.500Z"), receivedAt,
    });
    reports.agents.push({
      organizationId: ids.organization, userId: ids.user, source: "browser", ruleId: githubRule, linkedSessionId: null,
      startedAt: new Date("2026-08-05T14:00:00.000Z"), endedAt: new Date("2026-08-05T14:00:00.500Z"),
      lastEventAt: new Date("2026-08-05T14:00:00.500Z"), receivedAt,
    });

    const response = await createTestApp(reports).request("http://api.test/me/stats", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ sites: [] });
  });
});
