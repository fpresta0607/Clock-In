import { describe, expect, it, vi } from "vitest";

import { projectMemberships, projects, type DatabaseConnection } from "@clock-in/database";

import {
  DrizzleAccountStore,
  DrizzlePathMappingRepository,
  DrizzleProjectRepository,
  DrizzleReportRepository,
  DrizzleSessionRepository,
} from "./drizzle-repositories.js";

const input = {
  organizationId: "0e59dfd6-3d1f-4795-9420-3ab65f0df843",
  userId: "e1c7e513-b094-4d4c-ae55-21790ae019a4",
  clientId: "c1c7e513-b094-4d4c-ae55-21790ae019a4",
  projectId: "a1c7e513-b094-4d4c-ae55-21790ae019a4",
  deviceId: "f1c7e513-b094-4d4c-ae55-21790ae019a4",
  description: null,
  startedAt: new Date("2026-08-06T13:00:00.000Z"),
};

describe("Drizzle session repository", () => {
  it("maps PostgreSQL's one-running constraint field to a stable repository conflict", async () => {
    const db = {
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        execute: async () => [{ organization_id: input.organizationId, role: "member" }],
        insert: () => ({ values: () => ({ returning: async () => { throw { code: "23505", constraint_name: "time_sessions_one_running_user_unique" }; } }) }),
      }),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzleSessionRepository(db);

    await expect(repository.createRunning(input)).rejects.toMatchObject({ conflict: "session_already_running" });
  });
});

describe("Drizzle account store", () => {
  it("refuses to move the final active administrator away from members", async () => {
    const targetOrganizationId = "a1c7e513-b094-4d4c-ae55-21790ae019a4";
    const currentOrganizationId = "b1c7e513-b094-4d4c-ae55-21790ae019a4";
    const deleted: unknown[] = [];
    let selectStep = 0;
    const limited = (rows: unknown[]) => ({
      from: () => ({ where: () => ({ limit: async () => rows }) }),
    });
    const transaction = {
      execute: async () => selectStep === 0
        ? [{ organization_id: currentOrganizationId, role: "admin" }]
        : [{ id: input.userId }],
      select: () => {
        selectStep += 1;
        if (selectStep === 1) return limited([{ id: targetOrganizationId }]);
        if (selectStep === 2) {
          return limited([{
            id: input.userId,
            email: "legacy@example.com",
            name: "Legacy Admin",
            organizationId: currentOrganizationId,
            role: "admin",
          }]);
        }
        if (selectStep >= 3 && selectStep <= 6) return { from: () => ({ where: async () => [{ total: 0 }] }) };
        if (selectStep === 7) return limited([{ id: "remaining-member" }]);
        if (selectStep === 8) return limited([]);
        throw new Error(`unexpected select ${selectStep}`);
      },
      delete: (table: unknown) => {
        deleted.push(table);
        return { where: async () => undefined };
      },
    };
    const db = {
      transaction: async (callback: (handle: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as unknown as DatabaseConnection["db"];
    const accounts = new DrizzleAccountStore(db);

    await expect(accounts.joinOrganization({ organizationId: currentOrganizationId, userId: input.userId }, "ACDEF-GHJKM"))
      .rejects.toMatchObject({
        code: "conflict",
        message: "The final administrator cannot leave a workspace while it still has members.",
      });
    expect(deleted).toEqual([]);
  });

  it("rejects a workspace move before activity evidence can violate its tenant key", async () => {
    const targetOrganizationId = "a1c7e513-b094-4d4c-ae55-21790ae019a4";
    const currentOrganizationId = "b1c7e513-b094-4d4c-ae55-21790ae019a4";
    let selectStep = 0;
    const limited = (rows: unknown[]) => ({
      from: () => ({ where: () => ({ limit: async () => rows }) }),
    });
    const transaction = {
      execute: async () => selectStep === 0
        ? [{ organization_id: currentOrganizationId, role: "member" }]
        : [{ id: input.userId }],
      select: () => {
        selectStep += 1;
        if (selectStep === 1) return limited([{ id: targetOrganizationId }]);
        if (selectStep === 2) return limited([{
          id: input.userId,
          email: "member@example.com",
          name: "Member",
          organizationId: currentOrganizationId,
          role: "member",
        }]);
        if (selectStep === 3 || selectStep === 5 || selectStep === 6) {
          return { from: () => ({ where: async () => [{ total: 0 }] }) };
        }
        if (selectStep === 4) return { from: () => ({ where: async () => [{ total: 1 }] }) };
        throw new Error(`unexpected select ${selectStep}`);
      },
      delete: () => ({ where: async () => undefined }),
      update: () => ({ set: () => ({ where: () => ({ returning: async () => [] }) }) }),
    };
    const db = {
      transaction: async (callback: (handle: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as unknown as DatabaseConnection["db"];

    await expect(new DrizzleAccountStore(db).joinOrganization(
      { organizationId: currentOrganizationId, userId: input.userId },
      "ACDEF-GHJKM",
    )).rejects.toMatchObject({
      code: "conflict",
      message: "This account has recorded workspace evidence, so it cannot be moved.",
    });
  });
});

describe("Drizzle report repository", () => {
  it("uses the repeatable-read transaction handle for both summary and row reads", async () => {
    let transactionSelects = 0;
    const transaction = {
      execute: async () => [{ organization_id: input.organizationId, role: "member" }],
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
        attributedSeconds: "5400",
        sessionCount: 3,
      }],
    };
    const transaction = {
      execute: async () => [{ organization_id: input.organizationId, role: "member" }],
      select: () => ({ from: () => rows }),
    };
    const db = {
      transaction: async (callback: (handle: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzleReportRepository(db);
    const subject = { organizationId: input.organizationId, userId: input.userId };

    await expect(repository.readProjectTotalsForMember(subject, {})).resolves.toEqual([{
      project: { id: input.projectId, name: "Timer" },
      durationSeconds: "7200",
      attributedSeconds: "5400",
      sessionCount: 3,
    }]);
  });

  it("maps caller-scoped per-app totals, preserving postgres sum strings", async () => {
    const rows = {
      where: () => rows,
      groupBy: () => rows,
      having: () => rows,
      orderBy: async () => [
        { processName: "Code.exe", durationSeconds: "4800" },
        { processName: "chrome.exe", durationSeconds: "1200" },
      ],
    };
    const transaction = {
      execute: async () => [{ organization_id: input.organizationId, role: "member" }],
      select: () => ({ from: () => rows }),
    };
    const db = {
      transaction: async (callback: (handle: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzleReportRepository(db);
    const subject = { organizationId: input.organizationId, userId: input.userId };

    await expect(repository.readAppTotalsForMember(subject, {})).resolves.toEqual([
      { processName: "Code.exe", durationSeconds: "4800" },
      { processName: "chrome.exe", durationSeconds: "1200" },
    ]);
  });

  it("maps caller-scoped per-rule browser-span totals, preserving postgres sum strings", async () => {
    let executeCount = 0;
    const transaction = {
      execute: async () => {
        executeCount += 1;
        if (executeCount === 1) {
          return [{ organization_id: input.organizationId, role: "member" }];
        }
        return [{
          mappingId: "01c7e513-b094-4d4c-ae55-21790ae019a4",
          pattern: "github.com/acme/*",
          projectId: input.projectId,
          durationSeconds: "2400",
        }];
      },
    };
    const db = {
      transaction: async (callback: (handle: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzleReportRepository(db);
    const subject = { organizationId: input.organizationId, userId: input.userId };

    await expect(repository.readSiteTotalsForMember(subject, {})).resolves.toEqual([{
      mapping: { id: "01c7e513-b094-4d4c-ae55-21790ae019a4", pattern: "github.com/acme/*", projectId: input.projectId },
      durationSeconds: "2400",
    }]);
  });

  it("rejects a totals read when membership moved before the locked query", async () => {
    const select = vi.fn();
    const transaction = {
      execute: async () => [{ organization_id: "00000000-0000-4000-8000-000000000999", role: "member" }],
      select,
    };
    const db = {
      transaction: async (callback: (handle: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzleReportRepository(db);
    const subject = { organizationId: input.organizationId, userId: input.userId, role: "member" as const };

    await expect(repository.readLeaderboardForOrganization(subject, {})).rejects.toMatchObject({ code: "forbidden" });
    expect(select).not.toHaveBeenCalled();
  });
});

describe("Drizzle project repository", () => {
  it("creates the project and the creator's membership in one transaction", async () => {
    const subject = { organizationId: input.organizationId, userId: input.userId };
    const row = { id: input.projectId, organizationId: subject.organizationId, name: "Field work", archived: false, createdAt: new Date("2026-08-10T12:00:00.000Z") };
    const inserted: Array<{ table: unknown; values: unknown }> = [];
    const db = {
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        execute: async () => [{ organization_id: subject.organizationId, role: "member" }],
        insert: (table: unknown) => ({
          values: (values: unknown) => {
            inserted.push({ table, values });
            // Awaiting the statement runs the insert; only the project row is read back.
            return Object.assign(Promise.resolve(undefined), { returning: async () => [row] });
          },
        }),
      }),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzleProjectRepository(db);

    await expect(repository.createForMember(subject, "Field work")).resolves.toEqual(row);
    expect(inserted).toHaveLength(2);
    expect(inserted[0]?.table).toBe(projects);
    expect(inserted[0]?.values).toEqual({ organizationId: subject.organizationId, name: "Field work" });
    expect(inserted[1]?.table).toBe(projectMemberships);
    expect(inserted[1]?.values).toEqual({
      organizationId: subject.organizationId,
      projectId: input.projectId,
      userId: subject.userId,
    });
  });
});

describe("Drizzle path-mapping repository", () => {
  it("maps the duplicate-prefix unique constraint to a stable repository conflict", async () => {
    const db = {
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        execute: async () => [{ organization_id: input.organizationId, role: "member" }],
        insert: () => ({ values: () => ({ returning: async () => { throw { code: "23505", constraint_name: "project_path_mappings_organization_user_prefix_unique" }; } }) }),
      }),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzlePathMappingRepository(db);

    await expect(repository.create({
      organizationId: input.organizationId,
      userId: input.userId,
      kind: "path_prefix",
      pathPrefix: "C:/dev/clock-in",
      repoUrl: null,
      projectId: input.projectId,
    })).rejects.toMatchObject({ conflict: "path_prefix" });
  });

  it("throws on an unrecognized stored kind instead of coercing it", async () => {
    const row = {
      id: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
      organizationId: input.organizationId,
      userId: input.userId,
      kind: "glob",
      pathPrefix: "example.com",
      repoUrl: null,
      projectId: input.projectId,
    };
    const db = {
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        execute: async () => [{ organization_id: input.organizationId, role: "member" }],
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
      }),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzlePathMappingRepository(db);
    const subject = { organizationId: input.organizationId, userId: input.userId };

    await expect(repository.findById(subject, row.id)).rejects.toThrow(`Path mapping ${row.id} has an unrecognized kind: glob`);
  });

  it("refuses a mapping read after its subject left the workspace", async () => {
    const select = vi.fn();
    const db = {
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        execute: async () => [{ organization_id: "00000000-0000-4000-8000-000000000999", role: "member" }],
        select,
      }),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzlePathMappingRepository(db);

    await expect(repository.listForSubject({ organizationId: input.organizationId, userId: input.userId, role: "member" }))
      .rejects.toMatchObject({ code: "forbidden" });
    expect(select).not.toHaveBeenCalled();
  });
});
