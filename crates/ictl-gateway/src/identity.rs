use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Device {
    pub serial_number: String,
    pub vendor_id: u16,
    pub product_id: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub product_name: Option<String>,
}

pub fn canonical_uid(value: &str) -> Result<String> {
    let value = value.trim_end_matches('\0');
    let is_hex = |s: &str| s.bytes().all(|c| c.is_ascii_hexdigit());
    if value.len() == 40 && is_hex(value) {
        return Ok(value.to_ascii_lowercase());
    }
    if value.len() == 24 && is_hex(value) {
        return Ok(format!("{}-{}", &value[..8], &value[8..]).to_ascii_uppercase());
    }
    if value.len() == 25 && value.as_bytes()[8] == b'-' && is_hex(&value[..8]) && is_hex(&value[9..]) {
        return Ok(value.to_ascii_uppercase());
    }
    bail!("Invalid device UID")
}

pub fn validate_device(value: &Value) -> Result<Device> {
    let mut device: Device = serde_json::from_value(value.clone())?;
    if device.vendor_id != 1452
        || device.product_id == 0
        || device.product_name.as_ref().is_some_and(|name| name.encode_utf16().count() > 256)
    {
        bail!("Invalid Apple device identity");
    }
    device.serial_number = canonical_uid(&device.serial_number)?;
    if device.product_name.as_deref() == Some("") {
        device.product_name = None;
    }
    Ok(device)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn normalizes_raw_modern_and_legacy_serials() {
        assert_eq!(canonical_uid("00008110001234567890001e\0\0").unwrap(), "00008110-001234567890001E");
        assert_eq!(canonical_uid("00008110-001234567890001e").unwrap(), "00008110-001234567890001E");
        assert_eq!(canonical_uid(&"A".repeat(40)).unwrap(), "a".repeat(40));
        for invalid in ["", "../phone", "éééééééééééé", "0000811-0001234567890001E"] {
            assert!(canonical_uid(invalid).is_err());
        }
    }

    #[test]
    fn validates_unsigned_usb_identity() {
        let device = json!({"serialNumber":"00008110001234567890001e","vendorId":1452,"productId":4776});
        assert_eq!(validate_device(&device).unwrap().product_id, 4776);
        for patch in
            [json!({"vendorId": 1}), json!({"productId": 0}), json!({"productId": 65536}), json!({"productName": 7})]
        {
            let mut bad = device.clone();
            bad.as_object_mut().unwrap().extend(patch.as_object().unwrap().clone());
            assert!(validate_device(&bad).is_err());
        }
    }
}
