import { useRef, useState } from "react";
import type { Pointer } from "../interaction.mjs";
import { toPhonePoint, pointerCommand } from "../interaction.mjs";
import type { Command, Screen } from "../types";
interface Props {
  screen: Screen | null;
  status: string;
  canControl: boolean;
  busy: boolean;
  onCommand: Command;
  onRefresh: () => void;
}
export function PhonePreview({
  screen,
  status,
  canControl,
  busy,
  onCommand,
  onRefresh,
}: Props) {
  const down = useRef<Pointer | null>(null);
  const [text, setText] = useState("");
  const [position, setPosition] = useState("");
  const [loaded, setLoaded] = useState(false);
  const point = (e: React.PointerEvent<HTMLImageElement>) =>
    toPhonePoint(
      e.clientX,
      e.clientY,
      e.currentTarget.getBoundingClientRect(),
      e.currentTarget.naturalWidth,
      e.currentTarget.naturalHeight,
    );
  const disabled = !canControl || busy;
  return (
    <section className="phone-card card">
      <div className="card-header">
        <div>
          <span className="section-label">设备屏幕</span>
          <h2>实时画面</h2>
        </div>
        <button
          className="icon-button"
          aria-label="刷新屏幕"
          title="刷新屏幕"
          disabled={disabled}
          onClick={onRefresh}
        >
          ↻
        </button>
      </div>
      <div className="phone-stage">
        <div className={`phone-frame ${screen ? "has-screen" : ""}`}>
          {screen ? (
            <img
              key={screen.imageBase64.slice(-40)}
              className="phone-screen"
              src={`data:image/jpeg;base64,${screen.imageBase64}`}
              alt="iPhone 当前屏幕"
              draggable={false}
              onLoad={() => setLoaded(true)}
              onError={() => setLoaded(false)}
              onPointerDown={(e) => {
                if (disabled || !loaded) return;
                e.currentTarget.setPointerCapture(e.pointerId);
                down.current = {
                  point: point(e),
                  x: e.clientX,
                  y: e.clientY,
                  time: performance.now(),
                };
              }}
              onPointerMove={(e) => {
                const p = point(e);
                setPosition(p ? `${p.x}, ${p.y}` : "");
              }}
              onPointerUp={(e) => {
                const start = down.current;
                down.current = null;
                if (!start || disabled) return;
                const command = pointerCommand(start, {
                  point: point(e),
                  x: e.clientX,
                  y: e.clientY,
                  time: performance.now(),
                });
                if (command) onCommand(command.tool, command.args);
              }}
              onPointerCancel={() => {
                down.current = null;
              }}
            />
          ) : (
            <div className="empty-phone">
              <div className="empty-usb">⌁</div>
              <strong>{status}</strong>
              <p>
                连接后，这里会显示
                <br />
                iPhone 的真实屏幕
              </p>
              <span className="empty-phone-line" />
            </div>
          )}
        </div>
      </div>
      <div className="screen-meta">
        <span>
          <i className={`tiny-dot ${screen ? "live" : ""}`} />
          {screen ? "设备截图" : "等待设备画面"}
        </span>
        <code>{position || "坐标随指针显示"}</code>
      </div>
      <p className="screen-hint">点按、拖动滑动，按住 0.5 秒可长按。</p>
      <div className="hardware-buttons">
        {[
          ["home", "⌂", "主屏幕"],
          ["lock", "▣", "锁屏"],
          ["volume_down", "−", "音量减"],
          ["volume_up", "＋", "音量加"],
        ].map(([button, icon, label]) => (
          <button
            key={button}
            disabled={disabled}
            onClick={() => onCommand("iphone_press_button", { button })}
          >
            <span>{icon}</span>
            {label}
          </button>
        ))}
      </div>
      <form
        className="text-control"
        onSubmit={(e) => {
          e.preventDefault();
          if (disabled || !text.trim()) return;
          onCommand("iphone_type_text", { text, submit: false });
          setText("");
        }}
      >
        <label className="sr-only" htmlFor="phone-text">
          输入文字到手机
        </label>
        <input
          id="phone-text"
          placeholder="输入文字到手机…"
          disabled={disabled}
          value={text}
          maxLength={10000}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          className="button secondary"
          disabled={disabled || !text.trim()}
          type="submit"
        >
          输入
        </button>
      </form>
      {screen?.elementsError && (
        <p className="field-hint">画面可用，界面元素暂时不可用。</p>
      )}
    </section>
  );
}
