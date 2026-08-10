#[path = "../src/release_signing.rs"]
mod release_signing;

use base64::{engine::general_purpose::STANDARD, Engine as _};

fn updater_public_key() -> String {
    let private_key = signer_environment("TAURI_SIGNING_PRIVATE_KEY")
        .expect("test updater private key exists");
    let decoded = STANDARD.decode(private_key).expect("test updater private key decodes");
    let private_key = String::from_utf8(decoded).expect("test updater private key is utf8");
    let secret = minisign::SecretKeyBox::from_string(&private_key)
        .expect("test updater private key parses")
        .into_secret_key(Some(String::new()))
        .expect("test updater private key decrypts");
    let public = minisign::PublicKey::from_secret_key(&secret)
        .expect("test updater public key derives");
    let public = public.to_box().expect("test updater public key boxes").to_string();
    STANDARD.encode(public)
}

fn signer_environment(name: &str) -> Option<String> {
    match name {
        "TAURI_SIGNING_PRIVATE_KEY" => Some("dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5ClJXUlRZMEl5dkpDN09RZm5GeVAzc2RuYlNzWVVJelJRQnNIV2JUcGVXZUplWXZXYXpqUUFBQkFBQUFBQUFBQUFBQUlBQUFBQTZrN2RnWGh5dURxSzZiL1ZQSDdNcktiaHRxczQwMXdQelRHbjRNcGVlY1BLMTBxR2dpa3I3dDE1UTVDRDE4MXR4WlQwa1BQaXdxKy9UU2J2QmVSNXhOQWFDeG1GSVllbUNpTGJQRkhhTnROR3I5RmdUZi90OGtvaGhJS1ZTcjdZU0NyYzhQWlQ5cGM9Cg==".to_string()),
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" => Some(String::new()),
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
    let error = release_signing::validate_build_signing(true, "windows", false, None, |_| None)
        .expect_err("a release build without credentials must fail");

    assert!(error.contains("TAURI_SIGNING_PRIVATE_KEY"));
}

#[test]
fn signed_release_builds_require_target_platform_credentials() {
    let error = release_signing::validate_build_signing(
        true,
        "windows",
        false,
        Some(updater_public_key()),
        signer_environment,
    )
    .expect_err("a Windows release without an installer signing credential must fail");
    assert!(error.to_lowercase().contains("windows"));

    release_signing::validate_build_signing(
        true,
        "linux",
        false,
        Some(updater_public_key()),
        signer_environment,
    )
        .expect("a release with a parsed updater credential is allowed");
}

#[test]
fn direct_release_builds_reject_format_only_signing_values() {
    let error = release_signing::validate_build_signing(
        true,
        "linux",
        false,
        Some(updater_public_key()),
        |name| {
            (name == "TAURI_SIGNING_PRIVATE_KEY").then(|| {
                "untrusted comment: minisign secret key\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
                    .to_string()
            })
        },
    )
    .expect_err("format-only key material cannot sign a release");

    assert!(error.contains("TAURI_SIGNING_PRIVATE_KEY"));
}

#[test]
fn direct_release_builds_require_the_configured_updater_key() {
    let alternate = minisign::KeyPair::generate_unencrypted_keypair()
        .expect("alternate updater keypair generates");
    let alternate = alternate
        .pk
        .to_box()
        .expect("alternate updater public key boxes")
        .to_string();
    let alternate = STANDARD.encode(alternate);

    let error = release_signing::validate_build_signing(
        true,
        "linux",
        false,
        Some(alternate),
        signer_environment,
    )
    .expect_err("an unrelated updater key cannot authorize a release");

    assert!(error.contains("TAURI_SIGNING_PRIVATE_KEY"));
}

#[test]
fn local_unsigned_builds_cannot_request_updater_artifacts() {
    let error = release_signing::validate_build_signing(false, "windows", true, None, |_| None)
        .expect_err("debug updater artifacts must be refused");

    assert!(error.contains("unsigned"));
    release_signing::validate_build_signing(false, "windows", false, None, |_| None)
        .expect("a local debug build remains available");
}
