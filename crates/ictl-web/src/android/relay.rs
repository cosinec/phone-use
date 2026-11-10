use crate::js::*;
use js_sys::{Array, Promise, Uint8Array};
use std::{cell::RefCell, collections::HashMap, rc::Rc};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;
const MAX: usize = 1024 * 1024;
#[wasm_bindgen(js_name=encodeFrame)]
pub fn encode_frame(kind: f64, id: Option<f64>, value: JsValue) -> Result<Uint8Array, JsValue> {
    let id = id.unwrap_or(0.0);
    if kind.fract() != 0.0
        || !(0.0..=255.0).contains(&kind)
        || id.fract() != 0.0
        || !(0.0..=u32::MAX as f64).contains(&id)
    {
        return Err(error("Invalid relay header"));
    }
    let value = if value.is_undefined() { JsValue::NULL } else { value };
    let payload = js_sys::JSON::stringify(&value)?.as_string().unwrap_or_default().into_bytes();
    if payload.len() > MAX {
        return Err(error("Android relay payload too large"));
    }
    let mut bytes = vec![0; 16];
    bytes[0] = 1;
    bytes[1] = kind as u8;
    bytes[4..8].copy_from_slice(&(id as u32).to_be_bytes());
    bytes[12..16].copy_from_slice(&(payload.len() as u32).to_be_bytes());
    bytes.extend(payload);
    Ok(Uint8Array::from(bytes.as_slice()))
}
#[wasm_bindgen(js_name=decodeFrame)]
pub fn decode_frame(data: JsValue) -> Result<JsValue, JsValue> {
    let bytes = Uint8Array::new(&data).to_vec();
    if bytes.len() < 16 {
        return Err(error("Short relay frame"));
    }
    let length = u32::from_be_bytes(bytes[12..16].try_into().unwrap()) as usize;
    if bytes[0] != 1
        || bytes[2] != 0
        || bytes[3] != 0
        || bytes[8..12] != [0, 0, 0, 0]
        || length > MAX
        || bytes.len() != 16 + length
    {
        return Err(error("Invalid Android relay frame"));
    }
    let payload = std::str::from_utf8(&bytes[16..]).map_err(|_| error("Invalid Android relay UTF-8"))?;
    Ok(obj(&[
        ("type", (bytes[1] as u32).into()),
        ("requestId", u32::from_be_bytes(bytes[4..8].try_into().unwrap()).into()),
        ("value", js_sys::JSON::parse(payload)?),
    ]))
}
struct RelayState {
    socket: JsValue,
    device_id: String,
    execute: JsValue,
    options: JsValue,
    pending: HashMap<u32, JsValue>,
    last_id: u32,
    closed: bool,
    chain: Promise,
    ready: Promise,
    resolve: JsValue,
    reject: JsValue,
    timer: JsValue,
}
#[wasm_bindgen]
#[derive(Clone)]
pub struct AndroidRelay {
    inner: Rc<RefCell<RelayState>>,
}
#[wasm_bindgen]
impl AndroidRelay {
    #[wasm_bindgen(constructor)]
    pub fn new(socket: JsValue, device_id: String, execute: JsValue, options: JsValue) -> Self {
        let mut resolve_value = JsValue::UNDEFINED;
        let mut reject_value = JsValue::UNDEFINED;
        let ready = Promise::new(&mut |resolve, reject| {
            resolve_value = resolve.into();
            reject_value = reject.into();
        });
        let relay = Self {
            inner: Rc::new(RefCell::new(RelayState {
                socket: socket.clone(),
                device_id,
                execute,
                options,
                pending: HashMap::new(),
                last_id: 0,
                closed: false,
                chain: Promise::resolve(&JsValue::UNDEFINED),
                ready,
                resolve: resolve_value,
                reject: reject_value,
                timer: JsValue::UNDEFINED,
            })),
        };
        let weak = Rc::downgrade(&relay.inner);
        let timer = callback(move |_| {
            if let Some(inner) = weak.upgrade() {
                AndroidRelay { inner }.fail(error("Android relay handshake timed out"));
            }
            JsValue::UNDEFINED
        });
        relay.inner.borrow_mut().timer = global_call("setTimeout", &[timer, 10000.into()]).unwrap_or_default();
        set(&socket, "binaryType", &"arraybuffer".into());
        let weak = Rc::downgrade(&relay.inner);
        let on_message = callback(move |event| {
            if let Some(inner) = weak.upgrade() {
                let relay = AndroidRelay { inner };
                let result = decode_frame(get(&event, "data")).and_then(|frame| relay.receive(frame));
                if let Err(e) = result {
                    relay.fail(e);
                }
            }
            JsValue::UNDEFINED
        });
        let _ = call(&socket, "addEventListener", &["message".into(), on_message]);
        let weak = Rc::downgrade(&relay.inner);
        let on_error = callback(move |_| {
            if let Some(inner) = weak.upgrade() {
                AndroidRelay { inner }.fail(error("Android relay unavailable"));
            }
            JsValue::UNDEFINED
        });
        let _ = call(&socket, "addEventListener", &["error".into(), on_error]);
        let weak = Rc::downgrade(&relay.inner);
        let on_close = callback(move |_| {
            if let Some(inner) = weak.upgrade() {
                let relay = AndroidRelay { inner };
                relay.close();
                let options = relay.inner.borrow().options.clone();
                let _ = apply(&get(&options, "log"), &JsValue::UNDEFINED, &["Relay socket closed".into()]);
                let _ = apply(&get(&options, "onClose"), &JsValue::UNDEFINED, &[]);
            }
            JsValue::UNDEFINED
        });
        let _ = call(&socket, "addEventListener", &["close".into(), on_close]);
        relay
    }
    #[wasm_bindgen(getter)]
    pub fn ready(&self) -> Promise {
        self.inner.borrow().ready.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn chain(&self) -> Promise {
        self.inner.borrow().chain.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn closed(&self) -> bool {
        self.inner.borrow().closed
    }
    pub fn fail(&self, value: JsValue) {
        let reject = self.inner.borrow().reject.clone();
        let _ = apply(&reject, &JsValue::UNDEFINED, &[value]);
        self.close();
    }
    pub fn receive(&self, frame: JsValue) -> Result<(), JsValue> {
        if self.closed() {
            return Ok(());
        }
        let kind = number(&frame, "type") as u32;
        let id = number(&frame, "requestId") as u32;
        let value = get(&frame, "value");
        let device_id = self.inner.borrow().device_id.clone();
        if kind == 17
            && id == 0
            && get(&value, "ready").as_bool() == Some(true)
            && text(&value, "deviceId") == device_id
        {
            let (timer, resolve) = {
                let i = self.inner.borrow();
                (i.timer.clone(), i.resolve.clone())
            };
            clear_timer(&timer);
            let _ = apply(&resolve, &JsValue::UNDEFINED, &[]);
            return Ok(());
        }
        if kind == 7 {
            return Err(error("Android relay rejected the connection"));
        }
        if kind == 16 {
            let abort = self.inner.borrow().pending.get(&id).cloned();
            if let Some(abort) = abort {
                let _ = call(&abort, "abort", &[]);
            }
            return Ok(());
        }
        {
            let i = self.inner.borrow();
            if kind != 14
                || id <= i.last_id
                || text(&value, "deviceId") != device_id
                || !truth(&get(&value, "request"))
                || i.pending.len() >= 64
            {
                return Err(error("Invalid Android command"));
            }
        }
        let abort = ctor("AbortController", &[])?;
        {
            let mut i = self.inner.borrow_mut();
            i.last_id = id;
            i.pending.insert(id, abort.clone());
        }
        let this = self.clone();
        let request = get(&value, "request");
        let handler = callback(move |_| {
            let this = this.clone();
            let abort = abort.clone();
            let request = request.clone();
            future_to_promise(async move {
                this.execute_one(id, request, abort).await;
                Ok(JsValue::UNDEFINED)
            })
            .into()
        });
        let previous = self.chain();
        let next = call(&previous, "then", &[handler])?;
        self.inner.borrow_mut().chain = next.unchecked_into();
        Ok(())
    }
    pub fn close(&self) {
        let (timer, reject, pending, socket) = {
            let mut i = self.inner.borrow_mut();
            if i.closed {
                return;
            }
            i.closed = true;
            (i.timer.clone(), i.reject.clone(), std::mem::take(&mut i.pending), i.socket.clone())
        };
        clear_timer(&timer);
        let _ = apply(&reject, &JsValue::UNDEFINED, &[error("Android relay closed")]);
        for abort in pending.values() {
            let _ = call(abort, "abort", &[]);
        }
        let _ = call(&socket, "close", &[]);
    }
}
impl AndroidRelay {
    async fn execute_one(&self, id: u32, request: JsValue, abort: JsValue) {
        let signal = get(&abort, "signal");
        let timed_out = Rc::new(RefCell::new(false));
        let timer_slot = Rc::new(RefCell::new(JsValue::UNDEFINED));
        let stop_slot = Rc::new(RefCell::new(JsValue::UNDEFINED));
        let mut result = abort_check(&signal).map(|_| JsValue::UNDEFINED);
        if result.is_ok() {
            let timer_ref = timer_slot.clone();
            let stop_ref = stop_slot.clone();
            let abort_clone = abort.clone();
            let signal_clone = signal.clone();
            let timeout_flag = timed_out.clone();
            let cancelled = Promise::new(&mut |_, reject| {
                let reject: JsValue = reject.into();
                let timer_ref = timer_ref.clone();
                let stop = callback(move |_| {
                    clear_timer(&timer_ref.borrow());
                    let _ = apply(
                        &reject,
                        &JsValue::UNDEFINED,
                        &[error("Android operation cancelled; sent actions are not retried")],
                    );
                    JsValue::UNDEFINED
                });
                let _ = call(
                    &signal_clone,
                    "addEventListener",
                    &["abort".into(), stop.clone(), json(serde_json::json!({"once":true}))],
                );
                *stop_ref.borrow_mut() = stop;
                let abort = abort_clone.clone();
                let timeout_flag = timeout_flag.clone();
                let timeout_callback = callback(move |_| {
                    *timeout_flag.borrow_mut() = true;
                    let _ = call(&abort, "abort", &[]);
                    JsValue::UNDEFINED
                });
                *timer_slot.borrow_mut() =
                    global_call("setTimeout", &[timeout_callback, 40000.into()]).unwrap_or_default();
            });
            let execute = self.inner.borrow().execute.clone();
            let operation = apply(&execute, &JsValue::UNDEFINED, &[request, signal.clone()])
                .unwrap_or_else(|e| Promise::reject(&e).into());
            result = resolved(Promise::race(&Array::of2(&operation, &cancelled)).into()).await;
            clear_timer(&timer_slot.borrow());
            let _ = call(&signal, "removeEventListener", &["abort".into(), stop_slot.borrow().clone()]);
            if result.is_ok() {
                result = abort_check(&signal).map(|_| result.unwrap());
            }
        }
        self.inner.borrow_mut().pending.remove(&id);
        if self.closed() || (truth(&get(&signal, "aborted")) && !*timed_out.borrow()) {
            return;
        }
        let result = result.unwrap_or_else(|e| {
            obj(&[("kind", "error".into()), ("message", message(&e).chars().take(1600).collect::<String>().into())])
        });
        let (device_id, socket) = {
            let i = self.inner.borrow();
            (i.device_id.clone(), i.socket.clone())
        };
        let frame = encode_frame(15.0, Some(id as f64), obj(&[("deviceId", device_id.into()), ("result", result)]));
        match frame {
            Ok(frame) => {
                if let Err(e) = call(&socket, "send", &[frame.into()]) {
                    self.fail(e);
                }
            }
            Err(e) => self.fail(e),
        }
    }
}
