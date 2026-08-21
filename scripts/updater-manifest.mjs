import { readFileSync, writeFileSync } from "node:fs";

/**
 * Builds the `latest.json` the installed app polls.
 *
 * The updater only offers a build whose semver is strictly higher than the one
 * running, so `version` is the whole mechanism: get it wrong and either every
 * machine reinstalls in a loop, or none of them ever updates.
 *
 * Windows is the only platform listed on purpose. The macOS updater installs
 * from an app archive, not the `.dmg` the unsigned workflow builds, so
 * advertising a `darwin` entry here would hand the updater something it cannot
 * apply and fail on every Mac.
 */
export function buildUpdaterManifest({ version, baseUrl, signature, installerName, pubDate, notes }) {
  const trimmedVersion = version?.trim();
  if (!trimmedVersion) {
    throw new Error("The update manifest needs the version this build published.");
  }
  // A prerelease suffix is what makes successive test builds comparable, so a
  // bare `0.1.4` from a test run is a mistake worth catching here rather than
  // discovering as a machine that never updates again.
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(trimmedVersion)) {
    throw new Error(`The update manifest version is not semver: ${trimmedVersion}`);
  }
  const trimmedSignature = signature?.trim();
  if (!trimmedSignature) {
    throw new Error("The update manifest needs the installer's minisign signature.");
  }
  const trimmedBase = baseUrl?.trim().replace(/\/+$/, "");
  if (!trimmedBase) {
    throw new Error("The update manifest needs the release's download base URL.");
  }
  if (!installerName?.trim()) {
    throw new Error("The update manifest needs the installer's published name.");
  }

  return {
    version: trimmedVersion,
    notes: notes ?? "Automatic update of the SIQshift unsigned test build.",
    pub_date: pubDate ?? new Date().toISOString(),
    platforms: {
      "windows-x86_64": {
        signature: trimmedSignature,
        url: `${trimmedBase}/${installerName.trim()}`,
      },
    },
  };
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("updater-manifest.mjs")) {
  const installerName = process.env.INSTALLER_NAME;
  const manifest = buildUpdaterManifest({
    version: process.env.VERSION,
    baseUrl: process.env.BASE_URL,
    signature: readFileSync(process.env.SIGNATURE_PATH, "utf8"),
    installerName,
    ...(process.env.PUB_DATE ? { pubDate: process.env.PUB_DATE } : {}),
  });
  writeFileSync(process.env.MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(manifest);
}
