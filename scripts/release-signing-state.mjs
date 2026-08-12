import { appendFileSync } from "node:fs";

/**
 * Decides what a version tag should do, given which signing secrets exist.
 *
 * Three states, and the middle one is the whole point of the guard:
 *
 * - `unsigned`  nothing is configured for platform code signing, which is the
 *               project's accepted distribution today. A version tag must not
 *               paint the run red for this; installers ship via the
 *               `unsigned-latest` release instead.
 * - `signed`    everything a signed, updatable release needs is present.
 * - `error`     some of it is present. A half-configured release is a
 *               misconfiguration, and it stays loud: silently downgrading to
 *               the unsigned path here would hide a broken signing setup for
 *               as long as nobody looked.
 *
 * Platform code signing is what decides the intent, deliberately, and the
 * updater key is judged separately. The unsigned distribution path signs its
 * own update manifest with `TAURI_SIGNING_PRIVATE_KEY`, so that key existing
 * says nothing about whether anyone meant to code-sign a release. Grouping it
 * with the certificates would make the ordinary unsigned setup read as
 * half-configured and fail every tag, which is the bug this replaces.
 */
export function resolveSigningState({ target, secrets }) {
  const present = (name) => {
    const value = secrets[name];
    return typeof value === "string" && value.trim().length > 0;
  };

  // Which platform secrets this target needs, and which of them it has.
  const platform =
    target === "windows"
      ? {
          required: ["WINDOWS_CERTIFICATE-or-WINDOWS_CERTIFICATE_THUMBPRINT"],
          satisfied: present("WINDOWS_CERTIFICATE") || present("WINDOWS_CERTIFICATE_THUMBPRINT")
            ? ["WINDOWS_CERTIFICATE-or-WINDOWS_CERTIFICATE_THUMBPRINT"]
            : [],
        }
      : {
          required: [
            "APPLE_CERTIFICATE",
            "APPLE_CERTIFICATE_PASSWORD",
            "APPLE_SIGNING_IDENTITY",
            "APPLE_ID",
            "APPLE_PASSWORD",
            "APPLE_TEAM_ID",
          ],
          satisfied: [
            "APPLE_CERTIFICATE",
            "APPLE_CERTIFICATE_PASSWORD",
            "APPLE_SIGNING_IDENTITY",
            "APPLE_ID",
            "APPLE_PASSWORD",
            "APPLE_TEAM_ID",
          ].filter(present),
        };

  if (platform.satisfied.length === 0) {
    return {
      mode: "unsigned",
      notice:
        "Unsigned distribution - installers publish via unsigned-latest; " +
        "configure signing secrets to enable signed releases.",
    };
  }

  const missing = platform.required.filter((name) => !platform.satisfied.includes(name));

  // A Windows certificate blob without its password cannot be imported, so it
  // is missing configuration rather than a usable certificate.
  if (target === "windows" && present("WINDOWS_CERTIFICATE") && !present("WINDOWS_CERTIFICATE_PASSWORD")) {
    missing.push("WINDOWS_CERTIFICATE_PASSWORD");
  }

  // Platform signing is being attempted, so the updater key stops being
  // optional: shipping a signed release nobody can update is worse than not
  // shipping one.
  if (!present("TAURI_SIGNING_PRIVATE_KEY")) {
    missing.push("TAURI_SIGNING_PRIVATE_KEY");
  }

  if (missing.length > 0) {
    return {
      mode: "error",
      message: `Signing is partially configured for ${target}. Configure or remove: ${missing.join(", ")}`,
    };
  }

  return { mode: "signed" };
}

/**
 * The whole tag's verdict, across every platform it would build.
 *
 * One verdict rather than one per platform because a job-level `if` cannot
 * read the `matrix` context, so the build job can only be skipped as a whole.
 * That constraint matches the intent anyway: a tag that would ship a signed
 * Windows installer beside an unsigned macOS one is a misconfiguration, not a
 * release, so a mixed state is an error rather than a partial build.
 */
export function resolveReleaseState({ targets, secrets }) {
  const states = targets.map((target) => ({ target, ...resolveSigningState({ target, secrets }) }));

  const errored = states.find((state) => state.mode === "error");
  if (errored !== undefined) return errored;

  if (states.every((state) => state.mode === "unsigned")) {
    return states[0];
  }
  if (states.every((state) => state.mode === "signed")) {
    return { mode: "signed" };
  }

  const signed = states.filter((state) => state.mode === "signed").map((state) => state.target);
  const unsigned = states.filter((state) => state.mode === "unsigned").map((state) => state.target);
  return {
    mode: "error",
    message:
      `Signing is configured for ${signed.join(", ")} but not for ${unsigned.join(", ")}. ` +
      "A release cannot be signed on one platform and unsigned on another; " +
      "configure the rest, or remove all signing secrets to publish unsigned.",
  };
}

if (process.argv[1] !== undefined && process.argv[1].endsWith("release-signing-state.mjs")) {
  const state = resolveReleaseState({
    targets: ["windows", "macos"],
    secrets: process.env,
  });

  if (state.mode === "error") {
    console.log(`::error::${state.message}`);
    process.exit(1);
  }
  if (state.mode === "unsigned") {
    console.log(`::notice::${state.notice}`);
  }
  if (process.env.GITHUB_OUTPUT !== undefined) {
    appendFileSync(process.env.GITHUB_OUTPUT, `mode=${state.mode}\n`);
  }
}
