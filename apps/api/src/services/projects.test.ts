import { describe, expect, it } from "vitest";

import { listProjects, type ProjectRepository } from "./projects.js";

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
        { id: "a1e7c513-b094-4d4c-ae55-21790ae019a4", organizationId: subject.organizationId, name: "Alpha", archived: false },
      ],
      findForMember: async () => null,
    };

    await expect(listProjects(repository, subject)).resolves.toEqual({
      projects: [
        { id: "a1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Alpha", isArchived: false },
        { id: "b1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Alpha", isArchived: false },
        { id: "d1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Zebra", isArchived: false },
        { id: "c1e7c513-b094-4d4c-ae55-21790ae019a4", name: "alpha", isArchived: false },
        { id: "e1e7c513-b094-4d4c-ae55-21790ae019a4", name: "Álpha", isArchived: false },
      ],
    });
  });
});
