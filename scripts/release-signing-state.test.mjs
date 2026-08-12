import assert from "node:assert/strict";
import { test } from "node:test";

import { resolveReleaseState, resolveSigningState } from "./release-signing-state.mjs";

const APPLE = {
  APPLE_CERTIFICATE: "cert",
  APPLE_CERTIFICATE_PASSWORD: "pw",
  APPLE_SIGNING_IDENTITY: "Developer ID Application: Example",
  APPLE_ID: "dev@example.com",
  APPLE_PASSWORD: "app-specific",
  APPLE_TEAM_ID: "TEAM123",
};

test("nothing configured is the unsigned path, not a failure", () => {
  for (const target of ["windows", "macos"]) {
    const state = resolveSigningState({ target, secrets: {} });

    assert.equal(state.mode, "unsigned");
    assert.match(state.notice, /unsigned-latest/);
    assert.match(state.notice, /configure signing secrets/i);
  }
});

// The regression this replaces: the updater key exists because the *unsigned*
// distribution signs its own update manifest with it. Reading that as
// half-configured signing failed every version tag.
test("an updater key alone is still the unsigned path", () => {
  for (const target of ["windows", "macos"]) {
    const state = resolveSigningState({
      target,
      secrets: { TAURI_SIGNING_PRIVATE_KEY: "key", TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "" },
    });

    assert.equal(state.mode, "unsigned");
  }
});

test("fully configured signing releases", () => {
  const windows = resolveSigningState({
    target: "windows",
    secrets: { WINDOWS_CERTIFICATE_THUMBPRINT: "AB12", TAURI_SIGNING_PRIVATE_KEY: "key" },
  });
  assert.equal(windows.mode, "signed");

  const macos = resolveSigningState({
    target: "macos",
    secrets: { ...APPLE, TAURI_SIGNING_PRIVATE_KEY: "key" },
  });
  assert.equal(macos.mode, "signed");
});

test("a partially configured mac stays loud instead of quietly downgrading", () => {
  const state = resolveSigningState({
    target: "macos",
    secrets: { APPLE_CERTIFICATE: "cert", TAURI_SIGNING_PRIVATE_KEY: "key" },
  });

  assert.equal(state.mode, "error");
  assert.match(state.message, /APPLE_TEAM_ID/);
  assert.match(state.message, /partially configured/);
});

test("a Windows certificate without its password cannot be imported, so it fails", () => {
  const state = resolveSigningState({
    target: "windows",
    secrets: { WINDOWS_CERTIFICATE: "blob", TAURI_SIGNING_PRIVATE_KEY: "key" },
  });

  assert.equal(state.mode, "error");
  assert.match(state.message, /WINDOWS_CERTIFICATE_PASSWORD/);
});

// Platform signing without an updater key would ship a release nobody can
// update, which is worse than not shipping one.
test("code signing without the updater key fails rather than shipping a dead end", () => {
  const state = resolveSigningState({
    target: "windows",
    secrets: { WINDOWS_CERTIFICATE_THUMBPRINT: "AB12" },
  });

  assert.equal(state.mode, "error");
  assert.match(state.message, /TAURI_SIGNING_PRIVATE_KEY/);
});

test("blank and whitespace-only secrets count as absent, as GitHub supplies them", () => {
  const state = resolveSigningState({
    target: "macos",
    secrets: Object.fromEntries(Object.keys(APPLE).map((name) => [name, "   "])),
  });

  assert.equal(state.mode, "unsigned");
});

test("an unknown target is treated as macOS, the stricter set", () => {
  const state = resolveSigningState({ target: undefined, secrets: {} });

  assert.equal(state.mode, "unsigned");
});

// The build job can only be skipped as a whole, so the tag needs one verdict.
test("a tag with nothing configured anywhere skips instead of failing", () => {
  const state = resolveReleaseState({ targets: ["windows", "macos"], secrets: {} });

  assert.equal(state.mode, "unsigned");
  assert.match(state.notice, /unsigned-latest/);
});

test("a tag with the updater key but no certificates still skips", () => {
  const state = resolveReleaseState({
    targets: ["windows", "macos"],
    secrets: { TAURI_SIGNING_PRIVATE_KEY: "key" },
  });

  assert.equal(state.mode, "unsigned");
});

test("a tag with every platform configured releases", () => {
  const state = resolveReleaseState({
    targets: ["windows", "macos"],
    secrets: { ...APPLE, WINDOWS_CERTIFICATE_THUMBPRINT: "AB12", TAURI_SIGNING_PRIVATE_KEY: "key" },
  });

  assert.equal(state.mode, "signed");
});

test("signing one platform but not the other is an error, not a partial release", () => {
  const state = resolveReleaseState({
    targets: ["windows", "macos"],
    secrets: { WINDOWS_CERTIFICATE_THUMBPRINT: "AB12", TAURI_SIGNING_PRIVATE_KEY: "key" },
  });

  assert.equal(state.mode, "error");
  assert.match(state.message, /windows/);
  assert.match(state.message, /macos/);
});

test("a genuinely half-configured platform surfaces its own missing secrets", () => {
  const state = resolveReleaseState({
    targets: ["windows", "macos"],
    secrets: { ...APPLE, APPLE_TEAM_ID: "", WINDOWS_CERTIFICATE_THUMBPRINT: "AB12", TAURI_SIGNING_PRIVATE_KEY: "key" },
  });

  assert.equal(state.mode, "error");
  assert.match(state.message, /APPLE_TEAM_ID/);
});
