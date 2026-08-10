use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;
use std::io::Cursor;
use std::path::Path;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SigningConfiguration {
    pub bundle_active: bool,
    pub updater_artifacts_requested: bool,
    pub updater_public_key: Option<String>,
    pub windows_certificate_thumbprint: Option<String>,
}

pub fn effective_tauri_config(mut base: Value, override_config: Option<&Value>) -> Value {
    if let Some(override_config) = override_config {
        merge_tauri_config(&mut base, override_config);
    }
    base
}

pub fn signing_configuration(config: &Value) -> SigningConfiguration {
    SigningConfiguration {
        bundle_active: config
            .pointer("/bundle/active")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        updater_artifacts_requested: config
            .pointer("/bundle/createUpdaterArtifacts")
            .and_then(Value::as_bool)
            .unwrap_or(false),
        updater_public_key: config
            .pointer("/plugins/updater/pubkey")
            .and_then(Value::as_str)
            .map(str::to_owned),
        windows_certificate_thumbprint: config
            .pointer("/bundle/windows/certificateThumbprint")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }
}

pub fn validate_build_signing(
    release: bool,
    target_os: &str,
    config: &SigningConfiguration,
    get: impl Fn(&str) -> Option<String>,
) -> Result<(), String> {
    if !release {
        return (!config.updater_artifacts_requested)
            .then_some(())
            .ok_or_else(|| {
                "A local unsigned build cannot create production updater artifacts.".to_string()
            });
    }
    if !config.bundle_active {
        return Ok(());
    }

    validate_updater_key(
        get("TAURI_SIGNING_PRIVATE_KEY"),
        get("TAURI_SIGNING_PRIVATE_KEY_PASSWORD"),
        config.updater_public_key.clone(),
    )?;

    match target_os {
        "windows" => validate_windows_signing(config.windows_certificate_thumbprint.clone()),
        "macos" => validate_macos_signing(get),
        _ => Ok(()),
    }
}

fn merge_tauri_config(base: &mut Value, override_config: &Value) {
    match (base, override_config) {
        (Value::Object(base), Value::Object(override_config)) => {
            for (key, override_value) in override_config {
                match base.get_mut(key) {
                    Some(base_value) => merge_tauri_config(base_value, override_value),
                    None => {
                        base.insert(key.clone(), override_value.clone());
                    }
                }
            }
        }
        (base, override_config) => *base = override_config.clone(),
    }
}

fn validate_updater_key(
    value: Option<String>,
    password: Option<String>,
    updater_public_key: Option<String>,
) -> Result<(), String> {
    let value = required(value)
        .ok_or_else(|| "TAURI_SIGNING_PRIVATE_KEY must contain a Minisign private key.".to_string())?;
    let value = match Path::new(&value).is_file() {
        true => std::fs::read_to_string(&value)
            .map_err(|_| "TAURI_SIGNING_PRIVATE_KEY could not be read.".to_string())?,
        false => value,
    };
    let secret = minisign::SecretKeyBox::from_string(&minisign_key_text(&value, "TAURI_SIGNING_PRIVATE_KEY")?)
        .map_err(|_| "TAURI_SIGNING_PRIVATE_KEY must contain a Minisign private key.".to_string())?
        .into_secret_key(password)
        .map_err(|_| "TAURI_SIGNING_PRIVATE_KEY must contain a usable Minisign private key.".to_string())?;
    let updater_public_key = required(updater_public_key).ok_or_else(|| {
        "The configured updater public key is required for release signing.".to_string()
    })?;
    let public = minisign::PublicKeyBox::from_string(&minisign_key_text(
        &updater_public_key,
        "The configured updater public key",
    )?)
    .map_err(|_| "The configured updater public key is invalid.".to_string())?
    .into_public_key()
    .map_err(|_| "The configured updater public key is invalid.".to_string())?;
    minisign::sign(
        Some(&public),
        &secret,
        Cursor::new(b"clock-in signing credential validation"),
        None,
        None,
    )
    .map_err(|_| "TAURI_SIGNING_PRIVATE_KEY must contain a usable Minisign private key.".to_string())?;
    Ok(())
}

fn minisign_key_text(value: &str, name: &str) -> Result<String, String> {
    if value.trim_start().starts_with("untrusted comment:") {
        return Ok(value.to_string());
    }
    let decoded = STANDARD
        .decode(value.trim())
        .map_err(|_| format!("{name} must contain a Minisign key."))?;
    String::from_utf8(decoded).map_err(|_| format!("{name} must contain a Minisign key."))
}

fn validate_windows_signing(configured_thumbprint: Option<String>) -> Result<(), String> {
    let thumbprint = configured_thumbprint
        .as_deref()
        .and_then(normalized_windows_thumbprint)
        .ok_or_else(|| {
            "Windows release builds require bundle.windows.certificateThumbprint in the effective Tauri configuration."
                .to_string()
        })?;
    validate_windows_thumbprint(&thumbprint)
}

fn validate_macos_signing(get: impl Fn(&str) -> Option<String>) -> Result<(), String> {
    let required_names = [
        "APPLE_CERTIFICATE",
        "APPLE_CERTIFICATE_PASSWORD",
        "APPLE_SIGNING_IDENTITY",
        "APPLE_ID",
        "APPLE_PASSWORD",
        "APPLE_TEAM_ID",
    ];
    let missing = required_names
        .into_iter()
        .filter(|name| required(get(name)).is_none())
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "macOS release builds require {}.",
            missing.join(", ")
        ))
    }
}

fn required(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.trim().is_empty())
}

fn normalized_windows_thumbprint(value: &str) -> Option<String> {
    let compact = value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    ((compact.len() == 40 || compact.len() == 64)
        && compact.bytes().all(|byte| byte.is_ascii_hexdigit()))
    .then_some(compact)
}

#[cfg(windows)]
fn validate_windows_thumbprint(thumbprint: &str) -> Result<(), String> {
    let command = format!(
        "$ErrorActionPreference = 'Stop'; $certificate = Get-Item -LiteralPath 'Cert:\\CurrentUser\\My\\{thumbprint}'; if (-not $certificate.HasPrivateKey) {{ exit 1 }}"
    );
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .status()
        .map_err(|_| "The configured Windows signing certificate is unavailable.".to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "The configured Windows signing certificate is unavailable.".to_string())
}

#[cfg(not(windows))]
fn validate_windows_thumbprint(_thumbprint: &str) -> Result<(), String> {
    Err("Windows signing configuration can only be validated on Windows.".to_string())
}
