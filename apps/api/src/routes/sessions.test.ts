import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { createTestAuth } from "../test-tokens.js";
import type { ProjectRepository, SessionRecord, SessionRepository } from "../repositories.js";
import { createProjectRoutes } from "./projects.js";
import { createSessionRoutes } from "./sessions.js";
import { parseEnv } from "../env.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  client: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
  AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth",
  NODE_ENV: "test",
});
const user = { id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization };

let keys: Awaited<ReturnType<typeof createTestAuth>>["keys"];
let bearerHeader: string;

beforeAll(async () => {
  const auth = await createTestAuth(config, new Date("2026-08-06T14:00:00.000Z"));
  keys = auth.keys;
  bearerHeader = await auth.bearer(ids.user);
});

class Projects implements ProjectRepository {
  public async listForMember() {
    return [{ id: ids.project, organizationId: ids.organization, name: "Alpha", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") }];
  }
  public async findForMember(_subject: unknown, projectId: string) {
    return projectId === ids.project ? { id: ids.project, organizationId: ids.organization, name: "Alpha", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") } : null;
  }
  public async createForMember(): Promise<never> {
    throw new Error("not implemented");
  }
}

class Sessions implements SessionRepository {
  public readonly observed: Parameters<SessionRepository["insertObservedBatch"]>[0] = [];
  private record: SessionRecord | null = null;
  public async findByClientId(_subject: unknown, clientId: string) { return this.record?.clientId === clientId ? this.record : null; }
  public async findRunning() { return this.record?.status === "running" ? this.record : null; }
  public async findById(_subject: unknown, id: string) { return this.record?.id === id ? this.record : null; }
  public async createRunning(input: Parameters<SessionRepository["createRunning"]>[0]) {
    this.record = { id: "d1c7e513-b094-4d4c-ae55-21790ae019a4", ...input, status: "running", stoppedAt: null, idleSeconds: 0, durationSeconds: null, attribution: "manual" };
    return this.record;
  }
  public async stopRunning(_subject: unknown, id: string, input: Parameters<SessionRepository["stopRunning"]>[2]) {
    if (this.record === null || this.record.id !== id || this.record.status !== "running") return null;
    this.record = { ...this.record, ...input };
    return this.record;
  }
  public async insertObservedBatch(sessions: Parameters<SessionRepository["insertObservedBatch"]>[0]) {
    // Real storage ignores client ids it already holds; the fake does the same.
    for (const session of sessions) {
      if (!this.observed.some((stored) => stored.clientId === session.clientId)) this.observed.push(session);
    }
  }
}

function createTestApp(sessions = new Sessions()) {
  const projects = new Projects();
  const app = createApp({
    config,
    keys,
    accounts: { resolve: async () => user },
    clock: () => new Date("2026-08-06T14:00:00.000Z"),
    projectRepository: projects,
    sessionRepository: sessions,
  });
  return app;
}

describe("timer routes", () => {
  it("requires a bearer token for project and session routes", async () => {
    expect(createProjectRoutes).toBeTypeOf("function");
    expect(createSessionRoutes).toBeTypeOf("function");
    const app = createTestApp();
    expect((await app.request("http://api.test/projects")).status).toBe(401);
    expect((await app.request("http://api.test/sessions/current")).status).toBe(401);
  });

  it("stores observed sessions in a batch and rejects only the bad rows", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const sessions = new Sessions();
    const app = createTestApp(sessions);
    const observed = {
      clientId: ids.client,
      projectId: ids.project,
      attribution: "agent",
      startedAt: "2026-08-06T13:00:00.000Z",
      stoppedAt: "2026-08-06T13:30:00.000Z",
      idleSeconds: 60,
    };

    const accepted = await app.request("http://api.test/sessions/observed", {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessions: [
          observed,
          // Unknown project: rejected on its own, without failing the batch.
          { ...observed, clientId: "b1c7e513-b094-4d4c-ae55-21790ae019a4", projectId: "f1c7e513-b094-4d4c-ae55-21790ae019a4" },
          // Ends before it starts.
          { ...observed, clientId: "e2c7e513-b094-4d4c-ae55-21790ae019a4", stoppedAt: "2026-08-06T12:00:00.000Z" },
        ],
      }),
    });

    expect(accepted.status).toBe(200);
    await expect(accepted.json()).resolves.toEqual({
      accepted: 1,
      rejected: [
        { clientId: "b1c7e513-b094-4d4c-ae55-21790ae019a4", reason: "Project not found." },
        { clientId: "e2c7e513-b094-4d4c-ae55-21790ae019a4", reason: "The session must end after it started." },
      ],
    });
    expect(sessions.observed).toEqual([expect.objectContaining({
      clientId: ids.client,
      projectId: ids.project,
      attribution: "agent",
      idleSeconds: 60,
      // 30 minutes of window less a minute of trimmed idle.
      durationSeconds: 1_740,
      status: "stopped",
    })]);

    // A replayed batch stores nothing new.
    const replay = await app.request("http://api.test/sessions/observed", {
      method: "POST", headers, body: JSON.stringify({ sessions: [observed] }),
    });
    expect(replay.status).toBe(200);
    expect(sessions.observed).toHaveLength(1);

    const manual = await app.request("http://api.test/sessions/observed", {
      method: "POST", headers, body: JSON.stringify({ sessions: [{ ...observed, attribution: "manual" }] }),
    });
    expect(manual.status).toBe(400);
  });

  it("validates requests and returns shared session payloads", async () => {
        const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const invalid = await app.request("http://api.test/sessions", { method: "POST", headers, body: "{bad" });
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid request body." } });

    const unknownProject = await app.request("http://api.test/sessions", {
      method: "POST", headers, body: JSON.stringify({ clientId: "b1c7e513-b094-4d4c-ae55-21790ae019a4", projectId: "f1c7e513-b094-4d4c-ae55-21790ae019a4" }),
    });
    expect(unknownProject.status).toBe(404);
    await expect(unknownProject.json()).resolves.toEqual({ error: { code: "not_found", message: "Project not found." } });

    const started = await app.request("http://api.test/sessions", { method: "POST", headers, body: JSON.stringify({ clientId: ids.client, projectId: ids.project, description: "Route test", startedAt: "2026-08-06T13:00:00.000Z" }) });
    expect(started.status).toBe(200);
    await expect(started.json()).resolves.toMatchObject({ session: { status: "running", description: "Route test", startedAt: "2026-08-06T13:00:00.000Z" } });

    const conflict = await app.request("http://api.test/sessions", {
      method: "POST", headers, body: JSON.stringify({ clientId: "b1c7e513-b094-4d4c-ae55-21790ae019a4", projectId: ids.project }),
    });
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toEqual({ error: { code: "session_already_running", message: "A time session is already running." } });

    const projects = await app.request("http://api.test/projects", { headers });
    expect(projects.status).toBe(200);
    await expect(projects.json()).resolves.toMatchObject({ projects: [{ id: ids.project, name: "Alpha", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false }] });

    const current = await app.request("http://api.test/sessions/current", { headers });
    expect(current.status).toBe(200);
    await expect(current.json()).resolves.toMatchObject({ session: { status: "running" } });

    const invalidStop = await app.request("http://api.test/sessions/d1c7e513-b094-4d4c-ae55-21790ae019a4/stop", {
      method: "POST", headers, body: JSON.stringify({ stoppedAt: "2026-08-06T13:10:00.000Z", idleSeconds: -1 }),
    });
    expect(invalidStop.status).toBe(400);
    await expect(invalidStop.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid request body." } });

    const stopped = await app.request("http://api.test/sessions/d1c7e513-b094-4d4c-ae55-21790ae019a4/stop", {
      method: "POST", headers, body: JSON.stringify({ stoppedAt: "2026-08-06T13:10:00.000Z", idleSeconds: 60 }),
    });
    expect(stopped.status).toBe(200);
    await expect(stopped.json()).resolves.toMatchObject({ session: { status: "stopped", durationSeconds: 540, idleSeconds: 60 } });

    const idempotentRetry = await app.request("http://api.test/sessions", {
      method: "POST", headers, body: JSON.stringify({ clientId: ids.client, projectId: ids.project, description: "Route test", startedAt: "2026-08-06T13:00:00.000Z" }),
    });
    expect(idempotentRetry.status).toBe(200);
    await expect(idempotentRetry.json()).resolves.toMatchObject({ session: { status: "stopped", durationSeconds: 540 } });

    const malformedId = await app.request("http://api.test/sessions/not-a-uuid/stop", {
      method: "POST", headers, body: JSON.stringify({ stoppedAt: "2026-08-06T13:10:00.000Z", idleSeconds: 0 }),
    });
    expect(malformedId.status).toBe(400);
    await expect(malformedId.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid session id." } });

    const farFutureStart = await app.request("http://api.test/sessions", {
      method: "POST", headers, body: JSON.stringify({ clientId: "b1c7e513-b094-4d4c-ae55-21790ae019a4", projectId: ids.project, startedAt: "2026-08-06T14:00:30.001Z" }),
    });
    expect(farFutureStart.status).toBe(400);
    await expect(farFutureStart.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid session start time." } });
  });
});
