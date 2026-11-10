use serde::{Deserialize, Serialize};
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Point {
    pub x: f64,
    pub y: f64,
}
#[derive(Clone, Copy, Deserialize)]
pub struct Rect {
    pub left: f64,
    pub top: f64,
    pub width: f64,
    pub height: f64,
}
#[derive(Deserialize)]
pub struct Pointer {
    pub point: Option<Point>,
    pub x: f64,
    pub y: f64,
    pub time: f64,
}
pub fn to_phone_point(x: f64, y: f64, rect: Rect, width: f64, height: f64) -> Option<Point> {
    if !(width > 0.0 && height > 0.0 && rect.width > 0.0 && rect.height > 0.0) {
        return None;
    }
    let scale = (rect.width / width).min(rect.height / height);
    let x = (x - rect.left - (rect.width - width * scale) / 2.0) / scale;
    let y = (y - rect.top - (rect.height - height * scale) / 2.0) / scale;
    if x < 0.0 || y < 0.0 || x > width || y > height {
        return None;
    }
    Some(Point { x: (x * 10.0).round() / 10.0, y: (y * 10.0).round() / 10.0 })
}
pub fn pointer_command(start: Pointer, end: Pointer) -> Option<serde_json::Value> {
    let from = start.point?;
    let to = end.point?;
    let seconds = ((end.time - start.time) / 1000.0).clamp(0.1, 10.0);
    Some(if (end.x - start.x).hypot(end.y - start.y) < 8.0 {
        if seconds < 0.5 {
            serde_json::json!({"tool":"iphone_tap","args":from})
        } else {
            serde_json::json!({"tool":"iphone_long_press","args":{"x":from.x,"y":from.y,"seconds":seconds}})
        }
    } else {
        serde_json::json!({"tool":"iphone_swipe","args":{"from_x":from.x,"from_y":from.y,"to_x":to.x,"to_y":to.y,"seconds":seconds}})
    })
}
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name=toPhonePoint)]
pub fn to_phone_point_js(
    x: f64,
    y: f64,
    rect: wasm_bindgen::JsValue,
    width: f64,
    height: f64,
) -> wasm_bindgen::JsValue {
    serde_wasm_bindgen::from_value(rect)
        .ok()
        .and_then(|rect| to_phone_point(x, y, rect, width, height))
        .map(|p| crate::js::to_value(&p))
        .unwrap_or(wasm_bindgen::JsValue::NULL)
}
#[cfg(target_arch = "wasm32")]
#[wasm_bindgen::prelude::wasm_bindgen(js_name=pointerCommand)]
pub fn pointer_command_js(start: wasm_bindgen::JsValue, end: wasm_bindgen::JsValue) -> wasm_bindgen::JsValue {
    serde_wasm_bindgen::from_value(start)
        .ok()
        .zip(serde_wasm_bindgen::from_value(end).ok())
        .and_then(|(s, e)| pointer_command(s, e))
        .map(|v| crate::js::to_value(&v))
        .unwrap_or(wasm_bindgen::JsValue::NULL)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn letterbox_is_not_a_tap_target() {
        assert_eq!(
            to_phone_point(25.0, 110.0, Rect { left: 20.0, top: 10.0, width: 200.0, height: 200.0 }, 100.0, 200.0),
            None
        );
        assert_eq!(
            to_phone_point(120.0, 110.0, Rect { left: 20.0, top: 10.0, width: 200.0, height: 200.0 }, 100.0, 200.0),
            Some(Point { x: 50.0, y: 100.0 })
        );
    }
}
