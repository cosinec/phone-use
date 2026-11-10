use crate::js::*;
use js_sys::Promise;
use std::{cell::RefCell, collections::HashMap, rc::Rc};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;
struct Mailbox {
    sequence: u32,
    epoch: u32,
    epoch_frames: u32,
    latest: JsValue,
    error: JsValue,
    waiters: HashMap<u64, JsValue>,
    next_id: u64,
}
#[wasm_bindgen]
#[derive(Clone)]
pub struct FrameMailbox {
    inner: Rc<RefCell<Mailbox>>,
}
#[wasm_bindgen]
impl FrameMailbox {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: Rc::new(RefCell::new(Mailbox {
                sequence: 0,
                epoch: 0,
                epoch_frames: 0,
                latest: JsValue::NULL,
                error: JsValue::NULL,
                waiters: HashMap::new(),
                next_id: 0,
            })),
        }
    }
    #[wasm_bindgen(getter)]
    pub fn sequence(&self) -> u32 {
        self.inner.borrow().sequence
    }
    #[wasm_bindgen(getter)]
    pub fn epoch(&self) -> u32 {
        self.inner.borrow().epoch
    }
    #[wasm_bindgen(getter,js_name=epochFrames)]
    pub fn epoch_frames(&self) -> u32 {
        self.inner.borrow().epoch_frames
    }
    #[wasm_bindgen(getter)]
    pub fn latest(&self) -> JsValue {
        self.inner.borrow().latest.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn error(&self) -> JsValue {
        self.inner.borrow().error.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn waiters(&self) -> JsValue {
        obj(&[("size", (self.inner.borrow().waiters.len() as u32).into())])
    }
    pub fn configure(&self) {
        let mut i = self.inner.borrow_mut();
        i.epoch += 1;
        i.epoch_frames = 0;
    }
    pub fn publish(&self, canvas: JsValue) {
        let waiters = {
            let mut i = self.inner.borrow_mut();
            if truth(&i.error) {
                return;
            }
            i.sequence += 1;
            i.epoch_frames += 1;
            i.latest = obj(&[
                ("canvas", canvas.clone()),
                ("width", get(&canvas, "width")),
                ("height", get(&canvas, "height")),
                ("sequence", i.sequence.into()),
                ("epoch", i.epoch.into()),
                ("epochFrames", i.epoch_frames.into()),
            ]);
            i.waiters.values().cloned().collect::<Vec<_>>()
        };
        for callback in waiters {
            let _ = apply(&callback, &JsValue::UNDEFINED, &[]);
        }
    }
    pub fn fail(&self, value: JsValue) {
        let waiters = {
            let mut i = self.inner.borrow_mut();
            if truth(&i.error) {
                return;
            }
            i.error =
                if get(&value, "message").is_string() { value } else { error("Android video stream unavailable") };
            i.latest = JsValue::NULL;
            i.waiters.values().cloned().collect::<Vec<_>>()
        };
        for callback in waiters {
            let _ = apply(&callback, &JsValue::UNDEFINED, &[]);
        }
    }
    pub fn wait(&self, options: JsValue) -> Promise {
        let after = get(&options, "after").as_f64().unwrap_or(self.sequence() as f64);
        let epoch = get(&options, "epoch").as_f64().unwrap_or(self.epoch() as f64);
        let min_frames = get(&options, "minFrames").as_f64().unwrap_or(1.0);
        let signal = get(&options, "signal");
        let ms = get(&options, "timeoutMs").as_f64().unwrap_or(1200.0);
        let weak = Rc::downgrade(&self.inner);
        let id = {
            let mut i = self.inner.borrow_mut();
            i.next_id += 1;
            i.next_id
        };
        let timer = Rc::new(RefCell::new(JsValue::UNDEFINED));
        let check_slot = Rc::new(RefCell::new(JsValue::UNDEFINED));
        let done = Rc::new(RefCell::new(false));
        Promise::new(&mut |resolve, reject| {
            let resolve: JsValue = resolve.into();
            let reject: JsValue = reject.into();
            let weak = weak.clone();
            let timer = timer.clone();
            let check_slot = check_slot.clone();
            let signal = signal.clone();
            let done = done.clone();
            let reject_timeout = reject.clone();
            let check = {
                let timer = timer.clone();
                let check_slot = check_slot.clone();
                let signal = signal.clone();
                let done = done.clone();
                callback(move |_| {
                    if *done.borrow() {
                        return JsValue::UNDEFINED;
                    }
                    if let Some(inner) = weak.upgrade() {
                        let i = inner.borrow();
                        let outcome = if truth(&get(&signal, "aborted")) {
                            Some(Err(get(&signal, "reason")))
                        } else if truth(&i.error) {
                            Some(Err(i.error.clone()))
                        } else if truth(&i.latest)
                            && number(&i.latest, "sequence") > after
                            && number(&i.latest, "epoch") >= epoch
                            && number(&i.latest, "epochFrames") >= min_frames
                        {
                            Some(Ok(i.latest.clone()))
                        } else {
                            None
                        };
                        drop(i);
                        if let Some(outcome) = outcome {
                            *done.borrow_mut() = true;
                            clear_timer(&timer.borrow());
                            inner.borrow_mut().waiters.remove(&id);
                            let _ = call(
                                &signal,
                                "removeEventListener",
                                &["abort".into(), check_slot.replace(JsValue::UNDEFINED)],
                            );
                            let _ = match outcome {
                                Ok(value) => apply(&resolve, &JsValue::UNDEFINED, &[value]),
                                Err(e) => apply(&reject, &JsValue::UNDEFINED, &[e]),
                            };
                        }
                    }
                    JsValue::UNDEFINED
                })
            };
            *check_slot.borrow_mut() = check.clone();
            self.inner.borrow_mut().waiters.insert(id, check.clone());
            let _ = call(
                &signal,
                "addEventListener",
                &["abort".into(), check.clone(), json(serde_json::json!({"once":true}))],
            );
            let timeout_inner = Rc::downgrade(&self.inner);
            let signal_timeout = signal.clone();
            let check_timeout = check.clone();
            let timeout_slot = check_slot.clone();
            let done_timeout = done.clone();
            let on_timeout = callback(move |_| {
                if *done_timeout.borrow() {
                    return JsValue::UNDEFINED;
                }
                *done_timeout.borrow_mut() = true;
                timeout_slot.replace(JsValue::UNDEFINED);
                if let Some(inner) = timeout_inner.upgrade() {
                    inner.borrow_mut().waiters.remove(&id);
                }
                let _ = call(&signal_timeout, "removeEventListener", &["abort".into(), check_timeout.clone()]);
                let _ = apply(
                    &reject_timeout,
                    &JsValue::UNDEFINED,
                    &[error("No fresh Android video frame; using screenshot fallback")],
                );
                JsValue::UNDEFINED
            });
            *timer.borrow_mut() = global_call("setTimeout", &[on_timeout, ms.into()]).unwrap_or_default();
            let _ = apply(&check, &JsValue::UNDEFINED, &[]);
        })
    }
}
impl Default for FrameMailbox {
    fn default() -> Self {
        Self::new()
    }
}
#[wasm_bindgen(js_name=sameViewport)]
pub fn same_viewport(a: JsValue, b: JsValue) -> bool {
    truth(&a) && truth(&b) && ["width", "height", "orientation"].iter().all(|key| get(&a, key) == get(&b, key))
}
struct Video {
    options: JsValue,
    mailbox: FrameMailbox,
    decoder: JsValue,
    abort: JsValue,
    on_abort: JsValue,
    viewport: JsValue,
    bytes: u64,
    previous_bytes: u64,
    closed: bool,
    pump: JsValue,
}
#[wasm_bindgen]
#[derive(Clone)]
pub struct AndroidVideoCapture {
    inner: Rc<RefCell<Video>>,
}
#[wasm_bindgen]
impl AndroidVideoCapture {
    #[wasm_bindgen(constructor)]
    pub fn new(options: JsValue) -> Result<Self, JsValue> {
        let canvas = ctor("OffscreenCanvas", &[1.into(), 1.into()])?;
        let context = call(&canvas, "getContext", &["2d".into(), json(serde_json::json!({"alpha":false}))])?;
        if !truth(&context) {
            return Err(error("Android video canvas unavailable"));
        }
        let capture = Self {
            inner: Rc::new(RefCell::new(Video {
                options: options.clone(),
                mailbox: FrameMailbox::new(),
                decoder: JsValue::UNDEFINED,
                abort: ctor("AbortController", &[])?,
                on_abort: JsValue::UNDEFINED,
                viewport: JsValue::NULL,
                bytes: 0,
                previous_bytes: 0,
                closed: false,
                pump: JsValue::UNDEFINED,
            })),
        };
        let weak = Rc::downgrade(&capture.inner);
        let on_abort = callback(move |_| {
            if let Some(inner) = weak.upgrade() {
                AndroidVideoCapture { inner }.close();
            }
            JsValue::UNDEFINED
        });
        let _ = call(
            &get(&options, "signal"),
            "addEventListener",
            &["abort".into(), on_abort.clone(), json(serde_json::json!({"once":true}))],
        );
        capture.inner.borrow_mut().on_abort = on_abort;
        let size_canvas = canvas.clone();
        let set_size = callback2(move |width, height| {
            let w = width.as_f64().unwrap_or(0.0);
            let h = height.as_f64().unwrap_or(0.0);
            if w <= 0.0 || h <= 0.0 || w > 4096.0 || h > 4096.0 {
                wasm_bindgen::throw_val(error("Invalid Android video size"));
            }
            if number(&size_canvas, "width") != w {
                set(&size_canvas, "width", &width);
            }
            if number(&size_canvas, "height") != h {
                set(&size_canvas, "height", &height);
            }
            JsValue::UNDEFINED
        });
        let weak = Rc::downgrade(&capture.inner);
        let draw_canvas = canvas.clone();
        let draw = callback(move |frame| {
            let _ = call(&context, "drawImage", &[frame, 0.into(), 0.into()]);
            if let Some(inner) = weak.upgrade() {
                let mailbox = inner.borrow().mailbox.clone();
                mailbox.publish(draw_canvas.clone());
            }
            JsValue::UNDEFINED
        });
        let video = get(&options, "video");
        let decoder = call(
            &options,
            "decoderFactory",
            &[obj(&[
                ("codec", get(&get(&video, "metadata"), "codec")),
                ("hardwareAcceleration", "prefer-hardware".into()),
                ("renderer", obj(&[("setSize", set_size), ("draw", draw)])),
            ])],
        )?;
        capture.inner.borrow_mut().decoder = decoder.clone();
        let writer = call(&get(&decoder, "writable"), "getWriter", &[])?;
        let weak = Rc::downgrade(&capture.inner);
        let pump_writer = writer.clone();
        let write = callback(move |packet| {
            if let Some(inner) = weak.upgrade() {
                let mailbox = {
                    let mut i = inner.borrow_mut();
                    i.bytes += number(&get(&packet, "data"), "byteLength") as u64;
                    i.mailbox.clone()
                };
                if text(&packet, "type") == "configuration" {
                    mailbox.configure();
                }
            }
            call(&pump_writer, "write", &[packet]).unwrap_or_else(|e| Promise::reject(&e).into())
        });
        let writable = call(&options, "streamFactory", &[obj(&[("write", write)])])?;
        let abort = capture.inner.borrow().abort.clone();
        let stream = get(&video, "stream");
        let pump = call(
            &stream,
            "pipeTo",
            &[writable, obj(&[("signal", get(&abort, "signal")), ("preventCancel", true.into())])],
        )?;
        let weak = Rc::downgrade(&capture.inner);
        let end = callback(move |_| {
            if let Some(inner) = weak.upgrade() {
                let mailbox = inner.borrow().mailbox.clone();
                mailbox.fail(error("Android video stream ended"));
            }
            JsValue::UNDEFINED
        });
        let weak = Rc::downgrade(&capture.inner);
        let failure = callback(move |e| {
            if let Some(inner) = weak.upgrade() {
                let i = inner.borrow();
                let mailbox = i.mailbox.clone();
                let closed = i.closed;
                let options = i.options.clone();
                let abort = i.abort.clone();
                drop(i);
                mailbox.fail(e);
                if !closed {
                    let sink = call(&options, "streamFactory", &[obj(&[("write", callback(|_| JsValue::UNDEFINED))])])
                        .unwrap_or_default();
                    if let Ok(draining) = call(&stream, "pipeTo", &[sink, obj(&[("signal", get(&abort, "signal"))])]) {
                        let _ = call(&draining, "catch", &[callback(|_| JsValue::UNDEFINED)]);
                    }
                }
            }
            JsValue::UNDEFINED
        });
        let pump = call(&pump, "then", &[end, failure])?;
        let release = callback(move |_| {
            let _ = call(&writer, "releaseLock", &[]);
            JsValue::UNDEFINED
        });
        capture.inner.borrow_mut().pump = call(&pump, "finally", &[release])?;
        Ok(capture)
    }
    #[wasm_bindgen(getter)]
    pub fn mailbox(&self) -> FrameMailbox {
        self.inner.borrow().mailbox.clone()
    }
    #[wasm_bindgen(getter)]
    pub fn closed(&self) -> bool {
        self.inner.borrow().closed
    }
    pub fn ready(&self, signal: JsValue) -> Promise {
        self.mailbox().wait(obj(&[
            ("after", 0.into()),
            ("epoch", 1.into()),
            ("signal", signal),
            ("timeoutMs", 2500.into()),
        ]))
    }
    pub fn snapshot(&self, signal: JsValue) -> Promise {
        let this = self.clone();
        future_to_promise(async move { this.snapshot_inner(signal).await })
    }
    pub fn close(&self) {
        let (abort, options, on_abort, mailbox, decoder) = {
            let mut i = self.inner.borrow_mut();
            if i.closed {
                return;
            }
            i.closed = true;
            (i.abort.clone(), i.options.clone(), i.on_abort.clone(), i.mailbox.clone(), i.decoder.clone())
        };
        let _ = call(&abort, "abort", &[]);
        let _ = call(&get(&options, "signal"), "removeEventListener", &["abort".into(), on_abort]);
        mailbox.fail(error("Android video closed"));
        let _ = call(&decoder, "dispose", &[]);
    }
}
impl AndroidVideoCapture {
    async fn snapshot_inner(&self, signal: JsValue) -> Result<JsValue, JsValue> {
        abort_check(&signal)?;
        let options = self.inner.borrow().options.clone();
        let before = invoke(&options, "readViewport", std::slice::from_ref(&signal)).await?;
        if !truth(&before) {
            return Err(error("Android video display geometry unavailable"));
        }
        let mailbox = self.mailbox();
        let sequence = mailbox.sequence();
        let mut epoch = mailbox.epoch();
        let changed = !same_viewport(before.clone(), self.inner.borrow().viewport.clone());
        if changed {
            epoch += 1;
            invoke(&get(&options, "controller"), "resetVideo", &[]).await?;
        }
        let frame = resolved(
            mailbox
                .wait(obj(&[
                    ("after", sequence.into()),
                    ("epoch", epoch.into()),
                    ("minFrames", if changed { 2 } else { 1 }.into()),
                    ("signal", signal.clone()),
                    ("timeoutMs", 1800.into()),
                ]))
                .into(),
        )
        .await?;
        if (number(&frame, "width") / number(&frame, "height") - number(&before, "width") / number(&before, "height"))
            .abs()
            > 0.03
        {
            return Err(error("Android video orientation is still changing"));
        }
        let bitmap = resolved(global_call("createImageBitmap", &[get(&frame, "canvas")])?).await?;
        let result = async {
            let after = invoke(&options, "readViewport", std::slice::from_ref(&signal)).await?;
            abort_check(&signal)?;
            if !same_viewport(before, after.clone())
                || get(&bitmap, "width") != get(&frame, "width")
                || get(&bitmap, "height") != get(&frame, "height")
            {
                return Err(error("Android rotated during capture; refresh before acting"));
            }
            let source_bytes = {
                let mut i = self.inner.borrow_mut();
                i.viewport = after.clone();
                let bytes = i.bytes - i.previous_bytes;
                i.previous_bytes = i.bytes;
                bytes
            };
            Ok(obj(&[
                ("bitmap", bitmap.clone()),
                ("viewport", after),
                ("sourceBytes", (source_bytes as f64).into()),
                ("sourceFormat", "h264-stream".into()),
            ]))
        }
        .await;
        if result.is_err() {
            let _ = call(&bitmap, "close", &[]);
        }
        result
    }
}
