#[path = "../src/release_signing.rs"]
mod release_signing;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use release_signing::SigningConfiguration;

fn raw_updater_key() -> String {
    let private_key = signer_environment("TAURI_SIGNING_PRIVATE_KEY")
        .expect("test updater private key exists");
    let decoded = STANDARD.decode(private_key).expect("test updater private key decodes");
    String::from_utf8(decoded).expect("test updater private key is utf8")
}

fn updater_public_key() -> String {
    let secret = minisign::SecretKeyBox::from_string(&raw_updater_key())
        .expect("test updater private key parses")
        .into_secret_key(Some(String::new()))
        .expect("test updater private key decrypts");
    let public = minisign::PublicKey::from_secret_key(&secret)
        .expect("test updater public key derives");
    let public = public.to_box().expect("test updater public key boxes").to_string();
    STANDARD.encode(public)
}

fn production_config() -> SigningConfiguration {
    SigningConfiguration {
        updater_artifacts_requested: false,
        updater_public_key: Some(updater_public_key()),
        windows_certificate_thumbprint: None,
    }
}

fn signer_environment(name: &str) -> Option<String> {
    match name {
        "TAURI_SIGNING_PRIVATE_KEY" => Some("dW50cnVzdGVkIGNvbW1lbnQ6IHJzaWduIGVuY3J5cHRlZCBzZWNyZXQga2V5ClJXUlRZMEl5dkpDN09RZm5GeVAzc2RuYlNzWVVJelJRQnNIV2JUcGVXZUplWXZXYXpqUUFBQkFBQUFBQUFBQUFBQUlBQUFBQTZrN2RnWGh5dURxSzZiL1ZQSDdNcktiaHRxczQwMXdQelRHbjRNcGVlY1BLMTBxR2dpa3I3dDE1UTVDRDE4MXR4WlQwa1BQaXdxKy9UU2J2QmVSNXhOQWFDeG1GSVllbUNpTGJQRkhhTnROR3I5RmdUZi90OGtvaGhJS1ZTcjdZU0NyYzhQWlQ5cGM9Cg==".to_string()),
        "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" => Some(String::new()),
        _ => None,
    }
}

#[test]
fn helper_overrides_merge_with_the_base_release_configuration() {
    let base = serde_json::json!({
        "bundle": { "active": true, "externalBin": ["clock-in-hook"] },
        "plugins": { "updater": { "pubkey": "configured-key" } }
    });
    let helper_override = serde_json::json!({ "bundle": { "active": false, "externalBin": [] } });

    let effective = release_signing::effective_tauri_config(base, Some(&helper_override));
    let config = release_signing::signing_configuration(&effective);

    assert_eq!(config.updater_public_key.as_deref(), Some("configured-key"));
    let error = release_signing::validate_build_signing(true, "linux", &config, |_| None)
        .expect_err("a configuration-only helper override cannot skip release signing");
    assert!(error.contains("TAURI_SIGNING_PRIVATE_KEY"));
}

#[test]
fn direct_release_builds_cannot_disable_signing_with_tauri_config() {
    let base = serde_json::json!({
        "bundle": { "active": true },
        "plugins": { "updater": { "pubkey": updater_public_key() } }
    });
    let override_config = serde_json::json!({ "bundle": { "active": false } });
    let config = release_signing::signing_configuration(&release_signing::effective_tauri_config(
        base,
        Some(&override_config),
    ));

    let error = release_signing::validate_build_signing(true, "linux", &config, |_| None)
        .expect_err("a direct release cannot disable its signing gate through TAURI_CONFIG");
    assert!(error.contains("TAURI_SIGNING_PRIVATE_KEY"));
}

#[test]
fn direct_release_builds_reject_missing_updater_signing() {
    let error = release_signing::validate_build_signing(true, "windows", &production_config(), |_| None)
        .expect_err("a release build without credentials must fail");

    assert!(error.contains("TAURI_SIGNING_PRIVATE_KEY"));
}

#[test]
fn signed_release_builds_require_effective_windows_signing_configuration() {
    let error = release_signing::validate_build_signing(
        true,
        "windows",
        &production_config(),
        signer_environment,
    )
    .expect_err("a Windows release without Tauri signing configuration must fail");
    assert!(error.contains("bundle.windows.certificateThumbprint"));

    release_signing::validate_build_signing(true, "linux", &production_config(), signer_environment)
        .expect("a release with matching updater credentials is allowed");
}

#[test]
fn direct_release_builds_reject_format_only_signing_values() {
    let error = release_signing::validate_build_signing(true, "linux", &production_config(), |name| {
        (name == "TAURI_SIGNING_PRIVATE_KEY").then(|| {
            "untrusted comment: minisign secret key\nRWQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
                .to_string()
        })
    })
    .expect_err("format-only key material cannot sign a release");

    assert!(error.contains("TAURI_SIGNING_PRIVATE_KEY"));
}

#[test]
fn direct_release_builds_accept_raw_and_path_updater_keys() {
    let raw_key = raw_updater_key();
    release_signing::validate_build_signing(true, "linux", &production_config(), |name| {
        match name {
            "TAURI_SIGNING_PRIVATE_KEY" => Some(raw_key.clone()),
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" => Some(String::new()),
            _ => None,
        }
    })
    .expect("a documented raw updater key is accepted");

    let path = std::env::temp_dir().join(format!(
        "clock-in-release-signing-key-{}",
        std::process::id()
    ));
    std::fs::write(&path, raw_key).expect("updater key file writes");
    let result = release_signing::validate_build_signing(true, "linux", &production_config(), |name| {
        match name {
            "TAURI_SIGNING_PRIVATE_KEY" => Some(path.display().to_string()),
            "TAURI_SIGNING_PRIVATE_KEY_PASSWORD" => Some(String::new()),
            _ => None,
        }
    });
    let _ = std::fs::remove_file(&path);

    result.expect("a documented updater key path is accepted");
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
    let config = SigningConfiguration {
        updater_public_key: Some(alternate),
        ..production_config()
    };

    let error = release_signing::validate_build_signing(true, "linux", &config, signer_environment)
        .expect_err("an unrelated updater key cannot authorize a release");

    assert!(error.contains("TAURI_SIGNING_PRIVATE_KEY"));
}

#[test]
fn local_unsigned_builds_cannot_request_updater_artifacts() {
    let updater_config = SigningConfiguration {
        updater_artifacts_requested: true,
        ..production_config()
    };
    let error = release_signing::validate_build_signing(false, "windows", &updater_config, |_| None)
        .expect_err("debug updater artifacts must be refused");

    assert!(error.contains("unsigned"));
    release_signing::validate_build_signing(false, "windows", &production_config(), |_| None)
        .expect("a local debug build remains available");
}
