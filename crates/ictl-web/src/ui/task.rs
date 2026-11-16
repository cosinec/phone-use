use super::*;
#[component]
pub(super) fn TaskPanel(ui: Ui) -> impl IntoView {
    let instruction = RwSignal::new(String::new());
    let auto_confirm = RwSignal::new(false);
    let images = super::attachments::TaskImages::new(ui);
    let model = RwSignal::new(String::new());
    let models = move || {
        let ai = ui.ai.get();
        let models = ai["models"].as_array().cloned().unwrap_or_default();
        if models.is_empty() && !string(&ai, "model").is_empty() { vec![ai["model"].clone()] } else { models }
    };
    let selected = move || {
        let models = models();
        let selected = model.get();
        if models.iter().any(|v| v == &selected) {
            selected
        } else {
            ui.ai.get()["model"].as_str().or(models.first().and_then(Value::as_str)).unwrap_or_default().to_string()
        }
    };
    let cannot_start = move || {
        !ui.can_control()
            || ui.ai.get()["aiReady"] != true
            || ui.busy.get()
            || ui.running()
            || images.uploading.get()
            || instruction.get().trim().is_empty()
    };
    view! {
        <section class="task-card" aria-labelledby="composer-heading">
            <h2 id="composer-heading" class="sr-only">"告诉手机，你想做什么"</h2>
            <Show when=move || !ui.running()>
            <div class="suggestions">
                <span class="sr-only">"试试这些任务"</span>
                {[
                    "打开设置，查看系统版本",
                    "打开时钟，查看已有闹钟",
                    "回到主屏幕",
                ]
                    .into_iter()
                    .map(move |text| {
                        view! {
                            <button
                                disabled=move || ui.running()
                                on:click=move |_| instruction.set(text.to_string())
                            >
                                {text}
                                <Icon name="arrow-up-right" />
                            </button>
                        }
                    })
                    .collect_view()}
            </div>
            </Show>
            <form class="task-composer"
            on:dragover=move |e| { e.prevent_default(); }
            on:drop=move |e| {
                e.prevent_default();
                if let Some(files) = e.data_transfer().and_then(|d| d.files()) { images.add(ui, files); }
            }
            on:paste=move |e| {
                if let Some(files) = e.clipboard_data().and_then(|d| d.files()).filter(|f| f.length() > 0) {
                    e.prevent_default(); images.add(ui, files);
                }
            }
            on:submit=move |e| {
                e.prevent_default();
                if cannot_start() {
                    return;
                }
                let text = instruction.get_untracked();
                let model = selected();
                let auto = auto_confirm.get_untracked();
                ui.run(move |client| {
                    client.start_task(text, if model.is_empty() { None } else { Some(model) }, images.ids(), Some(auto))
                });
            }>
                <label class="sr-only" for="task-instruction">
                    "任务描述"
                </label>
                <textarea
                    id="task-instruction"
                    prop:value=move || instruction.get()
                    maxlength="4000"
                    disabled=move || ui.running()
                    on:input=move |e| instruction.set(event_target_value(&e))
                    placeholder="描述你想完成的事，例如：打开设置，查看系统版本"
                    rows="3"
                />
                <super::attachments::ImageInputs ui=ui images=images />
                <div class="task-toolbar">
                <div class="model-picker">
                    <label class="sr-only" for="task-model">"任务模型"</label>
                    <div class="model-picker-row">
                        <select
                            id="task-model"
                            prop:value=selected
                            disabled=move || {
                                ui.ai.get()["aiReady"] != true || models().is_empty()
                                    || ui.running() || ui.busy.get()
                            }
                            on:change=move |e| model.set(event_target_value(&e))
                        >
                            <Show when=move || models().is_empty()>
                                <option value="">
                                    {move || {
                                        if ui.ai.get().is_null() {
                                            "正在读取模型列表…"
                                        } else {
                                            "暂无模型"
                                        }
                                    }}
                                </option>
                            </Show>
                            {move || {
                                models()
                                    .into_iter()
                                    .map(|name| {
                                        let name = name.as_str().unwrap_or_default().to_string();
                                        view! {
                                            <option value=name.clone() selected=selected() == name>
                                                {name.clone()}
                                            </option>
                                        }
                                    })
                                    .collect_view()
                            }}
                        </select>
                        <button
                            class="icon-button model-refresh"
                            aria-label="刷新列表" title="刷新列表"
                            type="button"
                            disabled=move || ui.running() || ui.busy.get() || ui.ai.get().is_null()
                            on:click=move |_| ui.config_revision.update(|v| *v += 1)
                        >
                            <Icon name="refresh" />
                        </button>
                    </div>
                    <Show when=move || !string(&ui.ai.get(), "modelsError").is_empty()>
                        <p class="inline-error" role="status">
                            {move || string(&ui.ai.get(), "modelsError")}
                        </p>
                    </Show>
                </div>
                <div class="task-input-footer">
                    <span>
                        {move || format!("{}/4000", instruction.get().encode_utf16().count())}
                    </span>
                    <button class="button primary" disabled=cannot_start type="submit">
                        "开始任务 "
                        <Icon name="arrow-up-right" />
                    </button>
                </div>
                </div>
                <details class="task-options">
                    <summary><Icon name="settings" />"任务选项"</summary>
                <label class="auto-confirm">
                    <input
                        type="checkbox"
                        prop:checked=move || auto_confirm.get()
                        disabled=move || ui.running()
                        on:change=move |e| auto_confirm.set(event_target_checked(&e))
                    />
                    "本次任务自动确认（付款、购买仍会询问）"
                </label>
                    <p class="field-hint">"模型需要支持图片输入。自动确认只影响本次任务。"</p>
                </details>
            </form>
            <div class=move || {
                format!(
                    "ai-notice {}",
                    if ui.ai.get()["aiReady"] == true { "configured" } else { "" },
                )
            }>
                <Icon name="sparkles" />
                <div>
                    <strong>
                        {move || {
                            if ui.ai.get().is_null() {
                                "正在检查 AI 配置".into()
                            } else if ui.ai.get()["aiReady"] == true && ui.ai.get()["backend"] == "codex" {
                                format!("Codex agent · {}", selected())
                            } else if ui.ai.get()["aiReady"] == true && ui.ai.get()["backend"] == "cc" {
                                format!("Claude Code · {}", selected())
                            } else if ui.ai.get()["aiReady"] == true {
                                format!(
                                    "已选择 {}",
                                    if selected().is_empty() {
                                        "视觉模型".into()
                                    } else {
                                        selected()
                                    },
                                )
                            } else if ui.ai.get()["backend"] == "codex" {
                                "Codex agent 暂不可用".into()
                            } else if ui.ai.get()["backend"] == "cc" {
                                "Claude Code 暂不可用".into()
                            } else {
                                "AI 尚未配置".into()
                            }
                        }}
                    </strong>
                    <Show when=move || ui.ai.get()["aiReady"] != true>
                    <p>
                        {move || {
                            if ui.ai.get()["backend"] == "codex" {
                                "请检查服务器上的 Codex 桥接服务。设备就绪后仍可手动控制。"
                            } else if ui.ai.get()["backend"] == "cc" {
                                "请检查服务器上的 Claude Code 桥接服务。设备就绪后仍可手动控制。"
                            } else {
                                "请让服务器管理员配置模型。设备就绪后仍可手动控制。"
                            }
                        }}
                    </p>
                    </Show>
                </div>
            </div>

        </section>
    }
}
