import type { AuthenticatedSubject } from "../auth.js";
import type { ProjectRepository as Repository } from "../repositories.js";

export type ProjectRepository = Repository;

function compareOrdinal(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

export async function listProjects(repository: ProjectRepository, subject: AuthenticatedSubject): Promise<{
  projects: Array<{ id: string; name: string; createdAt: string; isArchived: boolean }>;
}> {
  const projects = await repository.listForMember(subject);
  return {
    projects: projects
      .filter((project) => !project.archived)
      .sort((left, right) => compareOrdinal(left.name, right.name) || compareOrdinal(left.id, right.id))
      .map((project) => ({ id: project.id, name: project.name, createdAt: project.createdAt.toISOString(), isArchived: project.archived })),
  };
}

// Project names carry no uniqueness constraint, so duplicates are allowed:
// the list response disambiguates them by id, matching the existing ordering.
export async function createProject(repository: ProjectRepository, subject: AuthenticatedSubject, name: string): Promise<{
  id: string;
  name: string;
  createdAt: string;
  isArchived: boolean;
}> {
  const project = await repository.createForMember(subject, name);
  return { id: project.id, name: project.name, createdAt: project.createdAt.toISOString(), isArchived: project.archived };
}
