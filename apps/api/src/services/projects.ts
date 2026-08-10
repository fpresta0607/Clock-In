import type { AuthenticatedSubject } from "../auth.js";
import { AppError } from "../errors.js";
import type { ProjectRepository as Repository } from "../repositories.js";

export type ProjectRepository = Repository;

function compareOrdinal(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export async function listProjects(repository: ProjectRepository, subject: AuthenticatedSubject): Promise<{
  projects: Array<{ id: string; name: string; isArchived: boolean; isDefault: boolean }>;
  selectedProjectId: string | null;
}> {
  const [projects, preferred] = await Promise.all([
    repository.listForMember(subject),
    repository.preferredForMember === undefined ? Promise.resolve(null) : repository.preferredForMember(subject),
  ]);
  const active = projects
    .filter((project) => !project.archived)
    .sort((left, right) => compareOrdinal(left.name, right.name) || compareOrdinal(left.id, right.id));
  const selectedProjectId = preferred !== null && active.some((project) => project.id === preferred.id)
    ? preferred.id
    : active.find((project) => project.isDefault === true)?.id ?? active[0]?.id ?? null;
  return {
    projects: active.map((project) => ({
      id: project.id,
      name: project.name,
      isArchived: project.archived,
      isDefault: project.isDefault === true,
    })),
    selectedProjectId,
  };
}

// Project names carry no uniqueness constraint, so duplicates are allowed:
// the list response disambiguates them by id, matching the existing ordering.
export async function createProject(repository: ProjectRepository, subject: AuthenticatedSubject, name: string): Promise<{
  id: string;
  name: string;
  isArchived: boolean;
  isDefault: boolean;
}> {
  const project = await repository.createForMember(subject, name);
  return { id: project.id, name: project.name, isArchived: project.archived, isDefault: project.isDefault === true };
}

export async function updateProject(
  repository: ProjectRepository,
  subject: AuthenticatedSubject,
  projectId: string,
  input: { name?: string; isArchived?: boolean; replacementProjectId?: string },
): Promise<{ id: string; name: string; isArchived: boolean; isDefault: boolean }> {
  if (subject.role !== "admin") {
    throw new AppError("forbidden", "Only workspace admins can change projects.");
  }
  if (repository.updateForAdmin === undefined) {
    throw new AppError("internal_error", "Project administration is unavailable.");
  }
  const project = await repository.updateForAdmin(subject, projectId, {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.isArchived === undefined ? {} : { archived: input.isArchived }),
    ...(input.replacementProjectId === undefined ? {} : { replacementProjectId: input.replacementProjectId }),
  });
  if (project === null) throw new AppError("not_found", "Project not found.");
  return { id: project.id, name: project.name, isArchived: project.archived, isDefault: project.isDefault === true };
}
