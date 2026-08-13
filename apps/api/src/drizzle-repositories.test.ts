import { describe, expect, it, vi } from "vitest";

import { projectMemberships, projects, type DatabaseConnection } from "@clock-in/database";

import { AppError } from "./errors.js";

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
  it("refuses to move the final administrator while other members remain", async () => {
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
        if (selectStep === 3) return { from: () => ({ where: async () => [{ total: 0 }] }) };
        if (selectStep === 4) return limited([{ id: "remaining-member" }]);
        if (selectStep === 5) return limited([]);
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

    await expect(accounts.joinOrganization({ organizationId: currentOrganizationId, userId: input.userId, role: "member" as const }, "ACDEF-GHJKM"))
      .rejects.toMatchObject({
        code: "conflict",
        message: "The final administrator cannot leave a workspace while it still has members.",
      });
    expect(deleted).toEqual([]);
  });

  it("allows an administrator alone in their workspace to move", async () => {
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
        if (selectStep === 3) return { from: () => ({ where: async () => [{ total: 0 }] }) };
        if (selectStep === 4) return limited([]);
        if (selectStep === 5) return limited([]);
        if (selectStep === 6) return { from: () => ({ where: async () => [] }) };
        if (selectStep === 7) return { from: () => ({ where: async () => [{ total: 0 }] }) };
        throw new Error(`unexpected select ${selectStep}`);
      },
      update: () => ({
        set: () => ({
          where: () => ({
            returning: async () => [{ id: input.userId, email: "legacy@example.com", name: "Legacy Admin", organizationId: targetOrganizationId }],
          }),
        }),
      }),
      delete: (table: unknown) => {
        deleted.push(table);
        return { where: async () => undefined };
      },
      insert: () => ({ values: async () => undefined }),
    };
    const db = {
      transaction: async (callback: (handle: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as unknown as DatabaseConnection["db"];
    const accounts = new DrizzleAccountStore(db);

    const result = await accounts.joinOrganization({ organizationId: currentOrganizationId, userId: input.userId, role: "member" as const }, "ACDEF-GHJKM");
    expect(result).toEqual({ id: input.userId, email: "legacy@example.com", name: "Legacy Admin", organizationId: targetOrganizationId });
    expect(deleted).toContain(projectMemberships);
  });

  it("rejects a workspace move when the account has recorded workspace evidence", async () => {
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
        if (selectStep === 3) {
          return { from: () => ({ where: async () => [{ total: 1 }] }) };
        }
        throw new Error(`unexpected select ${selectStep}`);
      },
    };
    const db = {
      transaction: async (callback: (handle: typeof transaction) => Promise<unknown>) => callback(transaction),
    } as unknown as DatabaseConnection["db"];

    try {
      await new DrizzleAccountStore(db).joinOrganization(
        { organizationId: currentOrganizationId, userId: input.userId, role: "member" as const },
        "ACDEF-GHJKM",
      );
      expect.fail("Expected joinOrganization to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).code).toBe("conflict");
      expect((error as AppError).message).toBe("This account has already recorded time in its current workspace, so it cannot be moved.");
    }
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
    const subject = { organizationId: input.organizationId, userId: input.userId, role: "member" as const };

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
    const db = {
      select: () => ({ from: () => rows }),
      transaction: async (callback: (handle: unknown) => Promise<unknown>) => callback({}),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzleReportRepository(db);
    const subject = { organizationId: input.organizationId, userId: input.userId, role: "member" as const };

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
      orderBy: async () => [
        { processName: "Code.exe", durationSeconds: "4800" },
        { processName: "chrome.exe", durationSeconds: "1200" },
      ],
    };
    const db = {
      select: () => ({ from: () => rows }),
      transaction: async (callback: (handle: unknown) => Promise<unknown>) => callback({}),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzleReportRepository(db);
    const subject = { organizationId: input.organizationId, userId: input.userId, role: "member" as const };

    await expect(repository.readAppTotalsForMember(subject, {})).resolves.toEqual([
      { processName: "Code.exe", durationSeconds: "4800" },
      { processName: "chrome.exe", durationSeconds: "1200" },
    ]);
  });

  it("reads leaderboard totals without a transaction-level membership guard", async () => {
    const rows = {
      innerJoin: () => rows,
      where: () => rows,
      groupBy: () => rows,
      orderBy: async () => [{
        userId: input.userId, userName: "Test", durationSeconds: "3600", sessionCount: 1, attributedSeconds: "3600",
      }],
    };
    const db = {
      select: () => ({ from: () => rows }),
      transaction: async (callback: (handle: unknown) => Promise<unknown>) => callback({}),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzleReportRepository(db);
    const subject = { organizationId: input.organizationId, userId: input.userId, role: "member" as const };

    await expect(repository.readLeaderboardForOrganization(subject, {})).resolves.toEqual([{
      user: { id: input.userId, name: "Test" },
      durationSeconds: "3600",
      sessionCount: 1,
      attributedSeconds: "3600",
    }]);
  });
});

describe("Drizzle project repository", () => {
  it("creates the project and the creator's membership in one transaction", async () => {
    const subject = { organizationId: input.organizationId, userId: input.userId, role: "member" as const };
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
      insert: () => ({ values: () => ({ returning: async () => { throw { code: "23505", constraint_name: "project_path_mappings_organization_user_prefix_unique" }; } }) }),
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        execute: async () => [{ organization_id: input.organizationId, role: "member" }],
      }),
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

  it("silently drops an unrecognized stored kind in favor of the default", async () => {
    const row = {
      id: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
      organizationId: input.organizationId,
      userId: input.userId,
      kind: "glob" as const,
      pathPrefix: "example.com",
      repoUrl: null,
      projectId: input.projectId,
    };
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [row] }) }) }),
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        execute: async () => [{ organization_id: input.organizationId, role: "member" }],
      }),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzlePathMappingRepository(db);
    const subject = { organizationId: input.organizationId, userId: input.userId, role: "member" as const };

    const record = await repository.findById(subject, row.id);
    expect(record).not.toBeNull();
    expect(record!.pathPrefix).toBe("example.com");
    expect(record).not.toHaveProperty("kind");
  });

  it("lists mappings for a subject without a transaction-level membership guard", async () => {
    const db = {
      select: () => ({
        from: () => ({
          where: () => ({
            orderBy: async () => [{
              id: "d1c7e513-b094-4d4c-ae55-21790ae019a4",
              organizationId: input.organizationId,
              userId: input.userId,
              kind: "path_prefix",
              pathPrefix: "C:/dev",
              repoUrl: null,
              projectId: input.projectId,
            }],
          }),
        }),
      }),
      transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback({}),
    } as unknown as DatabaseConnection["db"];
    const repository = new DrizzlePathMappingRepository(db);

    const result = await repository.listForSubject({ organizationId: input.organizationId, userId: input.userId, role: "member" });
    expect(result).toHaveLength(1);
    expect(result[0]!.pathPrefix).toBe("C:/dev");
  });
});
