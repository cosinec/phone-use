import { useState } from "react";
import type { ClientState } from "../types";
interface Props {
  state: ClientState;
  supported: boolean;
  apiBase: string;
  onBase: (base: string) => void;
  onConnect: (token: string, platform: "ios" | "android") => void;
  onDisconnect: () => void;
}
export function ConnectionPanel({
  state,
  supported,
  apiBase,
  onBase,
  onConnect,
  onDisconnect,
}: Props) {
  const [platform, setPlatform] = useState<"ios" | "android">("ios");
  const [token, setToken] = useState("");
  const occupied =
    !!state.session ||
    ["selecting", "pairing", "connected"].includes(state.phase);
  const selectedPlatform = occupied ? (state.session?.platform || state.device?.platform || platform) : platform;
  return (
    <section className="connection-panel">
      <div className="section-label">连接设备</div>
      <label className="field-label" htmlFor="device-platform">手机系统</label>
      <select id="device-platform" value={selectedPlatform} disabled={occupied} onChange={(e) => setPlatform(e.target.value as "ios" | "android")}>
        <option value="ios">iPhone / iOS</option><option value="android">Android</option>
      </select>
      <p className="field-hint">{selectedPlatform === "android" ? "Android 8+：开启开发者选项与 USB 调试，在手机上允许 RSA 授权。无需 Apple ID。请退出本地 adb/scrcpy，释放 USB 接口。" : "Mac Chrome：保持手机解锁，完成信任与 WDA 准备。"}</p>
      <div className="connection-device">
        <div className="device-icon">▯</div>
        <div>
          <strong>{state.device?.productName || (selectedPlatform === "android" ? "你的 Android 手机" : "你的 iPhone")}</strong>
          <span>
            {occupied ? "保持 USB 连接与页面打开" : "通过 Chrome 与 USB 连接"}
          </span>
        </div>
      </div>
      {state.device?.serialNumber && (
        <code className="device-id">{state.device.serialNumber}</code>
      )}
      <label className="field-label" htmlFor="server-url">
        服务器地址
      </label>
      <input
        id="server-url"
        type="url"
        placeholder="留空使用当前网站"
        value={apiBase}
        disabled={occupied}
        onChange={(e) => onBase(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <label className="field-label" htmlFor="server-token">
        服务器访问令牌
      </label>
      <input
        id="server-token"
        type="password"
        placeholder="由服务器管理员提供"
        value={token}
        disabled={occupied}
        onChange={(e) => setToken(e.target.value)}
        autoComplete="off"
        spellCheck={false}
      />
      <p className="field-hint">令牌仅在当前页面内存中使用。</p>
      {occupied ? (
        <button className="button secondary full" onClick={onDisconnect}>
          {state.phase === "connected" ? "断开连接" : "取消连接"}
        </button>
      ) : (
        <button
          className="button primary full"
          disabled={!supported || !!state.cleanupPending || !token.trim()}
          onClick={() => {
            onConnect(token, platform);
            setToken("");
          }}
        >
          <span>＋</span>{" "}
          {state.cleanupPending ? "等待 USB 释放" : selectedPlatform === "android" ? "连接 Android" : "连接 iPhone"}
        </button>
      )}
      {state.warning && (
        <p className="field-hint" role="status">
          {state.warning}
        </p>
      )}
      {!supported && (
        <p className="inline-error">
          请用 Chrome，在 HTTPS 或 localhost 打开此页面。
        </p>
      )}
      <div className="connection-note">
        <span className="tiny-dot" />{" "}
        {occupied && state.transportStatus
          ? state.transportStatus
          : "USB 数据由此浏览器转发"}
      </div>
    </section>
  );
}
