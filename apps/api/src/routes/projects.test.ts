import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { parseEnv } from "../env.js";
import type { ProjectRecord, ProjectRepository } from "../repositories.js";
import { createTestAuth } from "../test-tokens.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://clock_in:password@localhost:5432/clock_in",
  AUTH_BASE_URL: "https://auth.clock-in.test/neondb/auth",
  NODE_ENV: "test",
});
const users = {
  [ids.user]: { id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization },
};

let keys: Awaited<ReturnType<typeof createTestAuth>>["keys"];
let bearerHeader: string;

beforeAll(async () => {
  const auth = await createTestAuth(config, new Date("2026-08-06T14:00:00.000Z"));
  keys = auth.keys;
  bearerHeader = await auth.bearer(ids.user);
});

class MemoryProjects implements ProjectRepository {
  private readonly records: ProjectRecord[] = [
    { id: ids.project, organizationId: ids.organization, name: "General", archived: false },
  ];
  public async listForMember() { return this.records.filter((record) => !record.archived); }
  public async findForMember(subject: { organizationId: string }, projectId: string) {
    return this.records.find((record) => record.id === projectId && record.organizationId === subject.organizationId) ?? null;
  }
  public async createForMember(subject: { organizationId: string; userId: string }, name: string) {
    const record: ProjectRecord = { id: crypto.randomUUID(), organizationId: subject.organizationId, name, archived: false };
    this.records.push(record);
    return record;
  }
}

function createTestApp() {
  return createApp({
    config,
    keys,
    accounts: { resolve: async (identity) => users[identity.authUserId as keyof typeof users] },
    clock: () => new Date("2026-08-06T14:00:00.000Z"),
    projectRepository: new MemoryProjects(),
  });
}

describe("project routes", () => {
  it("requires a bearer token", async () => {
    const app = createTestApp();
    expect((await app.request("http://api.test/projects")).status).toBe(401);
    expect((await app.request("http://api.test/projects", { method: "POST" })).status).toBe(401);
  });

  it("creates a project, trims its name, and lists it for the creator", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const created = await app.request("http://api.test/projects", {
      method: "POST", headers, body: JSON.stringify({ name: "  Field work  " }),
    });
    expect(created.status).toBe(201);
    const project = await created.json();
    expect(project).toEqual({ id: expect.any(String), name: "Field work", isArchived: false });

    const listed = await app.request("http://api.test/projects", { headers });
    await expect(listed.json()).resolves.toEqual({
      projects: [
        { id: expect.any(String), name: "Field work", isArchived: false },
        { id: ids.project, name: "General", isArchived: false },
      ],
    });
  });

  it("allows two projects to share a name", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const first = await app.request("http://api.test/projects", {
      method: "POST", headers, body: JSON.stringify({ name: "General" }),
    });
    expect(first.status).toBe(201);
    const second = await app.request("http://api.test/projects", {
      method: "POST", headers, body: JSON.stringify({ name: "General" }),
    });
    expect(second.status).toBe(201);
    expect((await first.json()).id).not.toBe((await second.json()).id);
  });

  it("validates the create body with a stable error code", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const malformed = await app.request("http://api.test/projects", { method: "POST", headers, body: "{bad" });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid request body." } });

    const blank = await app.request("http://api.test/projects", { method: "POST", headers, body: JSON.stringify({ name: "   " }) });
    expect(blank.status).toBe(400);

    const tooLong = await app.request("http://api.test/projects", { method: "POST", headers, body: JSON.stringify({ name: "x".repeat(81) }) });
    expect(tooLong.status).toBe(400);
  });
});
