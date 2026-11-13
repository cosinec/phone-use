use super::*;
fn tool_label(name: &str) -> String {
    match name {
        "iphone_tap" => "点按屏幕",
        "iphone_swipe" => "滑动屏幕",
        "iphone_long_press" => "长按",
        "iphone_press_button" => "按下设备按键",
        "iphone_type_text" => "输入文字",
        "iphone_tap_element" => "点按界面元素",
        "iphone_launch_app" => "打开应用",
        "iphone_open_url" => "打开链接",
        "iphone_terminate_app" => "关闭应用",
        "iphone_wait_for" => "等待界面",
        other => other,
    }
    .to_string()
}
fn state_label(state: &str) -> String {
    match state {
        "observing" => "正在查看屏幕",
        "thinking" => "正在规划下一步",
        "awaiting_confirmation" => "等待你的确认",
        "executing" => "正在操作",
        "recovering" => "正在等待设备恢复",
        "completed" => "任务已完成",
        "failed" => "任务失败",
        "stopped" => "任务已停止",
        other => other,
    }
    .to_string()
}
fn step_label(state: &str) -> String {
    match state {
        "pending" => "等待",
        "awaiting_confirmation" => "待确认",
        "executing" => "操作中",
        "succeeded" => "已执行",
        "missed" => "未命中",
        "failed" => "失败",
        "cancelled" => "已取消",
        "uncertain" => "结果不确定",
        other => other,
    }
    .to_string()
}
#[component]
pub(super) fn TaskPanel(ui: Ui) -> impl IntoView {
    let instruction = RwSignal::new(String::new());
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
        <section class="task-card card">
            <div class="card-header">
                <div>
                    <span class="section-label">"自然语言控制"</span>
                    <h2>"告诉手机，你想做什么"</h2>
                </div>
                <span class="spark-icon">"✧"</span>
            </div>
            <p class="card-description">
                "描述目标，AI 会查看真实屏幕并逐步操作。需要确认时，会先停下来。"
            </p>
            <form
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
                ui.run(move |client| {
                    client.start_task(text, if model.is_empty() { None } else { Some(model) }, images.ids())
                });
            }>
                <div class="model-picker">
                    <label for="task-model">"任务模型"</label>
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
                            class="button secondary small"
                            type="button"
                            disabled=move || ui.running() || ui.busy.get() || ui.ai.get().is_null()
                            on:click=move |_| ui.config_revision.update(|v| *v += 1)
                        >
                            "刷新列表"
                        </button>
                    </div>
                    <p class="field-hint">
                        "选择用于下一次任务的模型。查看屏幕需要模型支持图片输入。"
                    </p>
                    <Show when=move || !string(&ui.ai.get(), "modelsError").is_empty()>
                        <p class="inline-error" role="status">
                            {move || string(&ui.ai.get(), "modelsError")}
                        </p>
                    </Show>
                </div>
                <label class="sr-only" for="task-instruction">
                    "任务描述"
                </label>
                <textarea
                    id="task-instruction"
                    prop:value=move || instruction.get()
                    maxlength="4000"
                    disabled=move || ui.running()
                    on:input=move |e| instruction.set(event_target_value(&e))
                    placeholder="例如：打开设置，查看当前的系统版本"
                    rows="4"
                />
                <super::attachments::ImageInputs ui=ui images=images />
                <div class="task-input-footer">
                    <span>
                        {move || format!("{}/4000", instruction.get().encode_utf16().count())}
                    </span>
                    <button class="button primary" disabled=cannot_start type="submit">
                        "开始任务 "
                        <span>"↗"</span>
                    </button>
                </div>
            </form>
            <div class="suggestions">
                <span>"试试这些任务"</span>
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
                                <span>"↗"</span>
                            </button>
                        }
                    })
                    .collect_view()}
            </div>
            <div class=move || {
                format!(
                    "ai-notice {}",
                    if ui.ai.get()["aiReady"] == true { "configured" } else { "" },
                )
            }>
                <span>"✧"</span>
                <div>
                    <strong>
                        {move || {
                            if ui.ai.get().is_null() {
                                "正在检查 AI 配置".into()
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
                            } else if ui.ai.get()["backend"] == "cc" {
                                "Claude Code 暂不可用".into()
                            } else {
                                "AI 尚未配置".into()
                            }
                        }}
                    </strong>
                    <p>
                        {move || {
                            if ui.ai.get()["backend"] == "cc" && ui.ai.get()["aiReady"] == true {
                                "由服务器上的 Claude Code 规划操作，敏感步骤仍需确认。"
                            } else if ui.ai.get()["backend"] == "cc" {
                                "请检查服务器上的 Claude Code 桥接服务。设备就绪后仍可手动控制。"
                            } else if ui.ai.get()["aiReady"] == true {
                                "模型在服务器运行。设备准备好后即可开始。"
                            } else {
                                "请让服务器管理员配置模型。设备就绪后仍可手动控制。"
                            }
                        }}
                    </p>
                </div>
            </div>
            <div class="task-progress">
                <div class="progress-header">
                    <h3>"执行记录"</h3>
                    <Show when=move || ui.running()>
                        <button
                            class="button danger small"
                            disabled=move || {
                                let s = ui.session();
                                ui.stop_key.get()
                                    == format!("{}/{}", string(&s, "id"), string(&s["task"], "id"))
                            }
                            on:click=move |_| ui.stop()
                        >
                            "停止任务"
                        </button>
                    </Show>
                </div>
                <Show
                    when=move || !ui.task().is_null()
                    fallback=|| {
                        view! {
                            <div class="empty-progress">
                                <span class="progress-glyph">"≡"</span>
                                <div>
                                    <strong>"等待第一个任务"</strong>
                                    <p>"每一步的操作和结果会显示在这里。"</p>
                                </div>
                            </div>
                        }
                    }
                >
                    <div
                        class=move || format!("task-status {}", string(&ui.task(), "state"))
                        role="status"
                    >
                        <span class="tiny-dot" />
                        {move || state_label(&string(&ui.task(), "state"))}
                        <span class="step-count">
                            {move || {
                                format!("{} / {} 步", ui.task()["steps"].as_array().map_or(0, Vec::len), ui.task()["maxSteps"].as_u64().unwrap_or(100))
                            }}
                        </span>
                    </div>
                    <p class="current-instruction">{move || string(&ui.task(), "instruction")}</p>
                    <Show when=move || !string(&ui.task(), "model").is_empty()>
                        <p class="field-hint">
                            {move || {
                                format!("本次任务模型：{}", string(&ui.task(), "model"))
                            }}
                        </p>
                    </Show>
                    <Show when=move || !ui.task()["timings"].is_null()>
                        <p class="card-description" aria-label="最近一轮耗时">
                            {move || {
                                let timings = ui.task()["timings"].clone();
                                [
                                    ("观察", "observationMs"),
                                    ("模型", "modelMs"),
                                    ("操作", "actionMs"),
                                ]
                                    .into_iter()
                                    .filter_map(|(label, key)| {
                                        timings[key]
                                            .as_f64()
                                            .map(|ms| format!("{label} {:.2} 秒", ms / 1000.0))
                                    })
                                    .collect::<Vec<_>>()
                                    .join(" · ")
                            }}
                        </p>
                    </Show>
                    <ol class="step-list">
                        {move || {
                            ui.task()["steps"]
                                .as_array()
                                .cloned()
                                .unwrap_or_default()
                                .into_iter()
                                .enumerate()
                                .map(|(i, step)| {
                                    view! {
                                        <li>
                                            <span class="step-number">{i + 1}</span>
                                            <div>
                                                <strong>{tool_label(&string(&step, "tool"))}</strong>
                                                <p>{string(&step, "reason")}</p>
                                            </div>
                                            <span class=format!(
                                                "step-state {}",
                                                string(&step, "state"),
                                            )>{step_label(&string(&step, "state"))}</span>
                                        </li>
                                    }
                                })
                                .collect_view()
                        }}
                    </ol>
                    <Show when=move || !ui.task()["confirmation"].is_null()>
                        <div class="confirmation" role="alert">
                            <strong>"这一步需要你的确认"</strong>
                            <p>{move || string(&ui.task()["confirmation"], "reason")}</p>
                            <code>
                                {move || tool_label(&string(&ui.task()["confirmation"], "tool"))}
                            </code>
                            <pre>
                                {move || {
                                    serde_json::to_string_pretty(&ui.task()["confirmation"]["args"])
                                        .unwrap_or_default()
                                }}
                            </pre>
                            <div class="button-row">
                                <button
                                    class="button secondary"
                                    disabled=move || ui.busy.get()
                                    on:click=move |_| ui.confirm(false)
                                >
                                    "拒绝并停止"
                                </button>
                                <button
                                    class="button primary"
                                    disabled=move || ui.busy.get()
                                    on:click=move |_| ui.confirm(true)
                                >
                                    "确认这一步"
                                </button>
                            </div>
                        </div>
                    </Show>
                    <Show when=move || {
                        !string(&ui.task(), "message").is_empty()
                            || !string(&ui.task(), "error").is_empty()
                    }>
                        <p class=move || {
                            if string(&ui.task(), "error").is_empty() {
                                "task-message"
                            } else {
                                "inline-error"
                            }
                        }>
                            {move || {
                                let err = string(&ui.task(), "error");
                                if err.is_empty() { string(&ui.task(), "message") } else { err }
                            }}
                        </p>
                    </Show>
                    <Show when=move || ui.task()["state"] == "stopped">
                        <p class="field-hint">
                            "后续步骤已停止。停止前已发出的操作可能仍已执行，请检查手机。"
                        </p>
                    </Show>
                </Show>
            </div>
        </section>
    }
}
