import { describe, expect, it } from "vitest";

import type { DatabaseConnection } from "@clock-in/database";

import { DrizzleSessionRepository } from "./drizzle-repositories.js";

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
