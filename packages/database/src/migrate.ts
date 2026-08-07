import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

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

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Database migration failed.");
    process.exitCode = 1;
  });
}
