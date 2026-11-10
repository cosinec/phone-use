use crate::error::{ApiError, Result};
use ictl_protocol::Request;
use serde_json::{Map, Value, json};

struct Args<'a> {
    values: &'a Map<String, Value>,
    used: Vec<&'a str>,
}
impl<'a> Args<'a> {
    fn value(&mut self, key: &'a str) -> Option<&Value> {
        self.used.push(key);
        self.values.get(key).filter(|v| !v.is_null())
    }
    fn number(&mut self, key: &'a str, default: Option<f64>, max: f64) -> Result<f64> {
        let value = match self.value(key) {
            Some(value) => value.as_f64(),
            None => default,
        };
        value
            .filter(|n| n.is_finite() && *n >= 0.0 && *n <= max)
            .ok_or_else(|| ApiError::new(400, format!("Invalid {key}")))
    }
    fn integer(&mut self, key: &'a str, default: u64, max: u64) -> Result<u64> {
        let n = self.number(key, Some(default as f64), max as f64)?;
        if n.fract() != 0.0 {
            return Err(ApiError::new(400, format!("Invalid {key}")));
        }
        Ok(n as u64)
    }
    fn string(&mut self, key: &'a str, default: Option<&str>, max: usize) -> Result<String> {
        let value = match self.value(key) {
            Some(value) => value.as_str(),
            None => default,
        };
        value
            .filter(|s| s.chars().count() <= max && !s.contains('\0'))
            .map(str::to_owned)
            .ok_or_else(|| ApiError::new(400, format!("Invalid {key}")))
    }
    fn boolean(&mut self, key: &'a str) -> Result<bool> {
        match self.value(key) {
            Some(value) => value.as_bool().ok_or_else(|| ApiError::new(400, format!("Invalid {key}"))),
            None => Ok(false),
        }
    }
}

pub fn command_request(tool: &str, args: &Value) -> Result<Value> {
    let values = args.as_object().ok_or_else(|| ApiError::new(400, "Invalid command args"))?;
    let mut a = Args { values, used: Vec::new() };
    let request = match tool {
        "iphone_status" => json!({"op":"status"}),
        "iphone_screenshot" => {
            let keys = ["x", "y", "width", "height"];
            let region = if keys.iter().any(|k| values.contains_key(*k)) {
                let mut out = Vec::new();
                for k in keys {
                    out.push(a.number(k, None, 100_000.0)?);
                }
                if out[2] == 0.0 || out[3] == 0.0 {
                    return Err(ApiError::new(400, "Invalid screenshot dimensions"));
                }
                json!(out)
            } else {
                a.used.extend(keys);
                Value::Null
            };
            json!({"op":"screenshot","region":region})
        }
        "iphone_list_elements" => {
            json!({"op":"list_elements","filter":a.string("filter",Some(""),10000)?,"limit":a.integer("limit",150,1000)?,"max_age_ms":0})
        }
        "iphone_tap" => json!({"op":"tap","x":a.number("x",None,100000.0)?,"y":a.number("y",None,100000.0)?}),
        "iphone_tap_element" => {
            json!({"op":"tap_element","text":a.string("text",None,10000)?,"index":a.integer("index",0,10000)?,"max_age_ms":0})
        }
        "iphone_long_press" => {
            json!({"op":"long_press","x":a.number("x",None,100000.0)?,"y":a.number("y",None,100000.0)?,"seconds":a.number("seconds",Some(1.0),10.0)?})
        }
        "iphone_swipe" => {
            json!({"op":"swipe","from":[a.number("from_x",None,100000.0)?,a.number("from_y",None,100000.0)?],"to":[a.number("to_x",None,100000.0)?,a.number("to_y",None,100000.0)?],"seconds":a.number("seconds",Some(0.3),10.0)?})
        }
        "iphone_type_text" => {
            json!({"op":"type_text","text":a.string("text",None,10000)?,"submit":a.boolean("submit")?})
        }
        "iphone_press_button" => {
            let button = a.string("button", None, 10000)?;
            if !["home", "back", "volume_up", "volume_down", "lock"].contains(&button.as_str()) {
                return Err(ApiError::new(400, "Invalid button"));
            }
            json!({"op":"press_button","button":button})
        }
        "iphone_list_apps" => json!({"op":"list_apps","include_system":a.boolean("include_system")?}),
        "iphone_launch_app" | "iphone_terminate_app" => {
            let app = a.string("app", None, 512)?;
            if app.trim().is_empty() {
                return Err(ApiError::new(400, "Invalid app"));
            }
            json!({"op":if tool=="iphone_launch_app" {"launch_app"} else {"terminate_app"},"app":app})
        }
        "iphone_open_url" => {
            let url = a.string("url", None, 4096)?;
            let parsed = reqwest::Url::parse(&url).map_err(|_| ApiError::new(400, "Invalid URL"))?;
            if !["http", "https", "tel", "sms", "mailto"].contains(&parsed.scheme()) {
                return Err(ApiError::new(400, "Unsupported URL scheme"));
            }
            json!({"op":"open_url","url":url})
        }
        "iphone_wait_for" => {
            json!({"op":"wait_for","text":a.string("text",None,10000)?,"timeout_ms":(a.number("timeout",Some(5.0),30.0)?*1000.0).floor() as u64})
        }
        "iphone_list_devices" => json!({"op":"list_devices"}),
        _ => return Err(ApiError::new(400, format!("Unknown or unsupported tool {tool}"))),
    };
    if values.keys().any(|k| !a.used.contains(&k.as_str())) {
        return Err(ApiError::new(400, "Unknown command argument"));
    }
    // Share the existing native protocol representation and its field types.
    let typed: Request = serde_json::from_value(request).map_err(|_| ApiError::new(400, "Invalid command args"))?;
    serde_json::to_value(typed).map_err(|_| ApiError::new(400, "Invalid command args"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_protocol_and_limits() {
        assert_eq!(command_request("iphone_tap", &json!({"x":2,"y":3})).unwrap()["op"], "tap");
        for v in [json!({"x":-1,"y":3}), json!({"x":2,"y":3,"extra":true}), json!({"x":"2","y":3})] {
            assert!(command_request("iphone_tap", &v).is_err());
        }
        assert!(command_request("iphone_screenshot", &json!({"x":1})).is_err());
        assert!(command_request("iphone_open_url", &json!({"url":"file:///etc/passwd"})).is_err());
    }
}
