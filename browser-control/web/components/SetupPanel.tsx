import { useEffect, useRef, useState } from "react";
import type { Setup } from "../types";
interface Props {
  setup: Setup;
  busy: boolean;
  onStart: () => void;
  onInput: (line: string) => void;
}
export function SetupPanel({ setup, busy, onStart, onInput }: Props) {
  const [line, setLine] = useState("");
  const transcript = useRef<HTMLPreElement>(null);
  useEffect(() => {
    if (transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [setup.transcript]);
  const running = setup.state === "running";
  return (
    <section className="setup-card card">
      <div className="card-header">
        <div>
          <span className="section-label">设备准备</span>
          <h2>授权与安装向导</h2>
        </div>
        <span className={`badge ${running ? "pending" : ""}`}>
          {(
            {
              idle: "尚未开始",
              running: "正在准备",
              stopping: "正在停止",
              complete: "向导已结束",
              failed: "准备失败",
            } as Record<string, string>
          )[setup.state] || setup.state}
        </span>
      </div>
      <p className="card-description">
        先解锁手机并信任电脑，再按提示开启开发者模式。Apple 账号与 WDA
        签名在当前服务器处理。
      </p>
      <pre
        className="setup-transcript"
        ref={transcript}
        aria-label="设备准备输出"
        aria-live="polite"
      >
        {setup.transcript || "等待设备连接和原生向导输出…"}
      </pre>
      {setup.error && <p className="inline-error">{setup.error}</p>}
      {running ? (
        <form
          className="setup-input"
          onSubmit={(e) => {
            e.preventDefault();
            if (!line || busy) return;
            const value = line;
            const input = e.currentTarget.querySelector("input");
            if (input) input.value = "";
            setLine("");
            onInput(value);
          }}
        >
          <label htmlFor="setup-line">仅在向导提示输入时提交</label>
          <div className="text-control">
            <input
              id="setup-line"
              type="password"
              value={line}
              autoComplete="off"
              spellCheck={false}
              maxLength={4096}
              placeholder="账号、密码或验证码（单行）"
              onChange={(e) => setLine(e.target.value)}
            />
            <button
              className="button secondary"
              type="submit"
              disabled={busy || !line}
            >
              提交
            </button>
          </div>
          <p className="field-hint">提交后立即清空；页面不保存输入内容。</p>
        </form>
      ) : (
        <button
          className="button secondary"
          disabled={busy || setup.state === "stopping"}
          onClick={onStart}
        >
          {setup.state === "idle" ? "启动准备向导" : "重新启动向导"}
        </button>
      )}
    </section>
  );
}
