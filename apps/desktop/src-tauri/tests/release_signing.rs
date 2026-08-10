#[path = "../src/release_signing.rs"]
mod release_signing;

fn signer_environment(name: &str) -> Option<String> {
    match name {
        "TAURI_SIGNING_PRIVATE_KEY" => Some(
            "untrusted comment: minisign secret key\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
                .to_string(),
        ),
        "WINDOWS_CERTIFICATE_THUMBPRINT" => {
            Some("0123456789abcdef0123456789abcdef01234567".to_string())
        }
        "APPLE_CERTIFICATE" | "APPLE_CERTIFICATE_PASSWORD" | "APPLE_SIGNING_IDENTITY"
        | "APPLE_ID" | "APPLE_PASSWORD" | "APPLE_TEAM_ID" => Some("configured".to_string()),
        _ => None,
    }
}

#[test]
fn direct_release_builds_reject_missing_updater_signing() {
    let error = release_signing::validate_build_signing(true, "windows", false, |_| None)
        .expect_err("a release build without credentials must fail");

    assert!(error.contains("TAURI_SIGNING_PRIVATE_KEY"));
}

#[test]
fn signed_release_builds_require_target_platform_credentials() {
    let error = release_signing::validate_build_signing(true, "windows", false, |name| {
        (name == "TAURI_SIGNING_PRIVATE_KEY").then(|| signer_environment(name).expect("key exists"))
    })
    .expect_err("a Windows release without an installer signing credential must fail");
    assert!(error.contains("WINDOWS_CERTIFICATE"));

    release_signing::validate_build_signing(true, "windows", false, signer_environment)
        .expect("a fully signed Windows release is allowed");
    release_signing::validate_build_signing(true, "macos", false, signer_environment)
        .expect("a fully signed macOS release is allowed");
}

#[test]
fn local_unsigned_builds_cannot_request_updater_artifacts() {
    let error = release_signing::validate_build_signing(false, "windows", true, |_| None)
        .expect_err("debug updater artifacts must be refused");

    assert!(error.contains("unsigned"));
    release_signing::validate_build_signing(false, "windows", false, |_| None)
        .expect("a local debug build remains available");
}
