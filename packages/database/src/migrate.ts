import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/postgres-js/migrator";

import { createDatabase, type DatabaseConnection } from "./client.js";

const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));

export async function runMigrations(database: DatabaseConnection): Promise<void> {
  await migrate(database.db, { migrationsFolder });
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations.");
  }

  const database = createDatabase(databaseUrl);
  try {
    await runMigrations(database);
    console.info("Database migrations applied.");
  } finally {
    await database.client.end({ timeout: 5 });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Database migration failed.");
    process.exitCode = 1;
  });
}
