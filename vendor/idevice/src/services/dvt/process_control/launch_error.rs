//! Local diagnostic patch: decode only NSError fields needed for launch failures.
//! Never dump the archive, arbitrary userInfo, launch arguments or environment.
use plist::{Dictionary, Value};

pub(super) struct LaunchError {
    pub domain: String,
    pub code: i64,
    description: Option<String>,
    failure: Option<String>,
    underlying: Option<Box<LaunchError>>,
}
impl LaunchError {
    pub fn depth(&self) -> usize {
        1 + self.underlying.as_ref().map_or(0, |error| error.depth())
    }
    pub fn message(&self) -> String {
        let mut text = format!("{} (code {})", self.domain, self.code);
        if let Some(description) = &self.description {
            text.push_str(": ");
            text.push_str(description);
        }
        if let Some(failure) = &self.failure {
            text.push_str("; ");
            text.push_str(failure);
        }
        if let Some(error) = &self.underlying {
            text.push_str("; caused by ");
            text.push_str(&error.message());
        }
        text.chars().take(2048).collect()
    }
}
struct Archive<'a>(&'a [Value]);
impl<'a> Archive<'a> {
    fn resolve(&self, mut value: &'a Value) -> Option<&'a Value> {
        for _ in 0..16 {
            match value {
                Value::Uid(uid) => value = self.0.get(usize::try_from(uid.get()).ok()?)?,
                _ => return Some(value),
            }
        }
        None
    }
    fn field(&self, dict: &'a Dictionary, key: &str) -> Option<&'a Value> {
        self.resolve(dict.get(key)?)
    }
    fn items(&self, value: &'a Value) -> Option<&'a [Value]> {
        match self.resolve(value)? {
            Value::Array(items) => Some(items),
            Value::Dictionary(dict) => self.field(dict, "NS.objects")?.as_array().map(Vec::as_slice),
            _ => None,
        }
    }
    fn user_field(&self, value: &'a Value, key: &str) -> Option<&'a Value> {
        match self.resolve(value)? {
            Value::Dictionary(dict) => {
                if let Some(value) = self.field(dict, key) {
                    return Some(value);
                }
                let keys = self.items(dict.get("NS.keys")?)?;
                let values = self.items(dict.get("NS.objects")?)?;
                for (k, v) in keys.iter().zip(values).take(64) {
                    if self.resolve(k)?.as_string() == Some(key) {
                        return self.resolve(v);
                    }
                }
                None
            }
            Value::Array(items) => {
                for item in items.iter().take(64) {
                    let Some(dict) = self.resolve(item).and_then(Value::as_dictionary) else { continue };
                    if self.field(dict, "key").and_then(Value::as_string) == Some(key) {
                        return self.field(dict, "value");
                    }
                }
                None
            }
            _ => None,
        }
    }
    fn error(&self, value: &'a Value, path: &mut Vec<*const Value>) -> Option<LaunchError> {
        let value = self.resolve(value)?;
        let pointer = value as *const Value;
        if path.len() >= 8 || path.contains(&pointer) {
            return None;
        }
        let dict = value.as_dictionary()?;
        let domain = self.field(dict, "NSDomain")?.as_string()?;
        if domain.is_empty()
            || domain.len() > 128
            || !domain.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
        {
            return None;
        }
        let code = self.field(dict, "NSCode")?.as_signed_integer()?;
        let info = dict.get("NSUserInfo");
        let selected = |key| info.and_then(|v| self.user_field(v, key)).or_else(|| self.field(dict, key));
        let text = |key| {
            selected(key)
                .and_then(Value::as_string)
                .map(|s| s.chars().filter(|c| !c.is_control()).take(512).collect::<String>())
        };
        let description = text("NSLocalizedDescription").or_else(|| text("NSDebugDescription"));
        let failure = text("NSLocalizedFailureReason")
            .or_else(|| text("BSErrorCodeDescription"))
            .or_else(|| text("NSLocalizedRecoverySuggestion"));
        path.push(pointer);
        let underlying = selected("NSUnderlyingError").and_then(|v| self.error(v, path)).map(Box::new);
        path.pop();
        Some(LaunchError { domain: domain.to_owned(), code, description, failure, underlying })
    }
}
pub(super) fn decode(raw: &[u8]) -> Option<LaunchError> {
    if raw.len() > 256 * 1024 {
        return None;
    }
    let archive = Value::from_reader(std::io::Cursor::new(raw)).ok()?;
    let dict = archive.as_dictionary()?;
    let objects = dict.get("$objects")?.as_array()?;
    if objects.len() > 4096 {
        return None;
    }
    let root = dict.get("$top")?.as_dictionary()?.get("root")?;
    Archive(objects).error(root, &mut Vec::new())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn dict(fields: &[(&str, Value)]) -> Value {
        Value::Dictionary(fields.iter().map(|(k, v)| (k.to_string(), v.clone())).collect())
    }
    fn uid(n: u64) -> Value {
        Value::Uid(plist::Uid::new(n))
    }
    fn fixture() -> Vec<Value> {
        vec![
            "$null".into(),
            dict(&[("NSCode", 2.into()), ("NSDomain", uid(2)), ("NSUserInfo", uid(3)), ("$class", uid(14))]),
            "LaunchServiceDomain".into(),
            dict(&[
                ("NS.keys", Value::Array(vec![uid(4), uid(5), uid(6)])),
                ("NS.objects", Value::Array(vec![uid(7), uid(8), uid(9)])),
            ]),
            "NSLocalizedDescription".into(),
            "NSUnderlyingError".into(),
            "PRIVATE_OTHER_KEY".into(),
            "Launch rejected".into(),
            dict(&[("NSCode", (-42).into()), ("NSDomain", uid(10)), ("NSUserInfo", uid(11))]),
            "PRIVATE_TOKEN_AND_ENVIRONMENT".into(),
            "SignatureDomain".into(),
            dict(&[("NSLocalizedFailureReason", "Invalid signature".into())]),
            "$null".into(),
            "$null".into(),
            dict(&[("$classname", "NSError".into())]),
        ]
    }
    fn encode(objects: Vec<Value>, root: Value) -> Vec<u8> {
        let archive = dict(&[
            ("$objects", Value::Array(objects)),
            ("$top", dict(&[("root", root)])),
            ("$archiver", "NSKeyedArchiver".into()),
            ("$version", 100000.into()),
        ]);
        let mut raw = Vec::new();
        archive.to_writer_binary(&mut raw).unwrap();
        raw
    }
    #[test]
    fn launch_archive_preserves_root_and_underlying_errors_without_other_user_info() {
        let raw = encode(fixture(), uid(1));
        // Reproduce the lossy generic decoder result seen in the real VPS log.
        let generic = ns_keyed_archive::decode::from_bytes(&raw).unwrap();
        assert!(matches!(generic.as_dictionary().unwrap().get("NSDomain"), Some(Value::Uid(_))));
        let launch_error = super::super::parse_launch_pid(&generic, Some(&raw)).unwrap_err().to_string();
        assert!(
            launch_error.contains("LaunchServiceDomain (code 2)")
                && launch_error.contains("SignatureDomain (code -42)")
        );
        let error = decode(&raw).unwrap();
        assert_eq!((error.domain.as_str(), error.code, error.depth()), ("LaunchServiceDomain", 2, 2));
        let message = error.message();
        assert!(
            message.contains("Launch rejected")
                && message.contains("SignatureDomain (code -42)")
                && message.contains("Invalid signature")
        );
        assert!(!message.contains("PRIVATE"));
    }
    #[test]
    fn launch_archive_handles_cycles_bad_references_and_payload_bounds() {
        assert!(decode(&encode(fixture(), uid(999))).is_none());
        assert!(decode(&vec![0; 256 * 1024 + 1]).is_none());
        assert!(decode(&[1, 2, 3]).is_none());
        let mut objects = fixture();
        objects[8] = uid(1);
        assert_eq!(decode(&encode(objects, uid(1))).unwrap().depth(), 1);
        let mut objects = fixture();
        objects[2] = uid(2);
        assert!(decode(&encode(objects, uid(1))).is_none());
    }
    #[test]
    fn launch_archive_bounds_text_and_does_not_treat_a_pid_as_an_error() {
        assert!(decode(&encode(vec![1234.into()], uid(0))).is_none());
        assert_eq!(super::super::parse_launch_pid(&1234.into(), Some(&[1, 2, 3])).unwrap(), 1234);
        assert_eq!(super::super::parse_launch_pid(&"1234".into(), None).unwrap(), 1234);
        let mut objects = fixture();
        objects[7] = format!("{}\nsecret", "x".repeat(5000)).into();
        let error = decode(&encode(objects, uid(1))).unwrap();
        assert_eq!(error.description.as_ref().unwrap().len(), 512);
        assert!(!error.message().contains('\n'));
    }

    #[test]
    fn launch_archive_keeps_system_error_description_and_legacy_user_info() {
        let mut objects = fixture();
        objects[11] =
            Value::Array(vec![dict(&[("key", "BSErrorCodeDescription".into()), ("value", "RequestDenied".into())])]);
        assert!(decode(&encode(objects, uid(1))).unwrap().message().contains("RequestDenied"));
    }
}
