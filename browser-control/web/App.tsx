import {
  useMemo,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createTaskActions } from "./task-actions.mjs";
import { BrowserClient } from "./client.mjs";
import { ConnectionPanel } from "./components/ConnectionPanel";
import { PhonePreview } from "./components/PhonePreview";
import { TaskPanel } from "./components/TaskPanel";
import { SetupPanel } from "./components/SetupPanel";
import { activeTask } from "./types";
import type { AIConfig, Args, Screen } from "./types";

export function App({ client: suppliedClient }: { client?: BrowserClient }) {
  const clientRef = useRef(suppliedClient || new BrowserClient());
  const client = clientRef.current;
  const state = useSyncExternalStore(
    client.subscribe,
    client.snapshot,
    client.snapshot,
  );
  const [apiBase, setApiBase] = useState("");
  const [ai, setAI] = useState<AIConfig | null>(null);
  const [configError, setConfigError] = useState("");
  const [screen, setScreen] = useState<Screen | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [stoppingTask, setStoppingTask] = useState<string | null>(null);
  const actions = useMemo(
    () =>
      createTaskActions(client, {
        onBusy: setBusy,
        onError: setError,
        onStopBusy: setStoppingTask,
      }),
    [client],
  );
  const session = state.session;
  const task = session?.task || null;
  const wdaReady = !!session?.ready && session.daemon?.state?.state === "ready";
  const running = activeTask(task);
  const canControl = wdaReady && !running && state.phase === "connected";
  const supported =
    typeof navigator !== "undefined" &&
    "usb" in navigator &&
    globalThis.isSecureContext;
  const status = state.error
    ? "连接失败"
    : state.phase === "selecting"
      ? "等待 USB 授权"
      : state.phase === "pairing"
        ? "正在配对与准备"
        : !session
          ? "未连接设备"
          : session.state !== "connected"
            ? "设备离线"
            : !session.ready
              ? "原生服务启动中"
              : !wdaReady
                ? "WDA 准备中"
                : "可以控制";
  useEffect(() => {
    let cancelled = false;
    setAI(null);
    setConfigError("");
    const timer = setTimeout(() => {
      client.config(apiBase).then(
        (value) => {
          if (!cancelled) setAI(value);
        },
        () => {
          if (!cancelled)
            setConfigError("无法读取服务器配置，请检查地址和服务状态。");
        },
      );
    }, 350);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [client, apiBase]);
  useEffect(() => {
    if (!session) {
      setScreen(null);
      return;
    }
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const value = await client.refresh();
        if (disposed) return;
        if (value.ready && value.daemon?.state?.state === "ready") {
          const image = await client.screen();
          if (!disposed && image.deviceId === value.deviceId) setScreen(image);
        } else setScreen(null);
      } catch (e) {
        if (!disposed) {
          setScreen(null);
          setError(e instanceof Error ? e.message : "无法读取设备状态");
        }
      } finally {
        if (!disposed) timer = setTimeout(poll, 1800);
      }
    };
    void poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [client, session?.id]);
  useEffect(() => {
    const close = () => {
      void client.disconnect();
    };
    window.addEventListener("pagehide", close);
    return () => {
      window.removeEventListener("pagehide", close);
      void client.disconnect();
    };
  }, [client]);
  const run = actions.run;
  const manual = (tool: string, args: Args) => {
    const current = client.snapshot();
    if (
      activeTask(current.session?.task) ||
      current.session?.daemon?.state?.state !== "ready" ||
      current.phase !== "connected"
    )
      return;
    void run(async () => {
      const result = await client.command(tool, args);
      if (result.kind === "error")
        throw new Error(
          result.message || "设备操作失败。已经发出的操作不会自动重试。",
        );
      const image = await client.screen();
      if (client.snapshot().session?.deviceId === image.deviceId)
        setScreen(image);
    });
  };
  const connect = (token: string) => {
    setError("");
    setScreen(null);
    void client
      .connect({ apiBase, accessToken: token })
      .catch((e) => setError(e instanceof Error ? e.message : "连接失败"));
  };
  const disconnect = () => {
    setScreen(null);
    setError("");
    void client.disconnect();
  };
  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="/" aria-label="iPhone Control 首页">
          <span className="brand-mark">i</span>
          <div>
            iPhone Control<span>设备工作台</span>
          </div>
        </a>
        <div className="workspace-link">
          <span>▦</span> 控制台 <span className="nav-count">01</span>
        </div>
        <ConnectionPanel
          state={state}
          supported={supported}
          apiBase={apiBase}
          onBase={setApiBase}
          onConnect={connect}
          onDisconnect={disconnect}
        />
        <div className="sidebar-guide">
          <div className="section-label">开始之前</div>
          <ol>
            <li>用 USB 连接 iPhone</li>
            <li>解锁手机，允许浏览器访问</li>
            <li>按向导完成信任与授权</li>
          </ol>
          <p>
            Safari 与 Firefox 暂不支持。
            <br />
            签名和模型均在服务器运行。
          </p>
        </div>
        <div className="sidebar-footer">
          <span className="tiny-dot" /> Browser → Cloud → iPhone
        </div>
      </aside>
      <main className="workspace">
        <header className="topbar">
          <span>
            工作空间 <span className="breadcrumb-separator">/</span>{" "}
            <strong>设备控制台</strong>
          </span>
          <span className="environment-badge">
            {apiBase ? "自定义服务器" : "当前网站服务器"}
          </span>
        </header>
        <div className="workspace-content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR DEVICE, YOUR WORKFLOW</div>
              <h1>
                让 iPhone 帮你做事<span className="heading-dot">.</span>
              </h1>
              <p>接上设备，描述任务。每一步都看得见。</p>
            </div>
            <div
              className={`connection-status ${wdaReady ? "ready" : ""}`}
              role="status"
            >
              <span className="tiny-dot" />
              {status}
            </div>
          </div>
          {(state.error || error || configError) && (
            <div className="error-banner" role="alert">
              <span>!</span>
              <div>
                <strong>{state.error || error || configError}</strong>
                {/claim|exclusive USB/i.test(state.error || error) && (
                  <p>
                    请保持手机解锁，关闭占用设备的其他浏览器标签页，然后重新连接。USB
                    接口访问成功后，仍需要验证配对和 WDA 准备。
                  </p>
                )}
              </div>
              <button
                className="icon-button"
                aria-label="清除操作提示"
                onClick={() => {
                  setError("");
                  setConfigError("");
                }}
              >
                ×
              </button>
            </div>
          )}
          <div className="console-grid">
            <div className="workflow-column">
              <TaskPanel
                ai={ai}
                task={task}
                canRun={canControl && !!ai?.aiReady}
                busy={busy}
                stopBusy={stoppingTask === `${session?.id}/${task?.id}`}
                onStart={(instruction) =>
                  void run(() => client.startTask(instruction))
                }
                onConfirm={(approved) => {
                  if (task?.confirmation)
                    void run(() =>
                      client.confirmTask(
                        task.id,
                        task.confirmation!.actionId,
                        approved,
                      ),
                    );
                }}
                onStop={() => {
                  if (session && task) void actions.stop(session.id, task.id);
                }}
              />
              {session && (!wdaReady || session.setup.transcript) && (
                <SetupPanel
                  setup={session.setup}
                  busy={busy || running}
                  onStart={() => void run(() => client.startSetup())}
                  onInput={(line) => void run(() => client.setupInput(line))}
                />
              )}
              <div className="workflow-note">
                <span>◈</span>
                <p>
                  {running
                    ? "AI 任务执行期间，手动操作已暂停。可随时停止后续步骤。"
                    : "手机画面与操作来自当前连接的真实设备。未连接时不会展示示例画面。"}
                </p>
              </div>
            </div>
            <PhonePreview
              screen={screen}
              status={status}
              canControl={canControl}
              busy={busy}
              onCommand={manual}
              onRefresh={() =>
                void run(async () => {
                  const image = await client.screen();
                  if (client.snapshot().session?.deviceId === image.deviceId)
                    setScreen(image);
                })
              }
            />
          </div>
          <footer className="workspace-footer">
            <span>
              iPhone Control <span className="footer-separator">·</span> WebUSB
              工作台
            </span>
            <span>关闭页面将断开设备连接</span>
          </footer>
        </div>
      </main>
    </div>
  );
}
