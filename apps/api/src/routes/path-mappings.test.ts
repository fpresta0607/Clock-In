import { beforeAll, describe, expect, it } from "vitest";

import { createApp } from "../app.js";
import { parseEnv } from "../env.js";
import type {
  CreatePathMapping,
  PathMappingRecord,
  PathMappingRepository,
  ProjectRecord,
  ProjectRepository,
  UpdatePathMapping,
} from "../repositories.js";
import { createTestAuth } from "../test-tokens.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  otherOrganization: "1e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  archivedProject: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const config = parseEnv({
  DATABASE_URL: "postgres://siqshift:password@localhost:5432/siqshift",
  AUTH_BASE_URL: "https://auth.siqshift.test/neondb/auth",
  NODE_ENV: "test",
});
const users = {
  [ids.user]: { id: ids.user, email: "alex@example.com", name: "Alex", organizationId: ids.organization, role: "member" as const },
  [ids.otherUser]: { id: ids.otherUser, email: "blair@example.com", name: "Blair", organizationId: ids.otherOrganization, role: "member" as const },
};

let keys: Awaited<ReturnType<typeof createTestAuth>>["keys"];
let bearerHeader: string;
let otherBearerHeader: string;

beforeAll(async () => {
  const auth = await createTestAuth(config, new Date("2026-08-06T14:00:00.000Z"));
  keys = auth.keys;
  bearerHeader = await auth.bearer(ids.user);
  otherBearerHeader = await auth.bearer(ids.otherUser);
});

class MemoryProjects implements ProjectRepository {
  private readonly records: ProjectRecord[] = [
    { id: ids.project, organizationId: ids.organization, name: "Alpha", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") },
    { id: ids.archivedProject, organizationId: ids.organization, name: "Old", archived: true, createdAt: new Date("2026-08-10T12:00:00.000Z") },
  ];
  public async listForMember() { return this.records.filter((record) => !record.archived); }
  public async findForMember(subject: { organizationId: string }, projectId: string) {
    return this.records.find((record) => record.id === projectId && record.organizationId === subject.organizationId) ?? null;
  }
  public async createForMember(): Promise<never> { throw new Error("not implemented"); }
}

class MemoryPathMappings implements PathMappingRepository {
  public readonly records: PathMappingRecord[] = [];

  private scoped(subject: { organizationId: string; userId: string }) {
    return this.records.filter((record) => record.organizationId === subject.organizationId && record.userId === subject.userId);
  }

  public async listForSubject(subject: { organizationId: string; userId: string }) { return this.scoped(subject); }
  public async findById(subject: { organizationId: string; userId: string }, mappingId: string) {
    return this.scoped(subject).find((record) => record.id === mappingId) ?? null;
  }
  public async findByPathPrefix(subject: { organizationId: string; userId: string }, pathPrefix: string) {
    return this.scoped(subject).find((record) => record.pathPrefix === pathPrefix) ?? null;
  }
  public async create(input: CreatePathMapping) {
    const record: PathMappingRecord = { id: crypto.randomUUID(), ...input };
    this.records.push(record);
    return record;
  }
  public async update(subject: { organizationId: string; userId: string }, mappingId: string, input: UpdatePathMapping) {
    const existing = await this.findById(subject, mappingId);
    if (existing === null) return null;
    const updated: PathMappingRecord = {
      ...existing,
      pathPrefix: input.pathPrefix ?? existing.pathPrefix,
      repoUrl: input.repoUrl === undefined ? existing.repoUrl : input.repoUrl,
      projectId: input.projectId ?? existing.projectId,
    };
    this.records[this.records.indexOf(existing)] = updated;
    return updated;
  }
  public async remove(subject: { organizationId: string; userId: string }, mappingId: string) {
    const existing = await this.findById(subject, mappingId);
    if (existing === null) return false;
    this.records.splice(this.records.indexOf(existing), 1);
    return true;
  }
}

function createTestApp(pathMappings = new MemoryPathMappings()) {
  return createApp({
    config,
    keys,
    accounts: { resolve: async (identity) => users[identity.authUserId as keyof typeof users] },
    clock: () => new Date("2026-08-06T14:00:00.000Z"),
    projectRepository: new MemoryProjects(),
    pathMappingRepository: pathMappings,
  });
}

describe("path-mapping routes", () => {
  it("requires a bearer token", async () => {
    const app = createTestApp();
    expect((await app.request("http://api.test/path-mappings")).status).toBe(401);
    expect((await app.request("http://api.test/path-mappings", { method: "POST" })).status).toBe(401);
    expect((await app.request("http://api.test/path-mappings/x", { method: "DELETE" })).status).toBe(401);
  });

  it("creates, lists, updates, and deletes the caller's mappings", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const empty = await app.request("http://api.test/path-mappings", { headers });
    expect(empty.status).toBe(200);
    await expect(empty.json()).resolves.toEqual({ mappings: [] });

    const created = await app.request("http://api.test/path-mappings", {
      method: "POST", headers, body: JSON.stringify({ pathPrefix: "C:/dev/siqshift", projectId: ids.project }),
    });
    expect(created.status).toBe(200);
    const mapping = await created.json();
    expect(mapping).toEqual({ id: expect.any(String), kind: "path_prefix", pathPrefix: "C:/dev/siqshift", repoUrl: null, projectId: ids.project });

    const listed = await app.request("http://api.test/path-mappings", { headers });
    await expect(listed.json()).resolves.toEqual({ mappings: [mapping] });

    const updated = await app.request(`http://api.test/path-mappings/${mapping.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ repoUrl: "https://github.com/acme/siqshift" }),
    });
    expect(updated.status).toBe(200);
    await expect(updated.json()).resolves.toEqual({ ...mapping, repoUrl: "https://github.com/acme/siqshift" });

    const removed = await app.request(`http://api.test/path-mappings/${mapping.id}`, { method: "DELETE", headers });
    expect(removed.status).toBe(204);
    const gone = await app.request(`http://api.test/path-mappings/${mapping.id}`, { method: "DELETE", headers });
    expect(gone.status).toBe(404);
    await expect(gone.json()).resolves.toEqual({ error: { code: "not_found", message: "Path mapping not found." } });
  });

  it("validates bodies and ids with stable error codes", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const malformed = await app.request("http://api.test/path-mappings", { method: "POST", headers, body: "{bad" });
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid request body." } });

    const missingProject = await app.request("http://api.test/path-mappings", { method: "POST", headers, body: JSON.stringify({ pathPrefix: "C:/x" }) });
    expect(missingProject.status).toBe(400);

    const badId = await app.request("http://api.test/path-mappings/not-a-uuid", {
      method: "PATCH", headers, body: JSON.stringify({ pathPrefix: "C:/x" }),
    });
    expect(badId.status).toBe(400);
    await expect(badId.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid path mapping id." } });

    const unknownId = await app.request("http://api.test/path-mappings/f1c7e513-b094-4d4c-ae55-21790ae019a4", {
      method: "PATCH", headers, body: JSON.stringify({ pathPrefix: "C:/x" }),
    });
    expect(unknownId.status).toBe(404);
  });

  it("rejects unknown and archived projects and duplicate prefixes", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const unknownProject = await app.request("http://api.test/path-mappings", {
      method: "POST", headers, body: JSON.stringify({ pathPrefix: "C:/x", projectId: "f1c7e513-b094-4d4c-ae55-21790ae019a4" }),
    });
    expect(unknownProject.status).toBe(404);
    await expect(unknownProject.json()).resolves.toEqual({ error: { code: "not_found", message: "Project not found." } });

    const archived = await app.request("http://api.test/path-mappings", {
      method: "POST", headers, body: JSON.stringify({ pathPrefix: "C:/x", projectId: ids.archivedProject }),
    });
    expect(archived.status).toBe(409);
    await expect(archived.json()).resolves.toEqual({ error: { code: "project_archived", message: "Archived projects cannot be used for path mappings." } });

    await app.request("http://api.test/path-mappings", {
      method: "POST", headers, body: JSON.stringify({ pathPrefix: "C:/dev/siqshift", projectId: ids.project }),
    });
    const duplicate = await app.request("http://api.test/path-mappings", {
      method: "POST", headers, body: JSON.stringify({ pathPrefix: "C:/dev/siqshift", projectId: ids.project }),
    });
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toEqual({ error: { code: "conflict", message: "A path mapping already exists for this prefix." } });
  });

  it("stores url_rule patterns under their kind for browser attribution", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const created = await app.request("http://api.test/path-mappings", {
      method: "POST", headers, body: JSON.stringify({ kind: "url_rule", pathPrefix: "github.com/acme/*", projectId: ids.project }),
    });
    expect(created.status).toBe(200);
    await expect(created.json()).resolves.toEqual({
      id: expect.any(String), kind: "url_rule", pathPrefix: "github.com/acme/*", repoUrl: null, projectId: ids.project,
    });

    // A duplicate pattern conflicts, exactly like duplicate prefixes.
    const duplicate = await app.request("http://api.test/path-mappings", {
      method: "POST", headers, body: JSON.stringify({ pathPrefix: "github.com/acme/*", projectId: ids.project }),
    });
    expect(duplicate.status).toBe(409);

    // Schemes, uppercase hosts, and interior globs fail the shared contract.
    for (const pattern of ["https://github.com/acme/*", "GitHub.com/acme/*", "github.com/*/issues"]) {
      const invalid = await app.request("http://api.test/path-mappings", {
        method: "POST", headers, body: JSON.stringify({ kind: "url_rule", pathPrefix: pattern, projectId: ids.project }),
      });
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toEqual({ error: { code: "validation_error", message: "Invalid request body." } });
    }
  });

  it("updates a path mapping's pattern while preserving its kind when none is sent", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const created = await app.request("http://api.test/path-mappings", {
      method: "POST", headers, body: JSON.stringify({ pathPrefix: "C:/dev/siqshift", projectId: ids.project }),
    });
    const mapping = await created.json();

    const switched = await app.request(`http://api.test/path-mappings/${mapping.id}`, {
      method: "PATCH", headers, body: JSON.stringify({ pathPrefix: "github.com/acme/*" }),
    });
    expect(switched.status).toBe(200);
    await expect(switched.json()).resolves.toEqual({ ...mapping, pathPrefix: "github.com/acme/*" });
  });

  it("keeps another organization's mappings invisible", async () => {
    const headers = { authorization: bearerHeader, "content-type": "application/json" };
    const otherHeaders = { authorization: otherBearerHeader, "content-type": "application/json" };
    const app = createTestApp();

    const created = await app.request("http://api.test/path-mappings", {
      method: "POST", headers, body: JSON.stringify({ pathPrefix: "C:/dev/siqshift", projectId: ids.project }),
    });
    const mapping = await created.json();

    const otherList = await app.request("http://api.test/path-mappings", { headers: otherHeaders });
    await expect(otherList.json()).resolves.toEqual({ mappings: [] });

    const otherDelete = await app.request(`http://api.test/path-mappings/${mapping.id}`, { method: "DELETE", headers: otherHeaders });
    expect(otherDelete.status).toBe(404);

    const otherDuplicate = await app.request("http://api.test/path-mappings", {
      method: "POST", headers: otherHeaders, body: JSON.stringify({ pathPrefix: "C:/dev/siqshift", projectId: ids.project }),
    });
    // The other org cannot see the project, so it gets not_found — never a conflict leak.
    expect(otherDuplicate.status).toBe(404);
  });
});
