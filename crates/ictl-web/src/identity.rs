pub fn canonical_uid(value: &str) -> Result<String, &'static str> {
    let value = value.trim_end_matches('\0');
    let hex = |s: &str| s.bytes().all(|b| b.is_ascii_hexdigit());
    match value.len() {
        40 if hex(value) => Ok(value.to_ascii_lowercase()),
        24 if hex(value) => Ok(format!("{}-{}", &value[..8], &value[8..]).to_ascii_uppercase()),
        25 if value.as_bytes()[8] == b'-' && hex(&value[..8]) && hex(&value[9..]) => Ok(value.to_ascii_uppercase()),
        _ => Err("Invalid device UID"),
    }
}

pub fn android_uid(value: &str) -> Result<String, &'static str> {
    let value = value.trim_end_matches('\0');
    let value = value.strip_prefix("android:").unwrap_or(value);
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().all(|b| b.is_ascii_alphanumeric() || b"_.:-".contains(&b))
    {
        return Err("Invalid Android device serial");
    }
    Ok(format!("android:{value}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identities_normalize_padding_and_preserve_android_case() {
        assert_eq!(canonical_uid("00008140001234567890abcd\0\0").unwrap(), "00008140-001234567890ABCD");
        assert_eq!(android_uid("ABc_01\0").unwrap(), "android:ABc_01");
        assert!(canonical_uid("☃☃☃☃☃☃☃☃☃").is_err());
        assert!(android_uid("../secret").is_err());
    }
}
