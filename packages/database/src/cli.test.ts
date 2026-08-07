import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import { seedSuccessMessage } from "./seed.js";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(sourceDirectory, "..");
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

interface CommandResult {
  exitCode: number | null;
  output: string;
}

interface EnvironmentOverrides {
  ALLOW_DEVELOPMENT_SEED?: string;
  DATABASE_URL?: string;
  NODE_ENV?: string;
}

function runTsx(arguments_: string[], overrides: EnvironmentOverrides = {}): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const environment = { ...process.env };
    delete environment.DATABASE_URL;
    delete environment.NODE_ENV;
    delete environment.ALLOW_DEVELOPMENT_SEED;
    Object.assign(environment, overrides);
    const child = spawn(process.execPath, [tsxCli, ...arguments_], {
      cwd: packageDirectory,
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolveResult({ exitCode, output });
    });
  });
}

describe("database CLI entrypoints", () => {
  it.each([
    ["migrate.ts", {}],
    ["seed.ts", { NODE_ENV: "development", ALLOW_DEVELOPMENT_SEED: "true" }],
  ])("fails safely without DATABASE_URL when %s is executed", async (entrypoint, overrides) => {
    const result = await runTsx([resolve(sourceDirectory, entrypoint)], overrides);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("DATABASE_URL is required");
    expect(result.output).not.toMatch(/postgres(?:ql)?:\/\//i);
  });

  it("does not execute command entrypoints when they are imported", async () => {
    const result = await runTsx([
      "--eval",
      "import('./src/migrate.ts').then(() => import('./src/seed.ts')).catch((error) => { console.error(error); process.exitCode = 1; });",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("");
  });

  it("does not expose the development password in seed success output", () => {
    expect(seedSuccessMessage).not.toContain("clock-in-development-only");
    expect(seedSuccessMessage).not.toMatch(/password\s*:/i);
  });

  it.each([
    ["NODE_ENV is unset", {}, "NODE_ENV must be development or test"],
    ["NODE_ENV is production", { NODE_ENV: "production", ALLOW_DEVELOPMENT_SEED: "true" }, "NODE_ENV must be development or test"],
    ["development has no opt-in", { NODE_ENV: "development" }, "ALLOW_DEVELOPMENT_SEED=true is required"],
  ])("fails closed when %s", async (_scenario, overrides, expectedMessage) => {
    const result = await runTsx([resolve(sourceDirectory, "seed.ts")], {
      ...overrides,
      DATABASE_URL: "postgresql://127.0.0.1:1/clock_in",
    });

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain(expectedMessage);
    expect(result.output).not.toContain("Failed query");
    expect(result.output).not.toContain("127.0.0.1:1");
  });
});
