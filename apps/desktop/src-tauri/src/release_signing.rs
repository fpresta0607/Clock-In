pub fn validate_build_signing(
    release: bool,
    target_os: &str,
    updater_artifacts_requested: bool,
    get: impl Fn(&str) -> Option<String>,
) -> Result<(), String> {
    if !release {
        return (!updater_artifacts_requested)
            .then_some(())
            .ok_or_else(|| {
                "A local unsigned build cannot create production updater artifacts.".to_string()
            });
    }

    if !valid_updater_key(get("TAURI_SIGNING_PRIVATE_KEY")) {
        return Err("TAURI_SIGNING_PRIVATE_KEY must contain a Minisign private key.".to_string());
    }

    match target_os {
        "windows" => validate_windows_signing(get),
        "macos" => validate_macos_signing(get),
        _ => Ok(()),
    }
}

fn valid_updater_key(value: Option<String>) -> bool {
    let Some(value) = value else {
        return false;
    };
    let mut lines = value.lines();
    let Some(header) = lines.next() else {
        return false;
    };
    let Some(material) = lines.next() else {
        return false;
    };
    header.trim() == "untrusted comment: minisign secret key"
        && material.len() >= 32
        && material
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'='))
}

fn validate_windows_signing(get: impl Fn(&str) -> Option<String>) -> Result<(), String> {
    let certificate = required(get("WINDOWS_CERTIFICATE"));
    let thumbprint = required(get("WINDOWS_CERTIFICATE_THUMBPRINT"));
    if certificate.is_some() {
        return required(get("WINDOWS_CERTIFICATE_PASSWORD"))
            .map(|_| ())
            .ok_or_else(|| "WINDOWS_CERTIFICATE_PASSWORD is required with WINDOWS_CERTIFICATE.".to_string());
    }
    if thumbprint.is_some_and(|thumbprint| valid_windows_thumbprint(&thumbprint)) {
        return Ok(());
    }
    Err("Windows release builds require WINDOWS_CERTIFICATE plus WINDOWS_CERTIFICATE_PASSWORD or a valid WINDOWS_CERTIFICATE_THUMBPRINT.".to_string())
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

fn valid_windows_thumbprint(value: &str) -> bool {
    let compact = value
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect::<String>();
    (compact.len() == 40 || compact.len() == 64)
        && compact.bytes().all(|byte| byte.is_ascii_hexdigit())
}
