import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import type { AuthenticatedSubject } from "../auth.js";
import { parseEnv } from "../env.js";
import type {
  AgentSessionRepository,
  AppTotalRecord,
  PathMappingRepository,
  ProjectRepository,
  ProjectTotalRecord,
  ReportQuery,
  ReportRepository,
  SessionRepository,
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
  linkedSessionId: string | null;
  startedAt: Date;
  endedAt: Date | null;
  lastEventAt: Date;
  receivedAt: Date;
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

  private corroborated(session: StoredSession): number {
    let total = 0;
    for (const segment of this.segments) {
      if (segment.organizationId !== session.organizationId || segment.userId !== session.userId || segment.kind !== "active") continue;
      if (segment.receivedAt.getTime() > segment.endedAt.getTime() + freshnessWindowMs) continue;
      total += overlapSeconds(segment.startedAt, segment.endedAt, session.startedAt, session.stoppedAt);
    }
    for (const agent of this.agents) {
      if (agent.organizationId !== session.organizationId || agent.linkedSessionId !== session.id) continue;
      const occurredAt = agent.endedAt ?? agent.lastEventAt;
      if (agent.receivedAt.getTime() > occurredAt.getTime() + freshnessWindowMs) continue;
      total += overlapSeconds(agent.startedAt, occurredAt, session.startedAt, session.stoppedAt);
    }
    return Math.min(session.durationSeconds, total);
  }

  private filtered(subject: AuthenticatedSubject, query: ReportQuery): StoredSession[] {
    return this.sessions.filter((session) => session.organizationId === subject.organizationId
      && (query.from === undefined || session.startedAt >= query.from)
      && (query.toExclusive === undefined || session.startedAt < query.toExclusive)
      && (query.userId === undefined || session.userId === query.userId)
      && (query.projectId === undefined || session.project.id === query.projectId));
  }

  public async readProjectTotalsForMember(subject: AuthenticatedSubject, query: ReportQuery): Promise<ProjectTotalRecord[]> {
    const byProject = new Map<string, ProjectTotalRecord>();
    for (const session of this.filtered(subject, query)) {
      const existing = byProject.get(session.project.id)
        ?? { project: session.project, durationSeconds: 0, corroboratedSeconds: 0, sessionCount: 0 };
      existing.durationSeconds = (existing.durationSeconds as number) + session.durationSeconds;
      existing.corroboratedSeconds = (existing.corroboratedSeconds as number) + this.corroborated(session);
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
      .map(([processName, durationSeconds]) => ({ processName, durationSeconds }))
      .sort((a, b) => b.durationSeconds - a.durationSeconds || a.processName.localeCompare(b.processName));
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
  public readonly reapCalls: { subject: AuthenticatedSubject; cutoff: Date }[] = [];
  public async reapStale(subject: AuthenticatedSubject, cutoff: Date) {
    this.reapCalls.push({ subject, cutoff });
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
      organizationId: ids.organization, linkedSessionId: agentBacked.id,
      startedAt: new Date("2026-08-06T11:15:00.000Z"), endedAt: new Date("2026-08-06T11:45:00.000Z"),
      lastEventAt: new Date("2026-08-06T11:45:00.000Z"), receivedAt: new Date("2026-08-06T11:50:00.000Z"),
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
      // None of the segments in this test carry a process name.
      apps: [],
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
      organizationId: ids.organization, linkedSessionId: agentLate.id,
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
    await expect(empty.json()).resolves.toEqual({ filters: { from: "2026-08-01", to: "2026-08-02" }, totalDurationSeconds: 0, corroboratedSeconds: 0, projects: [], apps: [] });
  });

  it("closes stale agent sessions on the read path before computing stats", async () => {
    const agentSessions = new ReapRecorder();
    const response = await createTestApp(new MemoryReports(), agentSessions).request("http://api.test/me/stats", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    expect(agentSessions.reapCalls).toEqual([{
      subject: { organizationId: ids.organization, userId: ids.user },
      cutoff: new Date(clockNow.getTime() - 6 * 60 * 60 * 1_000),
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
      organizationId: ids.organization, linkedSessionId: teammates.id,
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
});
