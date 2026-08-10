import { describe, expect, it } from "vitest";

import type { AuthenticatedSubject } from "../auth.js";
import {
  PathMappingRepositoryError,
  type CreatePathMapping,
  type PathMappingRecord,
  type PathMappingRepository,
  type ProjectRecord,
  type ProjectRepository,
  type UpdatePathMapping,
} from "../repositories.js";
import { createPathMappingService } from "./path-mappings.js";

const ids = {
  organization: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  user: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  otherUser: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  project: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  archivedProject: "b1c7e513-b094-4d4c-ae55-21790ae019a4",
  mapping: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
};
const subject: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.user };
const now = new Date("2026-08-06T14:00:00.000Z");

class MemoryProjects implements ProjectRepository {
  public constructor(private readonly records: ProjectRecord[]) {}
  public async listForMember(): Promise<ProjectRecord[]> { return this.records.filter((record) => !record.archived); }
  public async findForMember(_subject: AuthenticatedSubject, projectId: string): Promise<ProjectRecord | null> {
    return this.records.find((record) => record.id === projectId) ?? null;
  }
  public async createForMember(): Promise<ProjectRecord> { throw new Error("not implemented"); }
}

class MemoryPathMappings implements PathMappingRepository {
  public readonly records: PathMappingRecord[];
  public nextCreateError: PathMappingRepositoryError | null = null;

  public constructor(records: PathMappingRecord[] = []) {
    this.records = records;
  }

  private scoped(current: AuthenticatedSubject): PathMappingRecord[] {
    return this.records.filter((record) => record.organizationId === current.organizationId && record.userId === current.userId);
  }

  public async listForSubject(current: AuthenticatedSubject): Promise<PathMappingRecord[]> {
    return this.scoped(current);
  }

  public async findById(current: AuthenticatedSubject, mappingId: string): Promise<PathMappingRecord | null> {
    return this.scoped(current).find((record) => record.id === mappingId) ?? null;
  }

  public async findByPathPrefix(current: AuthenticatedSubject, pathPrefix: string): Promise<PathMappingRecord | null> {
    return this.scoped(current).find((record) => record.pathPrefix === pathPrefix) ?? null;
  }

  public async create(input: CreatePathMapping): Promise<PathMappingRecord> {
    if (this.nextCreateError !== null) throw this.nextCreateError;
    const record: PathMappingRecord = { id: crypto.randomUUID(), ...input };
    this.records.push(record);
    return record;
  }

  public async update(current: AuthenticatedSubject, mappingId: string, input: UpdatePathMapping): Promise<PathMappingRecord | null> {
    const existing = await this.findById(current, mappingId);
    if (existing === null) return null;
    const updated: PathMappingRecord = {
      ...existing,
      kind: input.kind ?? existing.kind,
      pathPrefix: input.pathPrefix ?? existing.pathPrefix,
      repoUrl: input.repoUrl === undefined ? existing.repoUrl : input.repoUrl,
      projectId: input.projectId ?? existing.projectId,
    };
    this.records[this.records.indexOf(existing)] = updated;
    return updated;
  }

  public async remove(current: AuthenticatedSubject, mappingId: string): Promise<boolean> {
    const existing = await this.findById(current, mappingId);
    if (existing === null) return false;
    this.records.splice(this.records.indexOf(existing), 1);
    return true;
  }
}

const projects: ProjectRecord[] = [
  { id: ids.project, organizationId: ids.organization, name: "Alpha", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") },
  { id: ids.archivedProject, organizationId: ids.organization, name: "Old", archived: true, createdAt: new Date("2026-08-10T12:00:00.000Z") },
];

function existingMapping(overrides: Partial<PathMappingRecord> = {}): PathMappingRecord {
  return {
    id: ids.mapping,
    organizationId: ids.organization,
    userId: ids.user,
    kind: "path_prefix",
    pathPrefix: "C:/dev/clock-in",
    repoUrl: null,
    projectId: ids.project,
    ...overrides,
  };
}

function createService(records: PathMappingRecord[] = []) {
  const pathMappings = new MemoryPathMappings(records);
  return {
    pathMappings,
    service: createPathMappingService({ pathMappings, projects: new MemoryProjects(projects), clock: () => now }),
  };
}

describe("path-mapping service", () => {
  it("creates a mapping for an active membership project", async () => {
    const { pathMappings, service } = createService();

    const created = await service.create(subject, { pathPrefix: "C:/dev/clock-in", projectId: ids.project });

    expect(created).toMatchObject({ kind: "path_prefix", pathPrefix: "C:/dev/clock-in", repoUrl: null, projectId: ids.project, userId: ids.user });
    expect(pathMappings.records).toHaveLength(1);
  });

  it("creates a url-rule mapping with the same membership checks", async () => {
    const { service } = createService();

    const created = await service.create(subject, { kind: "url_rule", pathPrefix: "github.com/acme/*", projectId: ids.project });

    expect(created).toMatchObject({ kind: "url_rule", pathPrefix: "github.com/acme/*", projectId: ids.project });
  });

  it("rejects a duplicate pattern across both kinds, exactly like duplicate prefixes", async () => {
    const { service } = createService([
      existingMapping({ kind: "url_rule", pathPrefix: "github.com/acme/*" }),
    ]);

    await expect(service.create(subject, { kind: "url_rule", pathPrefix: "github.com/acme/*", projectId: ids.project }))
      .rejects.toMatchObject({ code: "conflict", status: 409 });
    // The uniqueness spans both kinds: a path prefix equal to a rule's pattern conflicts too.
    await expect(service.create(subject, { pathPrefix: "github.com/acme/*", projectId: ids.project }))
      .rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  it("requires the project to be an accessible, active membership project", async () => {
    const { service } = createService();

    await expect(service.create(subject, { pathPrefix: "C:/x", projectId: "f1c7e513-b094-4d4c-ae55-21790ae019a4" }))
      .rejects.toMatchObject({ code: "not_found", status: 404 });
    await expect(service.create(subject, { pathPrefix: "C:/x", projectId: ids.archivedProject }))
      .rejects.toMatchObject({ code: "project_archived", status: 409 });
  });

  it("rejects a duplicate prefix, including a unique-constraint race", async () => {
    const { pathMappings, service } = createService([existingMapping()]);

    await expect(service.create(subject, { pathPrefix: "C:/dev/clock-in", projectId: ids.project }))
      .rejects.toMatchObject({ code: "conflict", status: 409 });

    pathMappings.nextCreateError = new PathMappingRepositoryError("path_prefix");
    await expect(service.create(subject, { pathPrefix: "C:/dev/other", projectId: ids.project }))
      .rejects.toMatchObject({ code: "conflict", status: 409 });
  });

  it("lists only the caller's mappings", async () => {
    const other: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.otherUser };
    const { service } = createService([
      existingMapping(),
      existingMapping({ id: "e1c7e513-b094-4d4c-ae55-21790ae019a4", userId: ids.otherUser, pathPrefix: "C:/dev/theirs" }),
    ]);

    await expect(service.list(subject)).resolves.toEqual([existingMapping()]);
    await expect(service.list(other)).resolves.toHaveLength(1);
  });

  it("updates prefix, repo url, and project with the same validations as create", async () => {
    const { pathMappings, service } = createService([existingMapping(), existingMapping({ id: "e2c7e513-b094-4d4c-ae55-21790ae019a4", pathPrefix: "C:/dev/taken" })]);

    const updated = await service.update(subject, ids.mapping, { repoUrl: "https://github.com/acme/clock-in" });
    expect(updated).toMatchObject({ repoUrl: "https://github.com/acme/clock-in", pathPrefix: "C:/dev/clock-in" });

    await expect(service.update(subject, ids.mapping, { pathPrefix: "C:/dev/taken" }))
      .rejects.toMatchObject({ code: "conflict" });
    await expect(service.update(subject, ids.mapping, { projectId: ids.archivedProject }))
      .rejects.toMatchObject({ code: "project_archived" });
    await expect(service.update(subject, ids.mapping, { projectId: "f1c7e513-b094-4d4c-ae55-21790ae019a4" }))
      .rejects.toMatchObject({ code: "not_found" });
    await expect(service.update(subject, "f1c7e513-b094-4d4c-ae55-21790ae019a4", { repoUrl: null }))
      .rejects.toMatchObject({ code: "not_found" });
    expect(pathMappings.records[0]).toMatchObject({ pathPrefix: "C:/dev/clock-in" });
  });

  it("validates the merged record when flipping kinds, exactly like the create path", async () => {
    const { pathMappings, service } = createService([existingMapping()]);

    // Flipping a filesystem prefix to a url rule without fixing the pattern is rejected.
    await expect(service.update(subject, ids.mapping, { kind: "url_rule" }))
      .rejects.toMatchObject({ code: "validation_error" });
    expect(pathMappings.records[0]).toMatchObject({ kind: "path_prefix", pathPrefix: "C:/dev/clock-in" });

    // Flipping kind and pattern together works, and the record round-trips.
    const flipped = await service.update(subject, ids.mapping, { kind: "url_rule", pathPrefix: "github.com/acme/*" });
    expect(flipped).toMatchObject({ kind: "url_rule", pathPrefix: "github.com/acme/*" });

    // An invalid pattern for the existing url-rule kind is rejected the same way.
    await expect(service.update(subject, ids.mapping, { pathPrefix: "C:/dev/clock-in" }))
      .rejects.toMatchObject({ code: "validation_error" });
  });

  it("deletes only the caller's own mappings", async () => {
    const other: AuthenticatedSubject = { organizationId: ids.organization, userId: ids.otherUser };
    const { pathMappings, service } = createService([existingMapping()]);

    await expect(service.remove(other, ids.mapping)).rejects.toMatchObject({ code: "not_found" });
    await service.remove(subject, ids.mapping);
    expect(pathMappings.records).toHaveLength(0);
    await expect(service.remove(subject, ids.mapping)).rejects.toMatchObject({ code: "not_found" });
  });
});
