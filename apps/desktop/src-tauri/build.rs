fn main() {
    // These are baked in at compile time, so a release built without them would
    // install and then quietly fail to reach anything. Fail the build instead.
    if !cfg!(debug_assertions) {
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
    println!("cargo:rerun-if-env-changed=CLOCK_IN_AUTH_URL");
    println!("cargo:rerun-if-env-changed=CLOCK_IN_API_URL");

    // The helpers ship as externalBin siblings (see release.yml's staging
    // step), and tauri-build validates those paths on every build — including
    // `cargo test` and `tauri dev`, where bundling never happens. Debug builds
    // get empty stand-ins; release builds require the real (signed) helpers,
    // so a release staged without them fails loudly.
    if cfg!(debug_assertions) {
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
