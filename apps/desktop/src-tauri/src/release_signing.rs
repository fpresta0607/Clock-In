use base64::{engine::general_purpose::STANDARD, Engine as _};
use std::io::Cursor;
use std::path::Path;

pub fn validate_build_signing(
    release: bool,
    target_os: &str,
    updater_artifacts_requested: bool,
    updater_public_key: Option<String>,
    get: impl Fn(&str) -> Option<String>,
) -> Result<(), String> {
    if !release {
        return (!updater_artifacts_requested)
            .then_some(())
            .ok_or_else(|| {
                "A local unsigned build cannot create production updater artifacts.".to_string()
            });
    }

    validate_updater_key(
        get("TAURI_SIGNING_PRIVATE_KEY"),
        get("TAURI_SIGNING_PRIVATE_KEY_PASSWORD"),
        updater_public_key,
    )?;

    match target_os {
        "windows" => validate_windows_signing(get),
        "macos" => validate_macos_signing(get),
        _ => Ok(()),
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
    let decoded = STANDARD
        .decode(value.trim())
        .map_err(|_| "TAURI_SIGNING_PRIVATE_KEY must contain a Minisign private key.".to_string())?;
    let decoded = String::from_utf8(decoded)
        .map_err(|_| "TAURI_SIGNING_PRIVATE_KEY must contain a Minisign private key.".to_string())?;
    let secret = minisign::SecretKeyBox::from_string(&decoded)
        .map_err(|_| "TAURI_SIGNING_PRIVATE_KEY must contain a Minisign private key.".to_string())?
        .into_secret_key(password)
        .map_err(|_| "TAURI_SIGNING_PRIVATE_KEY must contain a usable Minisign private key.".to_string())?;
    let updater_public_key = required(updater_public_key).ok_or_else(|| {
        "The configured updater public key is required for release signing.".to_string()
    })?;
    let decoded_public_key = STANDARD
        .decode(updater_public_key.trim())
        .map_err(|_| "The configured updater public key is invalid.".to_string())?;
    let decoded_public_key = String::from_utf8(decoded_public_key)
        .map_err(|_| "The configured updater public key is invalid.".to_string())?;
    let public = minisign::PublicKeyBox::from_string(&decoded_public_key)
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

fn validate_windows_signing(get: impl Fn(&str) -> Option<String>) -> Result<(), String> {
    let certificate = required(get("WINDOWS_CERTIFICATE"));
    let thumbprint = required(get("WINDOWS_CERTIFICATE_THUMBPRINT"));
    if let Some(certificate) = certificate {
        let password = get("WINDOWS_CERTIFICATE_PASSWORD").ok_or_else(|| {
            "WINDOWS_CERTIFICATE_PASSWORD is required with WINDOWS_CERTIFICATE.".to_string()
        })?;
        return validate_windows_certificate(&certificate, &password);
    }
    let thumbprint = thumbprint.ok_or_else(|| {
        "Windows release builds require WINDOWS_CERTIFICATE plus WINDOWS_CERTIFICATE_PASSWORD or WINDOWS_CERTIFICATE_THUMBPRINT.".to_string()
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
fn validate_windows_certificate(certificate: &str, password: &str) -> Result<(), String> {
    let status = std::process::Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "$ErrorActionPreference = 'Stop'; $bytes = [Convert]::FromBase64String($env:WINDOWS_CERTIFICATE); $certificate = [Security.Cryptography.X509Certificates.X509Certificate2]::new($bytes, $env:WINDOWS_CERTIFICATE_PASSWORD, [Security.Cryptography.X509Certificates.X509KeyStorageFlags]::EphemeralKeySet); if (-not $certificate.HasPrivateKey) { exit 1 }",
        ])
        .env("WINDOWS_CERTIFICATE", certificate)
        .env("WINDOWS_CERTIFICATE_PASSWORD", password)
        .status()
        .map_err(|_| "Windows release builds require a usable certificate with a private key.".to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "Windows release builds require a usable certificate with a private key.".to_string())
}

#[cfg(not(windows))]
fn validate_windows_certificate(_certificate: &str, _password: &str) -> Result<(), String> {
    Err("Windows signing credentials can only be validated on Windows.".to_string())
}

#[cfg(windows)]
fn validate_windows_thumbprint(thumbprint: &str) -> Result<(), String> {
    let thumbprint = normalized_windows_thumbprint(thumbprint).ok_or_else(|| {
        "WINDOWS_CERTIFICATE_THUMBPRINT must identify a usable Windows signing certificate."
            .to_string()
    })?;
    let command = format!(
        "$ErrorActionPreference = 'Stop'; $certificate = Get-Item -LiteralPath 'Cert:\\CurrentUser\\My\\{thumbprint}'; if (-not $certificate.HasPrivateKey) {{ exit 1 }}"
    );
    let status = std::process::Command::new("powershell.exe")
        .args(["-NoProfile", "-NonInteractive", "-Command", &command])
        .status()
        .map_err(|_| "WINDOWS_CERTIFICATE_THUMBPRINT must identify a usable Windows signing certificate.".to_string())?;
    status
        .success()
        .then_some(())
        .ok_or_else(|| "WINDOWS_CERTIFICATE_THUMBPRINT must identify a usable Windows signing certificate.".to_string())
}

#[cfg(not(windows))]
fn validate_windows_thumbprint(thumbprint: &str) -> Result<(), String> {
    let _ = normalized_windows_thumbprint(thumbprint);
    Err("Windows signing credentials can only be validated on Windows.".to_string())
}
