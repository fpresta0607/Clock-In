import { describe, expect, it } from "vitest";

import { createProject, listProjects, updateProject, type ProjectRepository } from "./projects.js";

const subject = {
  organizationId: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  userId: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
};

describe("project service", () => {
  it("lists only active projects accessible to the authenticated member in deterministic order", async () => {
    const repository: ProjectRepository = {
      listForMember: async () => [
        { id: "c1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "alpha", archived: false },
        { id: "b1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Alpha", archived: false },
        { id: "e1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Álpha", archived: false },
        { id: "d1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Zebra", archived: false },
        { id: "a1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Alpha", archived: false, isDefault: true },
      ],
      findForMember: async () => null,
      createForMember: async () => { throw new Error("not implemented"); },
    };

    await expect(listProjects(repository, subject)).resolves.toEqual({
      projects: [
        { id: "a1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Alpha", isArchived: false, isDefault: true },
        { id: "b1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Alpha", isArchived: false, isDefault: false },
        { id: "d1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Zebra", isArchived: false, isDefault: false },
        { id: "c1e7c513-b094-4d4c-ae55-21790ae019a4", name: "alpha", isArchived: false, isDefault: false },
        { id: "e1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Álpha", isArchived: false, isDefault: false },
      ],
      selectedProjectId: "a1e7c513-b094-4d4c-ae55-21790ae019a4",
    });
  });

  it("creates a project for the member and returns the list-item shape", async () => {
    const created = {
      id: "f1e7c513-b094-4d4c-ae55-21790ae019a4",
      organizationId: subject.organizationId,
      name: "Field work",
      archived: false,
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
      isArchived: false,
      isDefault: false,
    });
    expect(calls).toEqual([{ organizationId: subject.organizationId, userId: subject.userId, name: "Field work" }]);
  });

  it("keeps default replacement admin-only and passes the replacement atomically", async () => {
    const replacement = "f1e7c513-b094-4d4c-ae55-21790ae019a4";
    const calls: Array<{ projectId: string; replacementProjectId?: string }> = [];
    const repository: ProjectRepository = {
      listForMember: async () => [],
      findForMember: async () => null,
      createForMember: async () => { throw new Error("not implemented"); },
      updateForAdmin: async (_current, projectId, input) => {
        calls.push({ projectId, replacementProjectId: input.replacementProjectId });
        return { id: projectId, organizationId: subject.organizationId, name: "General Work", archived: true, isDefault: false };
      },
    };

    await expect(updateProject(repository, subject, "a1e7c513-b094-4d4c-ae55-21790ae019a4", {
      isArchived: true,
      replacementProjectId: replacement,
    })).rejects.toMatchObject({ code: "forbidden" });
    expect(calls).toEqual([]);

    await expect(updateProject(repository, { ...subject, role: "admin" }, "a1e7c513-b094-4d4c-ae55-21790ae019a4", {
      isArchived: true,
      replacementProjectId: replacement,
    })).resolves.toEqual({
      id: "a1e7c513-b094-4d4c-ae55-21790ae019a4",
      name: "General Work",
      isArchived: true,
      isDefault: false,
    });
    expect(calls).toEqual([{ projectId: "a1e7c513-b094-4d4c-ae55-21790ae019a4", replacementProjectId: replacement }]);
  });
});
