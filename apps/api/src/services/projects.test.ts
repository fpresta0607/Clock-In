import { describe, expect, it } from "vitest";

import { createProject, listProjects, type ProjectRepository } from "./projects.js";

const subject = {
  organizationId: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  userId: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  role: "member" as const,
};

describe("project service", () => {
  it("lists only active projects accessible to the authenticated member in deterministic order", async () => {
    const repository: ProjectRepository = {
      listForMember: async () => [
        { id: "c1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "alpha", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") },
        { id: "b1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Alpha", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") },
        { id: "e1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Álpha", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") },
        { id: "d1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Zebra", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") },
        { id: "a1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Alpha", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") },
      ],
      findForMember: async () => null,
      createForMember: async () => { throw new Error("not implemented"); },
    };

    await expect(listProjects(repository, subject)).resolves.toEqual({
      projects: [
        { id: "a1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Alpha", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false },
        { id: "b1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Alpha", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false },
        { id: "d1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Zebra", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false },
        { id: "c1e7c513-b094-4d4c-ae55-21790ae019a4", name: "alpha", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false },
        { id: "e1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Álpha", createdAt: "2026-08-10T12:00:00.000Z", isArchived: false },
      ],
    });
  });

  it("creates a project for the member and returns the list-item shape", async () => {
    const created = {
      id: "f1e7c513-b094-4d4c-ae55-21790ae019a4",
      organizationId: subject.organizationId,
      name: "Field work",
      archived: false,
      createdAt: new Date("2026-08-10T12:00:00.000Z"),
    };
    const calls: Array<{ organizationId: string; userId: string; name: string }> = [];
    const repository: ProjectRepository = {
      listForMember: async () => [],
      findForMember: async () => null,
      createForMember: async (callSubject, name) => {
        calls.push({ organizationId: callSubject.organizationId, userId: callSubject.userId, name });
        return created;
      },
    };

    await expect(createProject(repository, subject, "Field work")).resolves.toEqual({
      id: created.id,
      name: "Field work",
      createdAt: "2026-08-10T12:00:00.000Z",
      isArchived: false,
    });
    expect(calls).toEqual([{ organizationId: subject.organizationId, userId: subject.userId, name: "Field work" }]);
  });
});
