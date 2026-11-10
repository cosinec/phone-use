use super::*;
use crate::interaction::{Pointer, Rect, pointer_command, to_phone_point};
use web_sys::{HtmlImageElement, PointerEvent};
fn pointer(event: &PointerEvent, ui: Ui) -> Option<Pointer> {
    let image = event.current_target()?.dyn_into::<HtmlImageElement>().ok()?;
    let rect = image.get_bounding_client_rect();
    let (mut width, mut height) = (image.natural_width() as f64, image.natural_height() as f64);
    if !ui.preview_url.get_untracked().is_empty() {
        let session = ui.session();
        let screen = &session["daemon"]["persisted"]["screen"];
        let (w, h) = (screen["width"].as_f64()?, screen["height"].as_f64()?);
        (width, height) = if width > height { (h.max(w), h.min(w)) } else { (h.min(w), h.max(w)) };
    }
    Some(Pointer {
        point: to_phone_point(
            event.client_x() as f64,
            event.client_y() as f64,
            Rect { left: rect.left(), top: rect.top(), width: rect.width(), height: rect.height() },
            width,
            height,
        ),
        x: event.client_x() as f64,
        y: event.client_y() as f64,
        time: now(),
    })
}
#[component]
pub(super) fn PhonePreview(ui: Ui) -> impl IntoView {
    let down = StoredValue::new_local(None::<Pointer>);
    let text = RwSignal::new(String::new());
    let position = RwSignal::new(String::new());
    let loaded = RwSignal::new(false);
    let landscape = RwSignal::new(false);
    let image_ref = NodeRef::<leptos::html::Img>::new();
    // Chrome only emits load for the initial MJPEG image. Poll intrinsic dimensions
    // with session status so rotation of later frames also updates the phone layout.
    Effect::new(move |_| {
        let _ = ui.state.get();
        if !ui.preview_url.get().is_empty()
            && let Some(image) = image_ref.get()
            && image.natural_width() > 0
            && image.natural_height() > 0
        {
            loaded.set(true);
            landscape.set(image.natural_width() > image.natural_height());
        }
    });
    let disabled = move || {
        !ui.can_control()
            || ui.busy.get()
            || (!ui.preview_url.get().is_empty()
                && ui.session()["preview"]["ageMs"].as_u64().is_none_or(|age| age > 5000))
    };
    view! {
        <section class="phone-card card">
            <div class="card-header">
                <div>
                    <span class="section-label">"设备屏幕"</span>
                    <h2>"实时画面"</h2>
                </div>
                <button
                    class="icon-button"
                    aria-label="刷新屏幕"
                    title="刷新屏幕"
                    disabled=disabled
                    on:click=move |_| ui.refresh_screen()
                >
                    "↻"
                </button>
            </div>
            <div class="phone-stage">
                <div class=move || {
                    format!(
                        "phone-frame {} {}",
                        if ui.screen.get().is_null() && ui.preview_url.get().is_empty() { "" } else { "has-screen" },
                        if landscape.get() { "wide" } else { "" },
                    )
                }>
                    <Show
                        when=move || !ui.screen.get().is_null() || !ui.preview_url.get().is_empty()
                        fallback=move || {
                            view! {
                                <div class="empty-phone">
                                    <div class="empty-usb">"⌁"</div>
                                    <strong>{move || ui.status()}</strong>
                                    <p>
                                        "连接后，这里会显示"<br />"手机的真实屏幕"
                                    </p>
                                    <span class="empty-phone-line" />
                                </div>
                            }
                        }
                    >
                        <img
                            node_ref=image_ref
                            class="phone-screen"
                            src=move || {
                                let stream = ui.preview_url.get();
                                if !stream.is_empty() { return stream; }
                                format!(
                                    "data:image/jpeg;base64,{}",
                                    string(&ui.screen.get(), "imageBase64"),
                                )
                            }
                            alt="手机当前屏幕"
                            draggable="false"
                            on:load=move |e| {
                                if let Some(image) = e
                                    .current_target()
                                    .and_then(|v| v.dyn_into::<HtmlImageElement>().ok())
                                {
                                    loaded.set(true);
                                    landscape.set(image.natural_width() > image.natural_height());
                                }
                            }
                            on:error=move |_| {
                                ui.preview_url.set(String::new());
                                loaded.set(false);
                                landscape.set(false);
                            }
                            on:pointerdown=move |e| {
                                if disabled() || !loaded.get_untracked() {
                                    return;
                                }
                                if let Some(image) = e
                                    .current_target()
                                    .and_then(|v| v.dyn_into::<HtmlImageElement>().ok())
                                {
                                    let _ = image.set_pointer_capture(e.pointer_id());
                                }
                                down.set_value(pointer(&e, ui));
                            }
                            on:pointermove=move |e| {
                                position
                                    .set(
                                        pointer(&e, ui)
                                            .and_then(|p| p.point)
                                            .map(|p| format!("{}, {}", p.x, p.y))
                                            .unwrap_or_default(),
                                    )
                            }
                            on:pointerup=move |e| {
                                let start = down.get_value();
                                down.set_value(None);
                                if disabled() {
                                    return;
                                }
                                if let Some(command) = start
                                    .zip(pointer(&e, ui))
                                    .and_then(|(s, e)| pointer_command(s, e))
                                {
                                    ui.manual(string(&command, "tool"), command["args"].clone());
                                }
                            }
                            on:pointercancel=move |_| down.set_value(None)
                        />
                    </Show>
                </div>
            </div>
            <div class="screen-meta">
                <span>
                    <i class=move || {
                        format!("tiny-dot {}", if ui.screen.get().is_null() { "" } else { "live" })
                    } />
                    {move || {
                        if !ui.preview_url.get().is_empty() {
                            let age = ui.session()["preview"]["ageMs"].as_u64();
                            return match age { Some(age) if age <= 5000 => "MJPEG 连续画面", _ => "画面重连中" };
                        }
                        if ui.screen.get().is_null() {
                            "等待设备画面"
                        } else {
                            "设备截图"
                        }
                    }}
                    {move || {
                        if !ui.preview_url.get().is_empty() { return None; }
                        ui.screen
                            .get()["timings"]["screenshotMs"]
                            .as_f64()
                            .filter(|ms| ms.is_finite())
                            .map(|ms| {
                                view! {
                                    <span title="采集设备画面的耗时，不含模型推理">
                                        {format!(" · 采图 {:.0} ms", ms)}
                                    </span>
                                }
                            })
                    }}
                </span>
                <code>
                    {move || {
                        if position.get().is_empty() {
                            "坐标随指针显示".into()
                        } else {
                            position.get()
                        }
                    }}
                </code>
            </div>
            <p class="screen-hint">"点按、拖动滑动，按住 0.5 秒可长按。"</p>
            <div class="hardware-buttons">
                <Show when=move || ui.android()>
                    <button
                        aria-label="返回"
                        disabled=disabled
                        on:click=move |_| {
                            ui.manual("iphone_press_button".into(), value!({"button":"back"}))
                        }
                    >
                        <span>"↩"</span>
                        "返回"
                    </button>
                </Show>
                {[
                    ("home", "⌂", "主屏幕"),
                    ("lock", "▣", "锁屏"),
                    ("volume_down", "−", "音量减"),
                    ("volume_up", "＋", "音量加"),
                ]
                    .into_iter()
                    .map(move |(button, icon, label)| {
                        view! {
                            <button
                                aria-label=label
                                disabled=disabled
                                on:click=move |_| {
                                    ui.manual(
                                        "iphone_press_button".into(),
                                        value!({"button":button}),
                                    )
                                }
                            >
                                <span>{icon}</span>
                                {label}
                            </button>
                        }
                    })
                    .collect_view()}
            </div>
            <form
                class="text-control"
                on:submit=move |e| {
                    e.prevent_default();
                    if disabled() || text.get_untracked().trim().is_empty() {
                        return;
                    }
                    let value = text.get_untracked();
                    text.set(String::new());
                    ui.manual("iphone_type_text".into(), value!({"text":value,"submit":false}));
                }
            >
                <label class="sr-only" for="phone-text">
                    "输入文字到手机"
                </label>
                <input
                    id="phone-text"
                    placeholder="输入文字到手机…"
                    disabled=disabled
                    prop:value=move || text.get()
                    maxlength="10000"
                    on:input=move |e| text.set(event_target_value(&e))
                />
                <button
                    class="button secondary"
                    disabled=move || disabled() || text.get().trim().is_empty()
                    type="submit"
                >
                    "输入"
                </button>
            </form>
            <Show when=move || ui.android()>
                <p class="field-hint">
                    "请先点选手机上的输入框。中文输入通过粘贴完成，会覆盖手机剪贴板。"
                </p>
            </Show>
            <Show when=move || !string(&ui.screen.get(), "elementsError").is_empty()>
                <p class="field-hint">"画面可用，界面元素暂时不可用。"</p>
            </Show>
        </section>
    }
}
