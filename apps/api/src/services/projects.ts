import type { ProjectUpdateRequest } from "@clock-in/shared";

import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import type { ProjectRepository as Repository, ProjectUsageRecord } from "../repositories.js";

export type ProjectRepository = Repository;

function compareOrdinal(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

/**
 * The member's projects. Archived ones are excluded by default - pickers must
 * not offer them. `includeArchived` still returns them, which is the only way
 * an archive can be undone through the API, but the dashboard's management
 * surface no longer asks for it: it offers only create and guarded delete now.
 */
export async function listProjects(
  repository: ProjectRepository,
  subject: AuthenticatedSubject,
  includeArchived = false,
): Promise<{
  projects: Array<{ id: string; name: string; createdAt: string; isArchived: boolean; isDefault: boolean }>;
}> {
  const projects = await repository.listForMember(subject);
  return {
    projects: projects
      .filter((project) => includeArchived || !project.archived)
      .sort((left, right) => compareOrdinal(left.name, right.name) || compareOrdinal(left.id, right.id))
      .map((project) => ({
        id: project.id,
        name: project.name,
        createdAt: project.createdAt.toISOString(),
        isArchived: project.archived,
        isDefault: project.isDefault,
      })),
  };
}

/** Case-insensitive: "client work" and "Client Work" are one project to a person. */
async function rejectDuplicateName(repository: ProjectRepository, subject: AuthenticatedSubject, name: string, exceptId?: string): Promise<void> {
  // Archived rows count: unarchiving must never produce two projects with
  // one name, which is exactly what this rule exists to prevent.
  const projects = await repository.listForMember(subject);
  const wanted = name.trim().toLowerCase();
  if (projects.some((project) => project.id !== exceptId && project.name.trim().toLowerCase() === wanted)) {
    throw new AppError("conflict", "A project with that name already exists.");
  }
}

export async function createProject(repository: ProjectRepository, subject: AuthenticatedSubject, name: string): Promise<{
  id: string;
  name: string;
  createdAt: string;
  isArchived: boolean;
  isDefault: boolean;
}> {
  await rejectDuplicateName(repository, subject, name);
  const project = await repository.createForMember(subject, name);
  return {
    id: project.id,
    name: project.name,
    createdAt: project.createdAt.toISOString(),
    isArchived: project.archived,
    isDefault: project.isDefault,
  };
}

export async function updateProject(
  repository: ProjectRepository,
  subject: AuthenticatedSubject,
  projectId: string,
  patch: ProjectUpdateRequest,
): Promise<{ id: string; name: string; createdAt: string; isArchived: boolean; isDefault: boolean }> {
  if (repository.updateForMember === undefined) throw new AppError("not_found", "Project not found.");
  if (patch.name !== undefined) await rejectDuplicateName(repository, subject, patch.name, projectId);
  if (patch.isArchived === true) {
    const project = await repository.findForMember(subject, projectId);
    if (project === null) throw new AppError("not_found", "Project not found.");
    if (project.isDefault) {
      throw new AppError("conflict", "The default project cannot be archived; unattributed time lands there.");
    }
  }
  const updated = await repository.updateForMember(subject, projectId, {
    ...(patch.name === undefined ? {} : { name: patch.name }),
    ...(patch.isArchived === undefined ? {} : { archived: patch.isArchived }),
  });
  if (updated === null) throw new AppError("not_found", "Project not found.");
  return {
    id: updated.id,
    name: updated.name,
    createdAt: updated.createdAt.toISOString(),
    isArchived: updated.archived,
    isDefault: updated.isDefault,
  };
}

export async function projectUsage(
  repository: ProjectRepository,
  subject: AuthenticatedSubject,
  projectId: string,
): Promise<ProjectUsageRecord> {
  if (repository.usageForOrganization === undefined) throw new AppError("not_found", "Project not found.");
  if (await repository.findForMember(subject, projectId) === null) throw new AppError("not_found", "Project not found.");
  return repository.usageForOrganization(subject, projectId);
}

/**
 * Deletes a project, either moving its data to `reassignTo` first or taking
 * the data with it. Two guards, because this reaches beyond the caller:
 * deletion is workspace-wide, so it destroys or moves *other* members'
 * sessions, and only an admin may do that. And the last active project
 * refuses to die - automatic recording needs somewhere for time to land.
 */
export async function deleteProject(
  repository: ProjectRepository,
  subject: AuthenticatedSubject,
  projectId: string,
  reassignTo: string | null,
): Promise<void> {
  if (repository.deleteForOrganization === undefined) throw new AppError("not_found", "Project not found.");
  if (subject.role !== "admin") {
    throw new AppError("forbidden", "Only a workspace administrator can delete a project.");
  }
  const project = await repository.findForMember(subject, projectId);
  if (project === null) throw new AppError("not_found", "Project not found.");
  if (project.isDefault) {
    throw new AppError("conflict", "The default project cannot be deleted; unattributed time lands there.");
  }
  const remaining = (await repository.listForMember(subject))
    .filter((candidate) => candidate.id !== projectId && !candidate.archived);
  if (remaining.length === 0) {
    throw new AppError("conflict", "The last project cannot be deleted; recording needs somewhere to land.");
  }
  if (reassignTo !== null) {
    if (reassignTo === projectId) throw new AppError("validation_error", "A project cannot absorb itself.");
    if (await repository.findForMember(subject, reassignTo) === null) throw new AppError("not_found", "The replacement project was not found.");
  }
  await repository.deleteForOrganization(subject, projectId, reassignTo);
}
