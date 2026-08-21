import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { createTestAuth } from "../test-tokens.js";
import { parseEnv } from "../env.js";
import type {
  AgentIntervalRecord,
  AgentRecord,
  AgentRepository,
  AgentSessionRepository,
  PathMappingRepository,
  ProjectRepository,
  ReportRepository,
  ReportRowRecord,
  SessionRepository,
} from "../repositories.js";
import type { AuthenticatedSubject } from "../auth.js";
import { createReportRoutes } from "./reports.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  outsideProject: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
  outsideUser: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://siqshift:password@localhost:5432/siqshift",
  AUTH_BASE_URL: "https://auth.siqshift.test/neondb/auth",
  NODE_ENV: "test",
});
const user = { id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization, role: "member" as const };

let keys: Awaited<ReturnType<typeof createTestAuth>>["keys"];
let bearerHeader: string;

beforeAll(async () => {
  const auth = await createTestAuth(config, new Date("2026-08-06T14:00:00.000Z"));
  keys = auth.keys;
  bearerHeader = await auth.bearer(ids.user);
});

class Reports implements ReportRepository {
  public failExport: Error | null = null;
  public async findProjectForOrganization(_subject: AuthenticatedSubject, projectId: string) {
    return projectId === ids.project ? { id: ids.project, name: "Timer" } : null;
  }
  public async findUserForOrganization(_subject: AuthenticatedSubject, userId: string) {
    return userId === ids.user ? { id: ids.user, name: "Alex" } : null;
  }
  private readonly rows: ReportRowRecord[] = [{
      id: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
      user: { id: ids.user, name: "Alex" },
      project: { id: ids.project, name: "Timer" },
      repoRoot: null,
      description: "=formula",
      status: "stopped",
      startedAt: new Date("2026-08-06T14:00:00.000Z"),
      stoppedAt: new Date("2026-08-06T15:00:00.000Z"),
      idleSeconds: 0,
      durationSeconds: 3_600,
      attribution: "agent" as const,
    }];
  public async readPageForOrganization(_subject: AuthenticatedSubject, _query: Parameters<ReportRepository["readPageForOrganization"]>[1], _options: Parameters<ReportRepository["readPageForOrganization"]>[2]) {
    return { summary: { totalRows: 1, totalDurationSeconds: "3600" }, rows: this.rows };
  }
  public async readExportForOrganization(_subject: AuthenticatedSubject, _query: Parameters<ReportRepository["readExportForOrganization"]>[1], _maxRows: number) {
    if (this.failExport !== null) throw this.failExport;
    return { summary: { totalRows: 1, totalDurationSeconds: "3600" }, rows: this.rows };
  }
  public async readLeaderboardForOrganization(): Promise<never> {
    throw new Error("not used by these routes");
  }
  public async readMembersForOrganization(): Promise<never> {
    throw new Error("not used by these routes");
  }
  public async readProjectTotalsForMember(): Promise<never> {
    throw new Error("not used by these routes");
  }
  public async readSiteTotalsForMember(): Promise<never> {
    throw new Error("not used by these routes");
  }
  public agentIntervals: AgentIntervalRecord[] = [];
  public async readAgentIntervals() {
    return this.agentIntervals;
  }
}

/** Report routes reap stale agent sessions before report aggregation; nothing else is used. */
class AgentSessions implements Partial<AgentSessionRepository> {
  public reapCalls = 0;
  public async reapStale() {
    this.reapCalls += 1;
    return 0;
  }
}

// The agent-session route group refuses to mount without its sibling
// repositories, so the app needs these stubs even though reports never call them.
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

/** The pay-run report's roster; empty by default so these tests are unaffected unless they seed one. */
class Agents implements Partial<AgentRepository> {
  public constructor(public records: AgentRecord[] = []) {}
  public async listForOrganization() { return this.records; }
}

function app(reports = new Reports(), agentSessions = new AgentSessions(), agents = new Agents()) {
  return createApp({
    config,
    keys,
    accounts: { resolve: async () => user },
    clock: () => new Date("2026-08-06T14:00:00.000Z"),
    reportRepository: reports,
    agentSessionRepository: agentSessions as AgentSessionRepository,
    projectRepository: new Projects() as ProjectRepository,
    sessionRepository: new Timers() as SessionRepository,
    pathMappingRepository: new PathMappings() as PathMappingRepository,
    agentRepository: agents as AgentRepository,
  });
}

describe("report routes", () => {
  it("requires a signed bearer token", async () => {
    expect(createReportRoutes).toBeTypeOf("function");
    expect((await app().request("http://api.test/reports")).status).toBe(401);
  });

  it("returns stable validation and not-found responses", async () => {
        const headers = { authorization: bearerHeader };
    const invalid = await app().request("http://api.test/reports?from=2026-08-07&to=2026-08-06", { headers });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: { code: "validation_error", message: "The report date range must be between zero and 366 days." } });
    const outside = await app().request(`http://api.test/reports?projectId=${ids.outsideProject}`, { headers });
    expect(outside.status).toBe(404);
    await expect(outside.json()).resolves.toEqual({ error: { code: "not_found", message: "Project not found." } });
  });

  it("returns the shared JSON report and a safe CSV attachment", async () => {
        const headers = { authorization: bearerHeader };
    const json = await app().request("http://api.test/reports?from=2026-08-06", { headers });
    expect(json.status).toBe(200);
    await expect(json.json()).resolves.toMatchObject({ filters: { from: "2026-08-06", page: 1, pageSize: 50 }, totalDurationSeconds: 3_600, pagination: { totalRows: 1, totalPages: 1 }, rows: [{ status: "stopped", attribution: "agent", attributedSeconds: 3_600, unattributedSeconds: 0 }] });
    const csv = await app().request("http://api.test/reports/export.csv?from=2026-08-06", { headers });
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-type")).toContain("text/csv; charset=utf-8");
    expect(csv.headers.get("content-disposition")).toBe('attachment; filename="siqshift-report.csv"');
    expect(csv.headers.get("x-content-type-options")).toBe("nosniff");
    await expect(csv.text()).resolves.toContain("'=formula");
  });

  it("rejects invalid report pagination", async () => {
        const response = await app().request("http://api.test/reports?pageSize=201", { headers: { authorization: bearerHeader } });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid report filters." } });
  });

  it("closes stale agent sessions on the read path before reporting", async () => {
    const agentSessions = new AgentSessions();
    const response = await app(new Reports(), agentSessions).request("http://api.test/reports", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    expect(agentSessions.reapCalls).toBe(1);
  });

  it("returns a stable JSON error before a CSV stream begins when the snapshot read fails", async () => {
    const reports = new Reports();
    reports.failExport = new Error("database unavailable");
        const response = await app(reports).request("http://api.test/reports/export.csv", { headers: { authorization: bearerHeader } });
    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    await expect(response.text()).resolves.not.toContain("sessionId,userId");
  });

  it("returns the pay-run report with every roster agent and a headcount", async () => {
    const reports = new Reports();
    reports.agentIntervals = [{
      sessionId: "11c7e513-b094-4d4c-ae55-21790ae019a4",
      user: { id: ids.user, name: "Alex" },
      source: "claude_code",
      model: null,
      cwd: "C:\\dev\\siqshift",
      projectId: ids.project,
      agentId: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
      startedAt: new Date("2026-08-06T14:00:00.000Z"),
      endedAt: new Date("2026-08-06T15:00:00.000Z"),
    }];
    const agentRecord: AgentRecord = {
      id: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
      organizationId: ids.organization,
      name: "Claude Code @ Timer",
      source: "claude_code",
      status: "anonymous",
      owner: { id: ids.user, name: "Alex" },
      project: { id: ids.project, name: "Timer" },
      repoRoot: null,
      repoKey: null,
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const response = await app(reports, new AgentSessions(), new Agents([agentRecord]))
      .request("http://api.test/reports/agents", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      headcount: { total: 1, active: 1, retired: 0 },
      rows: [{
        agent: { id: agentRecord.id, name: "Claude Code @ Timer" },
        agentSeconds: 3_600,
        shiftCount: 1,
        heldRate: null,
        models: [],
        // The codebase reaches every member as a name, never as the path.
        repos: ["siqshift"],
      }],
    });
  });

  // The pay-run report is org-wide, so the disclosure is decided row by row.
  // A member reading a teammate's agent gets the codebase's name and no path
  // at all - absent rather than blanked, which is what lets the owner's and
  // the stranger's projections parse through the one strict schema.
  it("withholds another member's repo path from the pay-run report while keeping its name", async () => {
    const theirs: AgentRecord = {
      id: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
      organizationId: ids.organization,
      name: "Claude Code @ siqshift",
      source: "claude_code",
      status: "anonymous",
      owner: { id: ids.outsideProject, name: "Sam" },
      project: null,
      repoRoot: "C:/dev/siqshift",
      repoKey: "path:C:/dev/siqshift",
      createdAt: new Date("2026-08-01T00:00:00.000Z"),
    };
    const mine: AgentRecord = { ...theirs, id: ids.project, owner: { id: ids.user, name: "Alex" } };

    const response = await app(new Reports(), new AgentSessions(), new Agents([theirs, mine]))
      .request("http://api.test/reports/agents", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    const body = await response.json() as { rows: { agent: Record<string, unknown> }[] };
    const [theirRow, myRow] = body.rows;
    expect(theirRow!.agent).toMatchObject({ repoName: "siqshift" });
    expect(theirRow!.agent).not.toHaveProperty("repoRoot");
    // The caller's own agent still carries the path.
    expect(myRow!.agent).toMatchObject({ repoName: "siqshift", repoRoot: "C:/dev/siqshift" });
  });

  it("rejects a pay-run scope naming a project outside the workspace", async () => {
    const response = await app().request(`http://api.test/reports/agents?scope=${ids.outsideProject}`, { headers: { authorization: bearerHeader } });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: { code: "not_found", message: "Project not found." } });
  });

  it("takes a pay-run sort and echoes it in the filters, rejecting any other", async () => {
    const headers = { authorization: bearerHeader };
    const sorted = await app().request("http://api.test/reports/agents?sort=tokens", { headers });
    expect(sorted.status).toBe(200);
    await expect(sorted.json()).resolves.toMatchObject({ filters: { sort: "tokens" } });

    const bogus = await app().request("http://api.test/reports/agents?sort=commits", { headers });
    expect(bogus.status).toBe(400);
    await expect(bogus.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid agents report filters." } });
  });

  // The Agents tab calls this and nothing else, and the response leaves the
  // route through a strict schema: a field the service composes wrong is a 500
  // here, not a typecheck failure, so the shape is asserted over the wire.
  it("returns the shifts map grouped by codebase, through the strict response schema", async () => {
    const reports = new Reports();
    reports.agentIntervals = [{
      sessionId: "11c7e513-b094-4d4c-ae55-21790ae019a4",
      user: { id: ids.user, name: "Alex" },
      source: "claude_code",
      model: "claude-opus-5",
      cwd: "C:\\dev\\siqshift",
      projectId: ids.project,
      agentId: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
      startedAt: new Date("2026-08-06T14:00:00.000Z"),
      endedAt: new Date("2026-08-06T15:00:00.000Z"),
    }];

    const response = await app(reports).request("http://api.test/reports/agent-shifts", { headers: { authorization: bearerHeader } });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      totalAgentSeconds: 3_600,
      // The board the tab opens on rides the same strict schema, so a
      // misshapen person row is a 500 here rather than a silent field.
      people: [{ owner: { id: ids.user, name: "Alex" }, agentSeconds: 3_600, shiftCount: 1 }],
      groups: [{
        // The codebase reaches every member as a name, never as the path.
        repo: "siqshift",
        agentSeconds: 3_600,
        shiftCount: 1,
        // Nothing decided, so no rate at all rather than a fake zero.
        heldRate: null,
        shifts: [{
          id: "11c7e513-b094-4d4c-ae55-21790ae019a4",
          source: "claude_code",
          owner: { id: ids.user, name: "Alex" },
          model: "claude-opus-5",
          agentSeconds: 3_600,
          commitCount: 0,
        }],
      }],
    });
  });

  // The filter schema is strict, so a parameter the dashboard invents and this
  // build has never heard of has to be a stated 400, never a 500.
  it("rejects a query parameter the agent-shifts filter has never heard of", async () => {
    const response = await app().request("http://api.test/reports/agent-shifts?sort=hours", { headers: { authorization: bearerHeader } });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid agent shifts filters." } });
  });

  it("rejects an agent-shifts scope naming a project outside the workspace", async () => {
    const response = await app().request(`http://api.test/reports/agent-shifts?scope=${ids.outsideProject}`, { headers: { authorization: bearerHeader } });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: { code: "not_found", message: "Project not found." } });
  });

  it("rejects an agent-shifts person from outside the workspace, the same answer the scope gives", async () => {
    const response = await app().request(`http://api.test/reports/agent-shifts?userId=${ids.outsideUser}`, { headers: { authorization: bearerHeader } });
    expect(response.status).toBe(404);
    // A stable not_found, so a probe cannot tell "not in your workspace" from
    // "does not exist".
    await expect(response.json()).resolves.toEqual({ error: { code: "not_found", message: "User not found." } });
  });
});
