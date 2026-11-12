use super::{input_viewport, same_viewport};
use crate::js::*;
use js_sys::{Array, Promise, Uint8Array};
use wasm_bindgen::prelude::*;
use wasm_bindgen_futures::future_to_promise;
#[wasm_bindgen(js_name=readBytes)]
pub fn read_bytes(stream: JsValue, max: f64) -> Promise {
    future_to_promise(async move {
        read_bytes_inner(stream, max as usize).await.map(|v| Uint8Array::from(v.as_slice()).into())
    })
}
async fn read_bytes_inner(stream: JsValue, max: usize) -> Result<Vec<u8>, JsValue> {
    let reader = call(&stream, "getReader", &[])?;
    let result = async {
        let mut bytes = Vec::new();
        loop {
            let part = invoke(&reader, "read", &[]).await?;
            if truth(&get(&part, "done")) {
                break;
            }
            let data = Uint8Array::new(&get(&part, "value")).to_vec();
            if bytes.len() + data.len() > max {
                let _ = invoke(&reader, "cancel", &[]).await;
                return Err(error("Android response too large"));
            }
            bytes.extend(data);
        }
        Ok(bytes)
    }
    .await;
    let _ = call(&reader, "releaseLock", &[]);
    result
}
#[wasm_bindgen(js_name=runShell)]
pub fn run_shell(
    adb: JsValue,
    command: String,
    signal: JsValue,
    timeout_ms: Option<f64>,
    binary: Option<bool>,
) -> Promise {
    future_to_promise(async move {
        run_shell_inner(adb, command, signal, timeout_ms.unwrap_or(5000.0), binary.unwrap_or(false)).await
    })
}
async fn run_shell_inner(
    adb: JsValue,
    command: String,
    signal: JsValue,
    timeout_ms: f64,
    binary: bool,
) -> Result<JsValue, JsValue> {
    abort_check(&signal)?;
    let protocol = get(&get(&adb, "subprocess"), "shellProtocol");
    if !truth(&protocol) {
        return Err(error("Android 8 or newer with shell v2 is required"));
    }
    let abort = ctor("AbortController", &[])?;
    let abort_callback = abort.clone();
    let parent = signal.clone();
    let cancel = callback(move |_| {
        let _ = call(&abort_callback, "abort", &[get(&parent, "reason")]);
        JsValue::UNDEFINED
    });
    let _ =
        call(&signal, "addEventListener", &["abort".into(), cancel.clone(), json(serde_json::json!({"once":true}))]);
    let timeout_abort = abort.clone();
    let timer = global_call(
        "setTimeout",
        &[
            callback(move |_| {
                let _ =
                    call(&timeout_abort, "abort", &[error("Android shell timed out; sent actions are not retried")]);
                JsValue::UNDEFINED
            }),
            timeout_ms.into(),
        ],
    )?;
    let mut process = JsValue::UNDEFINED;
    let result = async {
        process = invoke(&protocol, "spawn", &[command.into(), get(&abort, "signal")]).await?;
        abort_check(&get(&abort, "signal"))?;
        let stdout =
            read_bytes(get(&process, "stdout"), if binary { 32.0 * 1024.0 * 1024.0 } else { 2.0 * 1024.0 * 1024.0 });
        let stderr = read_bytes(get(&process, "stderr"), 16384.0);
        let all = resolved(Promise::all(&Array::of3(&stdout, &stderr, &get(&process, "exited"))).into()).await?;
        abort_check(&get(&abort, "signal"))?;
        let all = Array::from(&all);
        let code = all.get(2).as_f64().unwrap_or(0.0);
        if code != 0.0 {
            let stderr =
                String::from_utf8_lossy(&Uint8Array::new(&all.get(1)).to_vec()).chars().take(500).collect::<String>();
            return Err(error(format!("Android shell failed ({code}): {stderr}")));
        }
        let bytes = all.get(0);
        if binary {
            Ok(bytes)
        } else {
            Ok(String::from_utf8_lossy(&Uint8Array::new(&bytes).to_vec()).into_owned().into())
        }
    }
    .await;
    clear_timer(&timer);
    let _ = call(&signal, "removeEventListener", &["abort".into(), cancel]);
    if truth(&process) {
        let kill = invoke(&process, "kill", &[]).await;
        if result.is_ok() {
            kill?;
        }
    }
    result
}
#[wasm_bindgen(js_name=captureAndroid)]
pub fn capture_android(adb: JsValue, signal: JsValue, region: JsValue, previous: JsValue, video: JsValue) -> Promise {
    future_to_promise(async move { capture_inner(adb, signal, region, previous, video).await })
}
async fn capture_inner(
    adb: JsValue,
    signal: JsValue,
    region: JsValue,
    previous: JsValue,
    video: JsValue,
) -> Result<JsValue, JsValue> {
    let mut bitmap = JsValue::UNDEFINED;
    let mut viewport = JsValue::NULL;
    let mut source_bytes = JsValue::UNDEFINED;
    let mut source_format = "png".to_string();
    if truth(&video) && !truth(&get(&video, "closed")) && !truth(&get(&get(&video, "mailbox"), "error")) {
        match invoke(&video, "snapshot", std::slice::from_ref(&signal)).await {
            Ok(frame) => {
                bitmap = get(&frame, "bitmap");
                viewport = get(&frame, "viewport");
                source_bytes = get(&frame, "sourceBytes");
                source_format = text(&frame, "sourceFormat");
            }
            Err(_) => abort_check(&signal)?,
        }
    }
    if !truth(&bitmap) {
        let before = input_viewport(
            run_shell_inner(adb.clone(), "dumpsys input".into(), signal.clone(), 3000.0, false)
                .await?
                .as_string()
                .unwrap_or_default(),
        );
        let bytes = run_shell_inner(adb.clone(), "screencap -p".into(), signal.clone(), 6000.0, true).await?;
        let after = input_viewport(
            run_shell_inner(adb, "dumpsys input".into(), signal.clone(), 3000.0, false)
                .await?
                .as_string()
                .unwrap_or_default(),
        );
        if truth(&before) && truth(&after) && !same_viewport(before, after.clone()) {
            return Err(error("Android rotated while taking screenshot; refresh and try again"));
        }
        let blob = ctor("Blob", &[Array::of1(&bytes).into(), json(serde_json::json!({"type":"image/png"}))])?;
        bitmap = resolved(global_call("createImageBitmap", &[blob])?).await?;
        viewport = if get(&after, "width") == get(&bitmap, "width") && get(&after, "height") == get(&bitmap, "height") {
            after
        } else {
            JsValue::NULL
        };
        source_bytes = get(&bytes, "length");
    }
    let result = async {
        abort_check(&signal)?;
        let native_width = number(&bitmap, "width");
        let native_height = number(&bitmap, "height");
        let scale = (1280.0 / native_width.max(native_height)).min(1.0);
        let width = (native_width * scale).round().max(1.0);
        let height = (native_height * scale).round().max(1.0);
        let orientation = if truth(&viewport) {
            get(&viewport, "orientation")
        } else {
            JsValue::NULL
        };
        let view = obj(&[
            ("width", width.into()),
            ("height", height.into()),
            ("nativeWidth", if truth(&viewport) { get(&viewport, "width") } else { native_width.into() }),
            ("nativeHeight", if truth(&viewport) { get(&viewport, "height") } else { native_height.into() }),
            ("orientation", orientation.clone()),
        ]);
        let mut source = [0.0, 0.0, native_width, native_height];
        let mut out_width = width;
        let mut out_height = height;
        let mut coordinate_mapping =
            json(serde_json::json!({"offsetX":0.0,"offsetY":0.0,"scaleX":1.0,"scaleY":1.0}));
        let mut caption = format!(
            "Android full screen {width}x{height}. Coordinates use these screenshot pixels (native {}x{}).",
            number(&view, "nativeWidth"),
            number(&view, "nativeHeight")
        );
        if truth(&region) {
            if !truth(&previous)
                || get(&previous, "nativeWidth") != get(&view, "nativeWidth")
                || get(&previous, "nativeHeight") != get(&view, "nativeHeight")
                || get(&previous, "orientation") != orientation
            {
                return Err(error("Android display changed; take a full screenshot before requesting a region"));
            }
            let values = Array::from(&region);
            let x = values.get(0).as_f64().unwrap_or(f64::NAN);
            let y = values.get(1).as_f64().unwrap_or(f64::NAN);
            let w = values.get(2).as_f64().unwrap_or(f64::NAN);
            let h = values.get(3).as_f64().unwrap_or(f64::NAN);
            if ![x, y, w, h].iter().all(|value| value.is_finite())
                || x < 0.0
                || y < 0.0
                || w <= 0.0
                || h <= 0.0
                || x + w > number(&previous, "width")
                || y + h > number(&previous, "height")
            {
                return Err(error("Screenshot region outside Android screen"));
            }
            source = [
                x * native_width / number(&previous, "width"),
                y * native_height / number(&previous, "height"),
                w * native_width / number(&previous, "width"),
                h * native_height / number(&previous, "height"),
            ];
            out_width = w.round();
            out_height = h.round();
            if out_width == 0.0 || out_height == 0.0 {
                return Err(error("Screenshot region too small"));
            }
            coordinate_mapping = json(serde_json::json!({
                "offsetX":x,"offsetY":y,"scaleX":w/out_width,"scaleY":h/out_height
            }));
            caption = format!(
                "Android crop at x={x}, y={y}, width={w}, height={h} in full screenshot {}x{}. Add this origin to crop pixel coordinates.",
                number(&previous, "width"),
                number(&previous, "height")
            );
        }
        let canvas = ctor("OffscreenCanvas", &[out_width.into(), out_height.into()])?;
        let context = call(&canvas, "getContext", &["2d".into()])?;
        if !truth(&context) {
            return Err(error("Screenshot canvas unavailable"));
        }
        let mut args = vec![bitmap.clone()];
        args.extend(source.map(JsValue::from_f64));
        args.extend([0.into(), 0.into(), out_width.into(), out_height.into()]);
        call(&context, "drawImage", &args)?;
        let mut jpeg = JsValue::UNDEFINED;
        for quality in [0.78, 0.65, 0.5, 0.35] {
            jpeg = invoke(
                &canvas,
                "convertToBlob",
                &[obj(&[("type", "image/jpeg".into()), ("quality", quality.into())])]
            ).await?;
            if number(&jpeg, "size") <= 480.0 * 1024.0 {
                break;
            }
        }
        if number(&jpeg, "size") > 480.0 * 1024.0 {
            return Err(error("Android screenshot exceeds relay limit"));
        }
        let data = Uint8Array::new(&invoke(&jpeg, "arrayBuffer", &[]).await?).to_vec();
        let binary = data.iter().map(|byte| char::from(*byte)).collect::<String>();
        let encoded = global_call("btoa", &[binary.into()])?;
        Ok(obj(&[
            ("imageBase64", encoded),
            ("caption", caption.into()),
            ("coordinateMapping", coordinate_mapping),
            ("view", view),
            ("sourceBytes", source_bytes),
            ("sourceFormat", source_format.into()),
            ("uploadedBytes", get(&jpeg, "size")),
        ]))
    }.await;
    let _ = call(&bitmap, "close", &[]);
    result
}
