import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
const packageDirectory = resolve(sourceDirectory, "..");
const require = createRequire(import.meta.url);
const tsxCli = require.resolve("tsx/cli");

interface CommandResult {
  exitCode: number | null;
  output: string;
}

interface EnvironmentOverrides {
  DATABASE_URL?: string;
  NODE_ENV?: string;
}

function runTsx(arguments_: string[], overrides: EnvironmentOverrides = {}): Promise<CommandResult> {
  return new Promise((resolveResult, reject) => {
    const environment = { ...process.env };
    delete environment.DATABASE_URL;
    delete environment.NODE_ENV;
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
  it("fails safely without DATABASE_URL when migrate.ts is executed", async () => {
    const result = await runTsx([resolve(sourceDirectory, "migrate.ts")]);

    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("DATABASE_URL is required");
    expect(result.output).not.toMatch(/postgres(?:ql)?:\/\//i);
  });

  it("does not execute command entrypoints when they are imported", async () => {
    const result = await runTsx([
      "--eval",
      "import('./src/migrate.ts').catch((error) => { console.error(error); process.exitCode = 1; });",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("");
  });

});
