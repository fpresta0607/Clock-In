import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("./release-tauri-config.mjs", import.meta.url));

async function runConfig(environment) {
  const directory = await mkdtemp(path.join(tmpdir(), "clock-in-release-config-"));
  const output = path.join(directory, "github-output");
  try {
    execFileSync(process.execPath, [script], {
      env: { ...process.env, ...environment, GITHUB_OUTPUT: output },
      stdio: "pipe",
    });
    const value = await readFile(output, "utf8");
    return JSON.parse(value.replace(/^config=/, "").trim());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("emits a final-artifact signing configuration for thumbprint releases", async () => {
  const config = await runConfig({
    CLOCK_IN_UPDATER_ENABLED: "true",
    CLOCK_IN_WINDOWS_SIGNING: "true",
    CLOCK_IN_WINDOWS_CERTIFICATE_THUMBPRINT: "ABC123",
    WINDOWS_TIMESTAMP_URL: "https://timestamp.example.test",
  });

  assert.deepEqual(config, {
    bundle: {
      createUpdaterArtifacts: true,
      windows: {
        certificateThumbprint: "ABC123",
        digestAlgorithm: "sha256",
        timestampUrl: "https://timestamp.example.test",
      },
    },
  });
});

test("rejects a release configuration without updater signing", () => {
  assert.throws(() => execFileSync(process.execPath, [script], {
    env: {
      ...process.env,
      CLOCK_IN_UPDATER_ENABLED: "false",
      CLOCK_IN_WINDOWS_SIGNING: "false",
      GITHUB_OUTPUT: path.join(tmpdir(), "clock-in-release-config-missing-updater"),
    },
    stdio: "pipe",
  }));
});

test("rejects a claimed Windows signing release without an imported certificate", () => {
  assert.throws(() => execFileSync(process.execPath, [script], {
    env: {
      ...process.env,
      CLOCK_IN_UPDATER_ENABLED: "true",
      CLOCK_IN_WINDOWS_SIGNING: "true",
      GITHUB_OUTPUT: path.join(tmpdir(), "clock-in-release-config-missing-thumbprint"),
    },
    stdio: "pipe",
  }));
});
