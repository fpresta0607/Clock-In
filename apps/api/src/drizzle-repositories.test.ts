import { describe, expect, it } from "vitest";

import type { DatabaseConnection } from "@clock-in/database";

import { DrizzlePathMappingRepository, DrizzleReportRepository, DrizzleSessionRepository } from "./drizzle-repositories.js";

const input = {
  organizationId: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  userId: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  clientId: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
  projectId: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  description: null,
  startedAt: new Date("2026-08-06T13:00:00.000Z"),
};

describe("Drizzle session repository", () => {
  it("maps PostgreSQL's one-running constraint field to a stable repository conflict", async () => {
    const db = {
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        insert: () => ({ values: () => ({ returning: async () => { throw { code: "23505", constraint_name: "time_sessions_one_running_user_unique" }; } }) }),
      }),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzleSessionRepository(db);

    await expect(repository.createRunning(input)).rejects.toMatchObject({ conflict: "session_already_running" });
  });
});

describe("Drizzle report repository", () => {
  it("uses the repeatable-read transaction handle for both summary and row reads", async () => {
    let transactionSelects = 0;
    const transaction = {
      select: () => {
        transactionSelects += 1;
        if (transactionSelects % 2 === 1) {
          return { from: () => ({ where: async () => [{ totalRows: 0, totalDurationSeconds: 0 }] }) };
        }
        const rows = {
          innerJoin: () => rows,
          where: () => rows,
          orderBy: () => rows,
          limit: () => rows,
          offset: async () => [],
        };
        return { from: () => rows };
      },
    };
    const db = {
      select: () => { throw new Error("root query bypassed report snapshot"); },
      transaction: async (callback: (handle: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzleReportRepository(db);
    const subject = { organizationId: input.organizationId, userId: input.userId };

    await expect(repository.readPageForOrganization(subject, {}, { limit: 50, offset: 0 })).resolves.toMatchObject({ summary: { totalRows: 0 }, rows: [] });
    await expect(repository.readExportForOrganization(subject, {}, 10_000)).resolves.toMatchObject({ summary: { totalRows: 0 }, rows: [] });
    expect(transactionSelects).toBe(4);
  });

  it("maps caller-scoped per-project totals, preserving postgres sum strings", async () => {
    const rows = {
      innerJoin: () => rows,
      where: () => rows,
      groupBy: () => rows,
      orderBy: async () => [{
        projectId: input.projectId,
        projectName: "Timer",
        durationSeconds: "7200",
        corroboratedSeconds: "5400",
        sessionCount: 3,
      }],
    };
    const db = {
      select: () => ({ from: () => rows }),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzleReportRepository(db);
    const subject = { organizationId: input.organizationId, userId: input.userId };

    await expect(repository.readProjectTotalsForMember(subject, {})).resolves.toEqual([{
      project: { id: input.projectId, name: "Timer" },
      durationSeconds: "7200",
      corroboratedSeconds: "5400",
      sessionCount: 3,
    }]);
  });
});

describe("Drizzle path-mapping repository", () => {
  it("maps the duplicate-prefix unique constraint to a stable repository conflict", async () => {
    const db = {
      insert: () => ({ values: () => ({ returning: async () => { throw { code: "23505", constraint_name: "project_path_mappings_organization_user_prefix_unique" }; } }) }),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzlePathMappingRepository(db);

    await expect(repository.create({
      organizationId: input.organizationId,
      userId: input.userId,
      pathPrefix: "C:/dev/clock-in",
      repoUrl: null,
      projectId: input.projectId,
    })).rejects.toMatchObject({ conflict: "path_prefix" });
  });
});
