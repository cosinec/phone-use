import { useState } from "react";
import { activeTask, taskLabels } from "../types";
import type { AIConfig, Task } from "../types";
interface Props {
  ai: AIConfig | null;
  task: Task | null;
  canRun: boolean;
  busy: boolean;
  stopBusy?: boolean;
  onStart: (instruction: string) => void;
  onConfirm: (approved: boolean) => void;
  onStop: () => void;
}
const tools: Record<string, string> = {
  iphone_tap: "点按屏幕",
  iphone_swipe: "滑动屏幕",
  iphone_long_press: "长按",
  iphone_press_button: "按下设备按键",
  iphone_type_text: "输入文字",
  iphone_tap_element: "点按界面元素",
  iphone_launch_app: "打开应用",
  iphone_open_url: "打开链接",
  iphone_terminate_app: "关闭应用",
  iphone_wait_for: "等待界面",
};
export function TaskPanel({
  ai,
  task,
  canRun,
  busy,
  stopBusy = false,
  onStart,
  onConfirm,
  onStop,
}: Props) {
  const [instruction, setInstruction] = useState("");
  const running = activeTask(task);
  return (
    <section className="task-card card">
      <div className="card-header">
        <div>
          <span className="section-label">自然语言控制</span>
          <h2>告诉 iPhone，你想做什么</h2>
        </div>
        <span className="spark-icon">✧</span>
      </div>
      <p className="card-description">
        描述目标，AI 会查看真实屏幕并逐步操作。需要确认时，会先停下来。
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (canRun && !busy && !running && instruction.trim())
            onStart(instruction);
        }}
      >
        <label className="sr-only" htmlFor="task-instruction">
          任务描述
        </label>
        <textarea
          id="task-instruction"
          value={instruction}
          maxLength={4000}
          disabled={running}
          onChange={(e) => setInstruction(e.target.value)}
          placeholder="例如：打开设置，查看当前的 iOS 版本"
          rows={4}
        />
        <div className="task-input-footer">
          <span>{instruction.length}/4000</span>
          <button
            className="button primary"
            disabled={!canRun || busy || running || !instruction.trim()}
            type="submit"
          >
            开始任务 <span>↗</span>
          </button>
        </div>
      </form>
      <div className="suggestions">
        <span>试试这些任务</span>
        {[
          "打开设置，查看 iOS 版本",
          "打开时钟，查看已有闹钟",
          "回到主屏幕",
        ].map((s) => (
          <button key={s} disabled={running} onClick={() => setInstruction(s)}>
            {s}
            <span>↗</span>
          </button>
        ))}
      </div>
      <div className={`ai-notice ${ai?.aiReady ? "configured" : ""}`}>
        <span>✧</span>
        <div>
          <strong>
            {ai === null
              ? "正在检查 AI 配置"
              : ai.aiReady
                ? `已配置 ${ai.model || "视觉模型"}`
                : "AI 尚未配置"}
          </strong>
          <p>
            {ai?.aiReady
              ? "模型在服务器运行。设备准备好后即可开始。"
              : "请让服务器管理员配置模型。设备就绪后仍可手动控制。"}
          </p>
        </div>
      </div>
      <div className="task-progress">
        <div className="progress-header">
          <h3>执行记录</h3>
          {running && (
            <button
              className="button danger small"
              disabled={stopBusy}
              onClick={onStop}
            >
              停止任务
            </button>
          )}
        </div>
        {!task ? (
          <div className="empty-progress">
            <span className="progress-glyph">≡</span>
            <div>
              <strong>等待第一个任务</strong>
              <p>每一步的操作和结果会显示在这里。</p>
            </div>
          </div>
        ) : (
          <>
            <div className={`task-status ${task.state}`} role="status">
              <span className="tiny-dot" />
              {taskLabels[task.state]}
              <span className="step-count">{task.steps.length} 步</span>
            </div>
            <p className="current-instruction">{task.instruction}</p>
            <ol className="step-list">
              {task.steps.map((step, i) => (
                <li key={step.id}>
                  <span className="step-number">{i + 1}</span>
                  <div>
                    <strong>{tools[step.tool] || step.tool}</strong>
                    <p>{step.reason}</p>
                  </div>
                  <span className={`step-state ${step.state}`}>
                    {(
                      {
                        pending: "等待",
                        awaiting_confirmation: "待确认",
                        executing: "操作中",
                        succeeded: "已执行",
                        missed: "未命中",
                        failed: "失败",
                        cancelled: "已取消",
                        uncertain: "结果不确定",
                      } as Record<string, string>
                    )[step.state] || step.state}
                  </span>
                </li>
              ))}
            </ol>
            {task.confirmation && (
              <div className="confirmation" role="alert">
                <strong>这一步需要你的确认</strong>
                <p>{task.confirmation.reason}</p>
                <code>
                  {tools[task.confirmation.tool] || task.confirmation.tool}
                </code>
                <pre>{JSON.stringify(task.confirmation.args, null, 2)}</pre>
                <div className="button-row">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => onConfirm(false)}
                  >
                    拒绝并停止
                  </button>
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => onConfirm(true)}
                  >
                    确认这一步
                  </button>
                </div>
              </div>
            )}
            {(task.message || task.error) && (
              <p className={task.error ? "inline-error" : "task-message"}>
                {task.error || task.message}
              </p>
            )}
            {task.state === "stopped" && (
              <p className="field-hint">
                后续步骤已停止。停止前已发出的操作可能仍已执行，请检查手机。
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
