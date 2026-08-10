import { randomUUID } from "node:crypto";

import postgres from "postgres";

import { createDatabase, type DatabaseConnection } from "./client.js";

export interface DisposableTestDatabase {
  database: DatabaseConnection;
  databaseName: string;
  databaseUrl: string;
  cleanup(): Promise<void>;
}

const disposableCapabilityParameter = "clock_in_disposable_test_capability";

export function verifyDisposableTestDatabaseUrl(
  configuredUrl: string,
  capability = process.env.CLOCK_IN_DISPOSABLE_TEST_CAPABILITY,
): string {
  const url = new URL(configuredUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use a PostgreSQL URL.");
  }
  const marker = url.searchParams.get(disposableCapabilityParameter);
  if (capability === undefined || capability.length < 16 || marker !== capability) {
    throw new Error("TEST_DATABASE_URL requires an explicit disposable-test capability.");
  }
  url.searchParams.delete(disposableCapabilityParameter);
  return url.toString();
}

function databaseName(label: string): string {
  const safeLabel = label.replace(/[^a-z0-9]/gi, "_").toLowerCase().slice(0, 12) || "run";
  return `clock_in_test_${safeLabel}_${randomUUID().replaceAll("-", "")}`;
}

function controlUrl(configuredUrl: string): string {
  const url = new URL(configuredUrl);
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") {
    throw new Error("TEST_DATABASE_URL must use a PostgreSQL URL.");
  }
  url.pathname = "/postgres";
  return url.toString();
}

function urlForDatabase(configuredUrl: string, name: string): string {
  const url = new URL(configuredUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

function quotedIdentifier(name: string): string {
  if (!/^[a-z0-9_]+$/.test(name)) {
    throw new Error("Disposable database names must contain only lowercase letters, numbers, and underscores.");
  }
  return `"${name}"`;
}

async function dropDisposableDatabase(controlDatabaseUrl: string, name: string): Promise<void> {
  const control = postgres(controlDatabaseUrl, { max: 1 });
  try {
    await control.unsafe(`drop database if exists ${quotedIdentifier(name)} with (force)`);
  } finally {
    await control.end({ timeout: 5 });
  }
}

export async function createDisposableTestDatabase(
  configuredUrl: string,
  label: string,
  capability?: string,
): Promise<DisposableTestDatabase> {
  const verifiedUrl = verifyDisposableTestDatabaseUrl(configuredUrl, capability);
  const name = databaseName(label);
  const controlDatabaseUrl = controlUrl(verifiedUrl);
  const disposableUrl = urlForDatabase(verifiedUrl, name);
  const control = postgres(controlDatabaseUrl, { max: 1 });
  let creationError: Error | undefined;
  try {
    await control.unsafe(`create database ${quotedIdentifier(name)}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown database error";
    creationError = new Error(`Could not create the disposable integration database: ${message}`);
  }
  let controlCloseError: unknown;
  try {
    await control.end({ timeout: 5 });
  } catch (error) {
    controlCloseError = error;
  }
  if (creationError !== undefined) {
    try {
      await dropDisposableDatabase(controlDatabaseUrl, name);
    } catch (dropError) {
      void dropError;
    }
    throw creationError;
  }
  if (controlCloseError !== undefined) {
    try {
      await dropDisposableDatabase(controlDatabaseUrl, name);
    } catch (dropError) {
      void dropError;
    }
    throw controlCloseError;
  }

  let database: DatabaseConnection;
  try {
    database = createDatabase(disposableUrl, { max: 1 });
  } catch (error) {
    try {
      await dropDisposableDatabase(controlDatabaseUrl, name);
    } catch (dropError) {
      void dropError;
    }
    throw error;
  }
  try {
    const rows = await database.client<{ current_database: string }[]>`select current_database()`;
    if (rows[0]?.current_database !== name) {
      throw new Error("The integration connection did not reach its disposable database.");
    }
  } catch (error) {
    let closeError: unknown;
    let dropError: unknown;
    try {
      await database.client.end({ timeout: 5 });
    } catch (closeFailure) {
      closeError = closeFailure;
    } finally {
      try {
        await dropDisposableDatabase(controlDatabaseUrl, name);
      } catch (dropFailure) {
        dropError = dropFailure;
      }
    }
    void closeError;
    void dropError;
    throw error;
  }

  return {
    database,
    databaseName: name,
    databaseUrl: disposableUrl,
    cleanup: async () => {
      let closeError: unknown;
      let dropError: unknown;
      try {
        await database.client.end({ timeout: 5 });
      } catch (error) {
        closeError = error;
      } finally {
        try {
          await dropDisposableDatabase(controlDatabaseUrl, name);
        } catch (error) {
          dropError = error;
        }
      }
      if (closeError !== undefined) throw closeError;
      if (dropError !== undefined) throw dropError;
    },
  };
}
