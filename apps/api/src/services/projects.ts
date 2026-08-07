import type { AuthenticatedSubject } from "../auth.js";
import type { ProjectRepository as Repository } from "../repositories.js";

export type ProjectRepository = Repository;

export async function listProjects(repository: ProjectRepository, subject: AuthenticatedSubject): Promise<{
  projects: Array<{ id: string; name: string; isArchived: boolean }>;
}> {
  const projects = await repository.listForMember(subject);
  return {
    projects: projects
      .filter((project) => !project.archived)
      .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))
      .map((project) => ({ id: project.id, name: project.name, isArchived: project.archived })),
  };
}
