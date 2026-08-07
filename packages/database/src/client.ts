import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";

import * as schema from "./schema.js";

export interface DatabaseConnection {
  client: Sql;
  db: PostgresJsDatabase<typeof schema>;
}

export function createDatabase(databaseUrl: string): DatabaseConnection {
  if (databaseUrl.length === 0) {
    throw new Error("A database URL is required.");
  }

  const client = postgres(databaseUrl);
  return { client, db: drizzle({ client, schema }) };
}
