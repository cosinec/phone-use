import * as publishedSDK from "@limrun/device-install";
import { canonicalUID } from "../src/device-identity.mjs";
const progressLabels = {
  "Selecting USB device": "等待 USB 授权",
  "Selected USB device": "已选择设备",
  "Claiming usbmux interface": "正在申请 USB 接口访问",
  "USB interface claim failed": "此接口暂不可用，SDK 正在尝试其他接口",
  "Claimed usbmux interface": "USB 接口已授权",
  "Created usbmux session": "USB 数据通道已建立",
  "Connected WebSocket relay": "已连接服务器",
  "Pairing requested": "等待设备信任与配对",
  "Pair record received": "设备配对记录已保存",
};

export class BrowserClient {
  constructor({
    sdk = publishedSDK,
    fetchImpl = globalThis.fetch,
    uuid = () => crypto.randomUUID(),
  } = {}) {
    this.sdk = sdk;
    this.fetchImpl = fetchImpl;
    this.uuid = uuid;
    this.listeners = new Set();
    this.attempt = null;
    this.refreshSequence = 0;
    this.view = {
      phase: "offline",
      device: null,
      session: null,
      error: null,
      warning: null,
      transportStatus: "",
    };
  }
  snapshot = () => this.view;
  subscribe = (listener) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  update(patch) {
    this.view = { ...this.view, ...patch };
    for (const listener of this.listeners) listener();
  }
  safeError(error, attempt = this.attempt) {
    let message = error instanceof Error ? error.message : "请求失败";
    for (const value of [attempt?.accessToken, attempt?.session?.token])
      if (value) message = message.split(value).join("[已隐藏]");
    return message.slice(0, 1600);
  }
  async request(base, route, token, method = "GET", data) {
    const response = await this.fetchImpl(`${base}${route}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      cache: "no-store",
      redirect: "error",
    });
    const result = await response.json();
    if (!response.ok)
      throw Object.assign(
        new Error(result.error || `请求失败（${response.status}）`),
        { status: response.status },
      );
    return result;
  }
  config(apiBase = "") {
    return this.request(apiBase.replace(/\/$/, ""), "/api/config");
  }
  // Keep this function synchronous up to requestUSBAccess: Chrome requires user activation.
  connect({ apiBase = "", accessToken }) {
    if (this.attempt)
      return Promise.reject(new Error("连接仍在处理中，请先断开"));
    let base = apiBase.trim().replace(/\/$/, "");
    if (base) {
      let url;
      try {
        url = new URL(base);
      } catch {
        return Promise.reject(new Error("请输入有效的服务器地址"));
      }
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        return Promise.reject(
          new Error("服务器地址必须为 HTTP(S) origin，不含账号或路径"),
        );
      base = url.origin;
    }
    if (!accessToken?.trim())
      return Promise.reject(new Error("请输入服务器访问令牌"));
    const attempt = {
      base,
      accessToken,
      cancelled: false,
      target: null,
      session: null,
      relay: null,
    };
    this.attempt = attempt;
    const log = (message) => {
      if (attempt.cancelled) return;
      if (progressLabels[message])
        this.update({ transportStatus: progressLabels[message] });
      if (message === "Relay socket closed") void this.connectionLost(attempt);
    };
    attempt.log = log;
    let chooser;
    try {
      chooser = this.sdk.requestUSBAccess({ log });
    } catch (error) {
      chooser = Promise.reject(error);
    }
    this.update({
      phase: "selecting",
      error: null,
      warning: null,
      device: null,
      session: null,
    });
    return this.completeConnection(attempt, chooser);
  }
  async completeConnection(attempt, chooser) {
    try {
      attempt.target = await chooser;
      if (attempt.cancelled) return;
      const hello = attempt.target.hello;
      const uid = canonicalUID(hello.serialNumber);
      this.update({
        phase: "pairing",
        device: { ...hello, serialNumber: uid },
      });
      const stored = await this.sdk.getPairRecord(uid);
      if (attempt.cancelled) return;
      attempt.session = await this.request(
        attempt.base,
        "/api/sessions",
        attempt.accessToken,
        "POST",
        {
          device: {
            serialNumber: uid,
            vendorId: hello.vendorId,
            productId: hello.productId,
            ...(hello.productName ? { productName: hello.productName } : {}),
          },
          ...(stored
            ? {
                pairRecord: {
                  udid: canonicalUID(stored.udid),
                  pairRecordBase64: stored.pairRecordBase64,
                },
              }
            : {}),
        },
      );
      // The controller credential is only needed for creation.
      attempt.accessToken = "";
      if (attempt.cancelled) return;
      this.update({
        session: {
          id: attempt.session.id,
          deviceId: attempt.session.deviceId,
          state: "waiting_for_relay",
          ready: false,
          daemon: null,
          setup: { state: "idle", transcript: "", exitCode: null },
          task: null,
        },
      });
      const result = await this.sdk.pairDevice({
        registryApiUrl: attempt.base || globalThis.location.origin,
        token: attempt.session.token,
        target: attempt.target,
        log: attempt.log,
      });
      attempt.relay = result.relay;
      if (attempt.cancelled) return;
      await this.sdk.putPairRecord(
        {
          udid: canonicalUID(result.pairRecord.udid),
          pairRecordBase64: result.pairRecord.pairRecordBase64,
        },
        { productName: hello.productName },
      );
      if (!attempt.cancelled) this.update({ phase: "connected" });
    } catch (error) {
      if (!attempt.cancelled) {
        const message = this.safeError(error, attempt);
        attempt.cancelled = true;
        this.update({ phase: "error", error: message, session: null });
        throw new Error(message);
      }
    } finally {
      if (attempt.cancelled) {
        await this.cleanup(attempt);
        if (this.attempt === attempt) this.attempt = null;
      }
    }
  }
  async cleanup(attempt) {
    attempt.relay?.close();
    if (attempt.session) {
      const session = attempt.session;
      attempt.session = null;
      try {
        await this.request(
          attempt.base,
          `/api/sessions/${session.id}`,
          session.token,
          "DELETE",
        );
      } catch {}
    }
    try {
      await this.sdk.closeDeviceRelayTarget(attempt.target);
    } catch {}
  }
  async disconnect() {
    const attempt = this.attempt;
    if (attempt) {
      attempt.cancelled = true;
      await this.cleanup(attempt);
      if (attempt.relay && this.attempt === attempt) this.attempt = null;
    }
    this.update({
      phase: "offline",
      session: null,
      device: null,
      error: null,
      warning: null,
    });
  }
  async connectionLost(attempt) {
    attempt.cancelled = true;
    this.update({
      phase: "error",
      session: null,
      error: "设备连接已断开。请重新连接；已经发出的操作可能已执行。",
    });
    await this.cleanup(attempt);
    if (this.attempt === attempt) this.attempt = null;
  }
  async sessionRequest(route = "", method = "GET", data) {
    const attempt = this.attempt,
      session = attempt?.session;
    if (!session || attempt.cancelled) throw new Error("请先连接 iPhone");
    try {
      return await this.request(
        attempt.base,
        `/api/sessions/${session.id}${route}`,
        session.token,
        method,
        data,
      );
    } catch (error) {
      throw Object.assign(new Error(this.safeError(error, attempt)), {
        status: error?.status,
      });
    }
  }
  async refresh() {
    const attempt = this.attempt;
    const sequence = ++this.refreshSequence;
    try {
      const result = await this.sessionRequest();
      if (
        this.attempt === attempt &&
        !attempt.cancelled &&
        sequence === this.refreshSequence
      )
        this.update({ session: result });
      return result;
    } catch (error) {
      if (
        this.attempt === attempt &&
        !attempt.cancelled &&
        sequence === this.refreshSequence
      ) {
        if (error.status === 401 || error.status === 404)
          await this.connectionLost(attempt);
        else if (this.view.session)
          this.update({
            session: {
              ...this.view.session,
              ready: false,
              state: "unavailable",
            },
          });
      }
      throw error;
    }
  }
  screen() {
    return this.sessionRequest("/screen");
  }
  command(tool, args) {
    return this.sessionRequest("/command", "POST", {
      requestId: this.uuid(),
      deviceId: this.attempt?.session?.deviceId,
      tool,
      args,
    });
  }
  startSetup() {
    return this.sessionRequest("/setup", "POST", {});
  }
  setupInput(line) {
    return this.sessionRequest("/setup/input", "POST", { line });
  }
  startTask(instruction) {
    return this.sessionRequest("/tasks", "POST", { instruction });
  }
  confirmTask(id, actionId, approved) {
    return this.sessionRequest(
      `/tasks/${encodeURIComponent(id)}/confirm`,
      "POST",
      { actionId, approved },
    );
  }
  stopTask(id) {
    return this.sessionRequest(
      `/tasks/${encodeURIComponent(id)}/stop`,
      "POST",
      {},
    );
  }
}
