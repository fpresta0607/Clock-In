import { appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_WINDOWS_TIMESTAMP_URL = "http://timestamp.digicert.com";

export function buildTauriConfig({ updaterEnabled, windowsSigningEnabled, certificateThumbprint, timestampUrl }) {
  const bundle = {};
  if (updaterEnabled) {
    bundle.createUpdaterArtifacts = true;
  }
  if (windowsSigningEnabled) {
    const thumbprint = certificateThumbprint?.trim();
    if (thumbprint === undefined || thumbprint.length === 0) {
      throw new Error("Windows signing requires an imported certificate thumbprint.");
    }
    bundle.windows = {
      certificateThumbprint: thumbprint,
      digestAlgorithm: "sha256",
      timestampUrl: timestampUrl?.trim() || DEFAULT_WINDOWS_TIMESTAMP_URL,
    };
  }
  return { bundle };
}

function enabled(value) {
  return value === "true";
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.env.GITHUB_OUTPUT === undefined) {
    throw new Error("GITHUB_OUTPUT is required to publish the Tauri configuration.");
  }
  const config = buildTauriConfig({
    updaterEnabled: enabled(process.env.CLOCK_IN_UPDATER_ENABLED),
    windowsSigningEnabled: enabled(process.env.CLOCK_IN_WINDOWS_SIGNING),
    certificateThumbprint: process.env.CLOCK_IN_WINDOWS_CERTIFICATE_THUMBPRINT,
    timestampUrl: process.env.WINDOWS_TIMESTAMP_URL,
  });
  appendFileSync(process.env.GITHUB_OUTPUT, `config=${JSON.stringify(config)}\n`);
}
