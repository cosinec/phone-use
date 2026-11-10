use js_sys::{Array, Function, Object, Promise, Reflect};
use serde::Serialize;
use wasm_bindgen::{JsCast, JsValue, closure::Closure};
use wasm_bindgen_futures::JsFuture;
pub fn get(value: &JsValue, key: &str) -> JsValue {
    Reflect::get(value, &JsValue::from_str(key)).unwrap_or(JsValue::UNDEFINED)
}
pub fn set(value: &JsValue, key: &str, item: &JsValue) {
    let _ = Reflect::set(value, &JsValue::from_str(key), item);
}
pub fn text(value: &JsValue, key: &str) -> String {
    get(value, key).as_string().unwrap_or_default()
}
pub fn number(value: &JsValue, key: &str) -> f64 {
    get(value, key).as_f64().unwrap_or(0.0)
}
pub fn truth(value: &JsValue) -> bool {
    !value.is_null()
        && !value.is_undefined()
        && value.as_bool() != Some(false)
        && !value.as_f64().is_some_and(|n| n == 0.0 || n.is_nan())
        && !value.as_string().is_some_and(|s| s.is_empty())
}
pub fn error(message: impl AsRef<str>) -> JsValue {
    js_sys::Error::new(message.as_ref()).into()
}
pub fn message(value: &JsValue) -> String {
    let m = text(value, "message");
    if m.is_empty() { "请求失败".into() } else { m }
}
pub fn object() -> JsValue {
    Object::new().into()
}
pub fn obj(items: &[(&str, JsValue)]) -> JsValue {
    let o = object();
    for (k, v) in items {
        set(&o, k, v);
    }
    o
}
pub fn to_value(value: &impl Serialize) -> JsValue {
    value.serialize(&serde_wasm_bindgen::Serializer::json_compatible()).unwrap_or(JsValue::NULL)
}
pub fn json(value: serde_json::Value) -> JsValue {
    to_value(&value)
}
pub fn copy(value: &JsValue) -> JsValue {
    Object::assign(&Object::new(), &Object::from(value.clone())).into()
}
pub fn call(value: &JsValue, key: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
    apply(&get(value, key), value, args)
}
pub fn apply(function: &JsValue, this: &JsValue, args: &[JsValue]) -> Result<JsValue, JsValue> {
    let f = function.dyn_ref::<Function>().ok_or_else(|| error("Missing browser bridge function"))?;
    f.apply(this, &args.iter().cloned().collect::<Array>())
}
pub async fn resolved(value: JsValue) -> Result<JsValue, JsValue> {
    JsFuture::from(Promise::resolve(&value)).await
}
pub async fn invoke(value: &JsValue, key: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
    resolved(call(value, key, args)?).await
}
pub fn callback(mut f: impl FnMut(JsValue) -> JsValue + 'static) -> JsValue {
    Closure::wrap(Box::new(move |v: JsValue| f(v)) as Box<dyn FnMut(JsValue) -> JsValue>).into_js_value()
}
pub fn callback2(mut f: impl FnMut(JsValue, JsValue) -> JsValue + 'static) -> JsValue {
    Closure::wrap(Box::new(move |a: JsValue, b: JsValue| f(a, b)) as Box<dyn FnMut(JsValue, JsValue) -> JsValue>)
        .into_js_value()
}
pub fn global() -> JsValue {
    js_sys::global().into()
}
pub fn global_call(key: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
    call(&global(), key, args)
}
pub fn ctor(key: &str, args: &[JsValue]) -> Result<JsValue, JsValue> {
    Reflect::construct(&get(&global(), key).unchecked_into::<Function>(), &args.iter().cloned().collect::<Array>())
}
pub fn abort_check(signal: &JsValue) -> Result<(), JsValue> {
    if truth(&get(signal, "aborted")) { Err(get(signal, "reason")) } else { Ok(()) }
}
pub fn now() -> f64 {
    call(&get(&global(), "performance"), "now", &[]).ok().and_then(|v| v.as_f64()).unwrap_or(0.0)
}
pub fn uuid() -> String {
    call(&get(&global(), "crypto"), "randomUUID", &[]).ok().and_then(|v| v.as_string()).unwrap_or_default()
}
pub fn clear_timer(timer: &JsValue) {
    let _ = global_call("clearTimeout", std::slice::from_ref(timer));
}
pub fn timeout(ms: f64) -> Promise {
    Promise::new(&mut |resolve, _| {
        let _ = global_call("setTimeout", &[resolve.into(), ms.into()]);
    })
}
