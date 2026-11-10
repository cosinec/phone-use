mod connection;
mod preview;
mod setup;
mod task;

use crate::{BrowserClient, actions::create_task_actions, js::*, polling::start_session_polling};
use js_sys::Promise;
use leptos::prelude::*;
use serde_json::{Value, json as value};
use wasm_bindgen::{JsCast, prelude::*};
use wasm_bindgen_futures::{future_to_promise, spawn_local};

#[derive(Clone, Copy)]
pub(super) struct Ui {
    client: StoredValue<BrowserClient, LocalStorage>,
    actions: StoredValue<JsValue, LocalStorage>,
    pub state: RwSignal<Value>,
    pub ai: RwSignal<Value>,
    pub screen: RwSignal<Value>,
    pub base: RwSignal<String>,
    pub error: RwSignal<String>,
    pub config_error: RwSignal<String>,
    pub config_revision: RwSignal<u64>,
    pub busy: RwSignal<bool>,
    pub stop_key: RwSignal<String>,
}
fn value_from_js(value: JsValue) -> Value {
    serde_wasm_bindgen::from_value(value).unwrap_or(Value::Null)
}
pub(super) fn string(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_string()
}
impl Ui {
    pub fn session(self) -> Value {
        self.state.get()["session"].clone()
    }
    pub fn task(self) -> Value {
        self.session()["task"].clone()
    }
    pub fn running(self) -> bool {
        let task = self.task();
        !task.is_null() && !["completed", "failed", "stopped"].contains(&task["state"].as_str().unwrap_or_default())
    }
    pub fn ready(self) -> bool {
        let session = self.session();
        session["ready"] == true && session["daemon"]["state"]["state"] == "ready"
    }
    pub fn android(self) -> bool {
        self.session()["platform"] == "android" || self.state.get()["device"]["platform"] == "android"
    }
    pub fn can_control(self) -> bool {
        self.ready() && !self.running() && self.state.get()["phase"] == "connected"
    }
    pub fn occupied(self) -> bool {
        !self.session().is_null()
            || ["selecting", "pairing", "connected"].contains(&self.state.get()["phase"].as_str().unwrap_or_default())
    }
    pub fn status(self) -> String {
        let state = self.state.get();
        if !state["error"].is_null() {
            return "连接失败".into();
        }
        match state["phase"].as_str().unwrap_or_default() {
            "selecting" => "等待 USB 授权".into(),
            "pairing" => "正在配对与准备".into(),
            _ if state["session"].is_null() => "未连接设备".into(),
            _ if state["session"]["state"] != "connected" => "设备离线".into(),
            _ if state["session"]["ready"] != true => "原生服务启动中".into(),
            _ if !self.ready() => if self.android() { "Android 控制准备中" } else { "WDA 准备中" }.into(),
            _ => "可以控制".into(),
        }
    }
    pub fn run(self, operation: impl FnOnce(BrowserClient) -> Promise + 'static) {
        let mut operation = Some(operation);
        let action = callback(move |_| {
            operation.take().map(|operation| operation(self.client.get_value()).into()).unwrap_or(JsValue::UNDEFINED)
        });
        let _ = call(&self.actions.get_value(), "run", &[action]);
    }
    pub fn accept_screen(self, screen: JsValue) {
        let image = value_from_js(screen);
        if !image.is_null() && image["deviceId"] == self.session()["deviceId"] {
            self.screen.set(image);
        }
    }
    pub fn manual(self, tool: String, args: Value) {
        if !self.can_control() || self.busy.get_untracked() {
            return;
        }
        self.run(move |client| {
            future_to_promise(async move {
                let result = resolved(client.command(tool, json(args)).into()).await?;
                if text(&result, "kind") == "error" {
                    return Err(error(if text(&result, "message").is_empty() {
                        "设备操作失败。已经发出的操作不会自动重试。".into()
                    } else {
                        text(&result, "message")
                    }));
                }
                self.accept_screen(resolved(client.screen().into()).await?);
                Ok(JsValue::UNDEFINED)
            })
        });
    }
    pub fn refresh_screen(self) {
        self.run(move |client| {
            future_to_promise(async move {
                self.accept_screen(resolved(client.screen().into()).await?);
                Ok(JsValue::UNDEFINED)
            })
        });
    }
    pub fn disconnect(self) {
        self.screen.set(Value::Null);
        self.error.set(String::new());
        let _ = self.client.get_value().disconnect();
    }
    pub fn connect(self, token: String, platform: String) {
        self.error.set(String::new());
        self.screen.set(Value::Null);
        // Dispatch the chooser within the click event, before spawning any future.
        let pending = self
            .client
            .get_value()
            .connect(json(value!({"apiBase":self.base.get_untracked(),"accessToken":token,"platform":platform})));
        spawn_local(async move {
            if let Err(e) = resolved(pending.into()).await {
                self.error.set(message(&e));
            }
        });
    }
    pub fn stop(self) {
        let session = self.session();
        let task = session["task"].clone();
        let _ = call(&self.actions.get_value(), "stop", &[json(session["id"].clone()), json(task["id"].clone())]);
    }
    pub fn confirm(self, approved: bool) {
        let task = self.task();
        if task["confirmation"].is_null() {
            return;
        }
        self.run(move |client| {
            client.confirm_task(string(&task, "id"), string(&task["confirmation"], "actionId"), approved)
        });
    }
}

#[wasm_bindgen]
pub fn mount(options: JsValue) -> Result<(), JsValue> {
    let root = web_sys::window()
        .ok_or_else(|| error("Browser window unavailable"))?
        .document()
        .ok_or_else(|| error("Document unavailable"))?
        .get_element_by_id("root")
        .ok_or_else(|| error("Missing #root"))?
        .dyn_into::<web_sys::HtmlElement>()?;
    leptos::mount::mount_to(root, move || view! { <App options=options.clone() /> }).forget();
    Ok(())
}

#[component]
fn App(options: JsValue) -> impl IntoView {
    let client = BrowserClient::new(options);
    let state = RwSignal::new(value_from_js(client.snapshot()));
    let ui = Ui {
        client: StoredValue::new_local(client.clone()),
        actions: StoredValue::new_local(JsValue::NULL),
        state,
        ai: RwSignal::new(Value::Null),
        screen: RwSignal::new(Value::Null),
        base: RwSignal::new(String::new()),
        error: RwSignal::new(String::new()),
        config_error: RwSignal::new(String::new()),
        config_revision: RwSignal::new(0),
        busy: RwSignal::new(false),
        stop_key: RwSignal::new(String::new()),
    };
    let subscription_client = client.clone();
    let _unsubscribe = client.subscribe(callback(move |_| {
        state.set(value_from_js(subscription_client.snapshot()));
        JsValue::UNDEFINED
    }));
    let actions = create_task_actions(
        client.clone().into(),
        obj(&[
            (
                "onBusy",
                callback(move |v| {
                    ui.busy.set(truth(&v));
                    JsValue::UNDEFINED
                }),
            ),
            (
                "onError",
                callback(move |v| {
                    ui.error.set(v.as_string().unwrap_or_default());
                    JsValue::UNDEFINED
                }),
            ),
            (
                "onStopBusy",
                callback(move |v| {
                    ui.stop_key.set(v.as_string().unwrap_or_default());
                    JsValue::UNDEFINED
                }),
            ),
        ]),
    );
    ui.actions.set_value(actions);
    let config_epoch = RwSignal::new(0u64);
    Effect::new(move |_| {
        let base = ui.base.get();
        let _ = ui.config_revision.get();
        let epoch = config_epoch.get_untracked() + 1;
        config_epoch.set(epoch);
        ui.ai.set(Value::Null);
        ui.config_error.set(String::new());
        spawn_local(async move {
            let _ = resolved(timeout(350.0).into()).await;
            if config_epoch.get_untracked() != epoch {
                return;
            }
            let result = resolved(ui.client.get_value().config(Some(base)).into()).await;
            if config_epoch.get_untracked() != epoch {
                return;
            }
            match result {
                Ok(value) => ui.ai.set(value_from_js(value)),
                Err(_) => ui.config_error.set("无法读取服务器配置，请检查地址和服务状态。".into()),
            }
        });
    });
    let session_id = Memo::new(move |_| string(&ui.session(), "id"));
    let poll_stop = StoredValue::new_local(JsValue::NULL);
    Effect::new(move |_| {
        let id = session_id.get();
        let previous = poll_stop.get_value();
        if previous.is_function() {
            let _ = apply(&previous, &JsValue::UNDEFINED, &[]);
        }
        poll_stop.set_value(JsValue::NULL);
        if id.is_empty() {
            ui.screen.set(Value::Null);
            return;
        }
        let stop = start_session_polling(
            ui.client.get_value().into(),
            obj(&[
                (
                    "onScreen",
                    callback(move |image| {
                        if image.is_null() {
                            ui.screen.set(Value::Null);
                        } else {
                            ui.accept_screen(image);
                        }
                        JsValue::UNDEFINED
                    }),
                ),
                (
                    "onError",
                    callback(move |e| {
                        ui.error.set(e.as_string().unwrap_or_default());
                        JsValue::UNDEFINED
                    }),
                ),
            ]),
        );
        poll_stop.set_value(stop);
    });
    let close = callback(move |_| {
        ui.disconnect();
        let stop = poll_stop.get_value();
        if stop.is_function() {
            let _ = apply(&stop, &JsValue::UNDEFINED, &[]);
        }
        JsValue::UNDEFINED
    });
    let _ = call(&global(), "addEventListener", &["pagehide".into(), close]);
    view! {
        <div class="app-shell">
            <aside class="sidebar">
                <a class="brand" href="/" aria-label="iPhone Control 首页">
                    <span class="brand-mark">"i"</span>
                    <div>"iPhone Control"<span>"设备工作台"</span></div>
                </a>
                <div class="workspace-link">
                    <span>"▦"</span>
                    " 控制台 "
                    <span class="nav-count">"01"</span>
                </div>
                <connection::ConnectionPanel ui />
                <div class="sidebar-guide">
                    <div class="section-label">"开始之前"</div>
                    <ol>
                        <li>"用 USB 连接手机"</li>
                        <li>"解锁手机，允许浏览器访问"</li>
                        <li>"按向导完成信任与授权"</li>
                    </ol>
                    <p>
                        "Safari 与 Firefox 暂不支持。"<br />
                        "模型在服务器运行。Android 调试密钥保存在浏览器。"
                    </p>
                </div>
                <div class="sidebar-footer">
                    <span class="tiny-dot" />
                    " Browser ↔ Cloud ↔ Phone"
                </div>
            </aside>
            <main class="workspace">
                <header class="topbar">
                    <span>
                        "工作空间 "<span class="breadcrumb-separator">"/"</span>" "
                        <strong>"设备控制台"</strong>
                    </span>
                    <span class="environment-badge">
                        {move || {
                            if ui.base.get().is_empty() {
                                "当前网站服务器"
                            } else {
                                "自定义服务器"
                            }
                        }}
                    </span>
                </header>
                <div class="workspace-content">
                    <div class="page-heading">
                        <div>
                            <div class="eyebrow">"YOUR DEVICE, YOUR WORKFLOW"</div>
                            <h1>"让手机帮你做事"<span class="heading-dot">"."</span></h1>
                            <p>"接上设备，描述任务。每一步都看得见。"</p>
                        </div>
                        <div
                            class=move || {
                                format!(
                                    "connection-status {}",
                                    if ui.ready() { "ready" } else { "" },
                                )
                            }
                            role="status"
                        >
                            <span class="tiny-dot" />
                            {move || ui.status()}
                        </div>
                    </div>
                    <Show when=move || {
                        !string(&ui.state.get(), "error").is_empty() || !ui.error.get().is_empty()
                            || !ui.config_error.get().is_empty()
                    }>
                        <div class="error-banner" role="alert">
                            <span>"!"</span>
                            <div>
                                <strong>
                                    {move || {
                                        let error = string(&ui.state.get(), "error");
                                        if !error.is_empty() {
                                            error
                                        } else if !ui.error.get().is_empty() {
                                            ui.error.get()
                                        } else {
                                            ui.config_error.get()
                                        }
                                    }}
                                </strong>
                                <Show when=move || {
                                    let e = format!(
                                        "{} {}",
                                        string(&ui.state.get(), "error"),
                                        ui.error.get(),
                                    )
                                        .to_lowercase();
                                    e.contains("claim") || e.contains("exclusive usb")
                                }>
                                    <p>
                                        "请保持手机解锁，关闭占用设备的其他浏览器标签页，然后重新连接。USB 接口访问成功后，请按对应系统完成手机授权。"
                                    </p>
                                </Show>
                            </div>
                            <button
                                class="icon-button"
                                aria-label="清除操作提示"
                                on:click=move |_| {
                                    ui.error.set(String::new());
                                    ui.config_error.set(String::new());
                                }
                            >
                                "×"
                            </button>
                        </div>
                    </Show>
                    <div class="console-grid">
                        <div class="workflow-column">
                            <task::TaskPanel ui />
                            <Show when=move || {
                                !ui.session().is_null() && !ui.android()
                                    && (!ui.ready()
                                        || !string(&ui.session()["setup"], "transcript").is_empty())
                            }>
                                <setup::SetupPanel ui />
                            </Show>
                            <div class="workflow-note">
                                <span>"◈"</span>
                                <p>
                                    {move || {
                                        if ui.running() {
                                            "AI 任务执行期间，手动操作已暂停。可随时停止后续步骤。"
                                        } else {
                                            "手机画面与操作来自当前连接的真实设备。未连接时不会展示示例画面。"
                                        }
                                    }}
                                </p>
                            </div>
                        </div>
                        <preview::PhonePreview ui />
                    </div>
                    <footer class="workspace-footer">
                        <span>
                            "iPhone Control "<span class="footer-separator">"·"</span>
                            " WebUSB 工作台"
                        </span>
                        <span>"关闭页面将断开设备连接"</span>
                    </footer>
                </div>
            </main>
        </div>
    }
}
