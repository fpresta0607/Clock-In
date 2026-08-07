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

    tauri_build::build()
}
