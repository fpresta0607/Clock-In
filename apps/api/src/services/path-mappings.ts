import { projectPathMappingSchema } from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import {
  PathMappingRepositoryError,
  type PathMappingRecord,
  type PathMappingRepository,
  type ProjectRepository,
} from "../repositories.js";

export interface CreatePathMappingInput {
  kind: "path_prefix" | "url_rule";
  pathPrefix: string;
  repoUrl?: string | null;
  projectId: string;
}

export interface UpdatePathMappingInput {
  kind?: "path_prefix" | "url_rule";
  pathPrefix?: string;
  repoUrl?: string | null;
  projectId?: string;
}

export interface PathMappingServiceDependencies {
  pathMappings: PathMappingRepository;
  projects: ProjectRepository;
  clock?: () => Date;
}

export interface PathMappingService {
  list(subject: AuthenticatedSubject): Promise<PathMappingRecord[]>;
  create(subject: AuthenticatedSubject, input: CreatePathMappingInput): Promise<PathMappingRecord>;
  update(subject: AuthenticatedSubject, mappingId: string, input: UpdatePathMappingInput): Promise<PathMappingRecord>;
  remove(subject: AuthenticatedSubject, mappingId: string): Promise<void>;
}

function duplicatePrefix(): AppError {
  return new AppError("conflict", "A path mapping already exists for this prefix.");
}

export function createPathMappingService(dependencies: PathMappingServiceDependencies): PathMappingService {
  const clock = dependencies.clock ?? (() => new Date());

  async function requireProject(subject: AuthenticatedSubject, projectId: string): Promise<void> {
    const project = await dependencies.projects.findForMember(subject, projectId);
    if (project === null) throw new AppError("not_found", "Project not found.");
    if (project.archived) throw new AppError("project_archived", "Archived projects cannot be used for path mappings.");
  }

  return {
    list(subject: AuthenticatedSubject): Promise<PathMappingRecord[]> {
      return dependencies.pathMappings.listForSubject(subject);
    },

    async create(subject: AuthenticatedSubject, input: CreatePathMappingInput): Promise<PathMappingRecord> {
      await requireProject(subject, input.projectId);
      if (await dependencies.pathMappings.findByPathPrefix(subject, input.pathPrefix) !== null) {
        throw duplicatePrefix();
      }
      try {
        return await dependencies.pathMappings.create({
          organizationId: subject.organizationId,
          userId: subject.userId,
          kind: input.kind,
          pathPrefix: input.pathPrefix,
          repoUrl: input.repoUrl ?? null,
          projectId: input.projectId,
        });
      } catch (error) {
        if (error instanceof PathMappingRepositoryError) throw duplicatePrefix();
        throw error;
      }
    },

    async update(subject: AuthenticatedSubject, mappingId: string, input: UpdatePathMappingInput): Promise<PathMappingRecord> {
      const existing = await dependencies.pathMappings.findById(subject, mappingId);
      if (existing === null) throw new AppError("not_found", "Path mapping not found.");
      if (input.projectId !== undefined) await requireProject(subject, input.projectId);
      if (input.pathPrefix !== undefined && input.pathPrefix !== existing.pathPrefix
        && await dependencies.pathMappings.findByPathPrefix(subject, input.pathPrefix) !== null) {
        throw duplicatePrefix();
      }
      // The request schema validates fields in isolation, but kind and pattern
      // constrain each other — validate the merged record with the same rule
      // the create path uses, so a bare kind flip cannot pair a url_rule kind
      // with a filesystem pattern (silently breaking cwd attribution).
      const merged = projectPathMappingSchema.safeParse({
        id: existing.id,
        kind: input.kind ?? existing.kind,
        pathPrefix: input.pathPrefix ?? existing.pathPrefix,
        repoUrl: input.repoUrl === undefined ? existing.repoUrl : input.repoUrl,
        projectId: input.projectId ?? existing.projectId,
      });
      if (!merged.success) throw new AppError("validation_error", "The resulting path mapping is invalid.");
      try {
        const updated = await dependencies.pathMappings.update(subject, mappingId, { ...input, updatedAt: clock() });
        if (updated === null) throw new AppError("not_found", "Path mapping not found.");
        return updated;
      } catch (error) {
        if (error instanceof PathMappingRepositoryError) throw duplicatePrefix();
        throw error;
      }
    },

    async remove(subject: AuthenticatedSubject, mappingId: string): Promise<void> {
      if (!await dependencies.pathMappings.remove(subject, mappingId)) {
        throw new AppError("not_found", "Path mapping not found.");
      }
    },
  };
}
