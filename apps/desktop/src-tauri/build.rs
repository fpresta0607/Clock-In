#[path = "src/release_signing.rs"]
mod release_signing;

fn main() {
    for name in [
        "CLOCK_IN_AUTH_URL",
        "CLOCK_IN_API_URL",
        "CLOCK_IN_CHROME_EXTENSION_ID",
        "CLOCK_IN_EDGE_EXTENSION_ID",
        "CLOCK_IN_FIREFOX_EXTENSION_ID",
        "TAURI_SIGNING_PRIVATE_KEY",
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD",
        "WINDOWS_CERTIFICATE",
        "WINDOWS_CERTIFICATE_PASSWORD",
        "WINDOWS_CERTIFICATE_THUMBPRINT",
        "APPLE_CERTIFICATE",
        "APPLE_CERTIFICATE_PASSWORD",
        "APPLE_SIGNING_IDENTITY",
        "APPLE_ID",
        "APPLE_PASSWORD",
        "APPLE_TEAM_ID",
        "TAURI_CONFIG",
    ] {
        println!("cargo:rerun-if-env-changed={name}");
    }

    let release = !cfg!(debug_assertions);
    let tauri_config = std::env::var("TAURI_CONFIG")
        .ok()
        .and_then(|config| serde_json::from_str::<serde_json::Value>(&config).ok())
        .or_else(|| {
            std::fs::read_to_string("tauri.conf.json")
                .ok()
                .and_then(|config| serde_json::from_str::<serde_json::Value>(&config).ok())
        });
    let updater_artifacts_requested = tauri_config
        .as_ref()
        .and_then(|config| {
            config
                .pointer("/bundle/createUpdaterArtifacts")
                .and_then(serde_json::Value::as_bool)
        })
        .unwrap_or(false);
    let updater_public_key = tauri_config.as_ref().and_then(|config| {
        config
            .pointer("/plugins/updater/pubkey")
            .and_then(serde_json::Value::as_str)
            .map(str::to_owned)
    });
    let target_os = std::env::var("CARGO_CFG_TARGET_OS")
        .unwrap_or_else(|_| std::env::consts::OS.to_string());
    release_signing::validate_build_signing(
        release,
        &target_os,
        updater_artifacts_requested,
        updater_public_key,
        |name| std::env::var(name).ok(),
    )
    .unwrap_or_else(|error| panic!("{error}"));

    // These are baked in at compile time, so a release built without them would
    // install and then quietly fail to reach anything. Fail the build instead.
    if release {
        for name in ["CLOCK_IN_AUTH_URL", "CLOCK_IN_API_URL"] {
            match std::env::var(name) {
                Ok(value) if value.starts_with("https://") => {}
                Ok(value) if value.is_empty() => {
                    panic!("{name} is empty. A release build must point at the production {name}.")
                }
                Ok(value) => panic!("{name} is {value:?}. A release build must use https."),
                Err(_) => panic!("{name} is not set. A release build must point at production."),
            }
        }
    }
    // The helpers ship as externalBin siblings (see release.yml's staging
    // step), and tauri-build validates those paths on every build — including
    // `cargo test` and `tauri dev`, where bundling never happens. Debug builds
    // get empty stand-ins; release builds require the real (signed) helpers,
    // so a release staged without them fails loudly.
    if !release {
        let triple = std::env::var("TARGET").expect("TARGET is set for build scripts");
        let suffix = if cfg!(windows) { ".exe" } else { "" };
        let dir = std::path::Path::new("binaries");
        std::fs::create_dir_all(dir).expect("the binaries directory is creatable");
        for name in ["clock-in-hook", "clock-in-browser-host"] {
            let stub = dir.join(format!("{name}-{triple}{suffix}"));
            if !stub.exists() {
                std::fs::write(&stub, []).expect("a debug stand-in is writable");
            }
        }
    }

    tauri_build::build()
}
