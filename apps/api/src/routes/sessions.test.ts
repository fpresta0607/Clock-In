import { describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { signAccessToken } from "../auth.js";
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
  JWT_SECRET: "this-is-a-long-test-secret-with-enough-entropy-123",
  NODE_ENV: "test",
});
const user = { id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization };

class Projects implements ProjectRepository {
  public async listForMember() {
    return [{ id: ids.project, organizationId: ids.organization, name: "Alpha", archived: false }];
  }
  public async findForMember(_subject: unknown, projectId: string) {
    return projectId === ids.project ? { id: ids.project, organizationId: ids.organization, name: "Alpha", archived: false } : null;
  }
}

class Sessions implements SessionRepository {
  private record: SessionRecord | null = null;
  public async findByClientId(_subject: unknown, clientId: string) { return this.record?.clientId === clientId ? this.record : null; }
  public async findRunning() { return this.record?.status === "running" ? this.record : null; }
  public async findById(_subject: unknown, id: string) { return this.record?.id === id ? this.record : null; }
  public async createRunning(input: Parameters<SessionRepository["createRunning"]>[0]) {
    this.record = { id: "d1c7e513-b094-4d4c-ae55-21790ae019a4", ...input, status: "running", stoppedAt: null, idleSeconds: 0, durationSeconds: null };
    return this.record;
  }
  public async stopRunning(_subject: unknown, id: string, input: Parameters<SessionRepository["stopRunning"]>[2]) {
    if (this.record === null || this.record.id !== id || this.record.status !== "running") return null;
    this.record = { ...this.record, ...input };
    return this.record;
  }
}

function createTestApp() {
  const projects = new Projects();
  const sessions = new Sessions();
  const app = createApp({
    config,
    credentials: { findByEmail: async () => null },
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

  it("validates requests and returns shared session payloads", async () => {
    const token = await signAccessToken(user, config, new Date("2026-08-06T14:00:00.000Z"));
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
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
    await expect(projects.json()).resolves.toEqual({ projects: [{ id: ids.project, name: "Alpha", isArchived: false }] });

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
  });
});
