import assert from "node:assert/strict";
import { test } from "node:test";

import { buildUpdaterManifest } from "./updater-manifest.mjs";

const valid = {
  version: "0.1.4-test.12",
  baseUrl: "https://github.com/fpresta0607/Clock-In/releases/download/unsigned-latest",
  signature: "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=\n",
  installerName: "Clock-In-UNSIGNED-TEST-windows-x64-setup.exe",
  pubDate: "2026-08-12T00:00:00.000Z",
};

test("points the updater at the published installer under the stable tag", () => {
  const manifest = buildUpdaterManifest(valid);

  assert.equal(manifest.version, "0.1.4-test.12");
  assert.equal(
    manifest.platforms["windows-x86_64"].url,
    "https://github.com/fpresta0607/Clock-In/releases/download/unsigned-latest/Clock-In-UNSIGNED-TEST-windows-x64-setup.exe",
  );
  // The trailing newline a signature file carries would fail verification.
  assert.equal(manifest.platforms["windows-x86_64"].signature, "dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZQo=");
});

test("lists no macOS platform, which the updater could not install from a dmg", () => {
  const manifest = buildUpdaterManifest(valid);

  assert.deepEqual(Object.keys(manifest.platforms), ["windows-x86_64"]);
});

test("survives a base URL that already ends in a slash", () => {
  const manifest = buildUpdaterManifest({ ...valid, baseUrl: `${valid.baseUrl}/` });

  assert.ok(!manifest.platforms["windows-x86_64"].url.includes("//Clock-In"));
});

test("refuses a version that is not semver, which would strand every install", () => {
  assert.throws(() => buildUpdaterManifest({ ...valid, version: "unsigned-latest" }), /not semver/);
  assert.throws(() => buildUpdaterManifest({ ...valid, version: "0.1" }), /not semver/);
});

test("refuses a manifest with no signature, which every client would reject", () => {
  assert.throws(() => buildUpdaterManifest({ ...valid, signature: "  \n" }), /minisign signature/);
});

test("refuses the pieces it cannot invent", () => {
  assert.throws(() => buildUpdaterManifest({ ...valid, version: undefined }), /version/);
  assert.throws(() => buildUpdaterManifest({ ...valid, baseUrl: "" }), /base URL/);
  assert.throws(() => buildUpdaterManifest({ ...valid, installerName: "" }), /installer/);
});

// The scheme the workflow stamps has to keep sorting forward, or an installed
// build stops accepting anything. Node has no semver comparator built in, so
// this asserts the property the scheme relies on: numeric prerelease
// identifiers compare as numbers, not as text.
test("successive run numbers produce versions that sort forward", () => {
  const versions = [2, 9, 10, 11].map(
    (run) => buildUpdaterManifest({ ...valid, version: `0.1.4-test.${run}` }).version,
  );

  assert.deepEqual(versions, ["0.1.4-test.2", "0.1.4-test.9", "0.1.4-test.10", "0.1.4-test.11"]);
  const runNumbers = versions.map((version) => Number(version.split("-test.")[1]));
  assert.deepEqual(runNumbers, [...runNumbers].sort((left, right) => left - right));
});
