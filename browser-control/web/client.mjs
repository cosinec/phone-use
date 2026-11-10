import * as androidSDK from "./android/bridge.mjs";
import { androidUID } from "./android/core.mjs";
import * as publishedSDK from "@limrun/device-install";
import { canonicalUID } from "../src/device-identity.mjs";
import { completeUsbPacketReads } from "./usb-packets.mjs";
const progressLabels = {
  "Android authorization": "请在手机上允许 USB 调试（RSA 指纹授权）",
  "Android control startup": "正在准备 Android 控制通道",
  "Android ready": "Android 已就绪",
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
    androidSdk = androidSDK,
    fetchImpl = globalThis.fetch,
    uuid = () => crypto.randomUUID(),
    cleanupTimeoutMs = 5000,
    usbEvents = globalThis.navigator?.usb,
  } = {}) {
    this.sdk = sdk;
    this.androidSdk = androidSdk;
    this.usbEvents = usbEvents;
    this.fetchImpl = fetchImpl;
    this.uuid = uuid;
    this.cleanupTimeoutMs = cleanupTimeoutMs;
    this.listeners = new Set();
    this.attempt = null;
    this.refreshSequence = 0;
    this.custody = new Set();
    this.view = {
      phase: "offline",
      device: null,
      session: null,
      error: null,
      warning: null,
      transportStatus: "",
      cleanupPending: false,
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
  watchUSBDisconnect(attempt, uid) {
    const events = this.usbEvents,
      selectedDevice = attempt.target.device;
    if (!events?.addEventListener || !events?.removeEventListener) return;
    const disconnect = (event) => {
      if (this.attempt !== attempt || attempt.cancelled || !event.device)
        return;
      let matches = event.device === selectedDevice;
      if (!matches) {
        try {
          matches = (attempt.platform === "android" ? androidUID : canonicalUID)(event.device.serialNumber) === uid;
        } catch {}
      }
      if (matches)
        void this.connectionLost(attempt, {
          phase: "offline",
          message:
            "手机已断开 USB 连接。请重新连接设备；已经发出的操作可能已执行。",
        });
    };
    events.addEventListener("disconnect", disconnect);
    attempt.detachUSB = () =>
      events.removeEventListener("disconnect", disconnect);
  }
  publishCustody() {
    const cleanupPending = this.custody.size > 0 && !this.attempt;
    this.update({
      cleanupPending,
      warning: cleanupPending
        ? "上次 USB 配对或释放仍在处理中。请等待；长时间未结束时，可刷新页面后重试。"
        : null,
    });
  }
  holdCustody(owner) {
    this.custody.add(owner);
    this.publishCustody();
  }
  releaseCustody(owner) {
    if (this.custody.delete(owner)) this.publishCustody();
  }
  safeError(error, attempt = this.attempt) {
    let message = error instanceof Error ? error.message : "请求失败";
    for (const value of [attempt?.accessToken, attempt?.session?.token])
      if (value) message = message.split(value).join("[已隐藏]");
    return message.slice(0, 1600);
  }
  async request(base, route, token, method = "GET", data, signal) {
    const response = await this.fetchImpl.call(globalThis, `${base}${route}`, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(data !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(data !== undefined ? { body: JSON.stringify(data) } : {}),
      cache: "no-store",
      redirect: "error",
      ...(signal ? { signal } : {}),
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
  connect({ apiBase = "", accessToken, platform = "ios" }) {
    if (!["ios", "android"].includes(platform)) return Promise.reject(new Error("不支持的设备系统"));
    if (this.attempt)
      return Promise.reject(new Error("连接仍在处理中，请先断开"));
    if (this.custody.size)
      return Promise.reject(
        new Error("上次 USB 配对或释放仍在处理中，请等待结束后再连接"),
      );
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
      platform,
      sdk: platform === "android" ? this.androidSdk : this.sdk,
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
      chooser = attempt.sdk.requestUSBAccess({ log });
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
      const uid = (attempt.platform === "android" ? androidUID : canonicalUID)(hello.serialNumber);
      this.watchUSBDisconnect(attempt, uid);
      if (attempt.platform === "ios" && typeof attempt.target.device?.transferIn === "function")
        attempt.target.device = completeUsbPacketReads(attempt.target.device);
      this.update({
        phase: "pairing",
        device: { ...hello, serialNumber: uid },
      });
      const stored = await attempt.sdk.getPairRecord(uid);
      if (attempt.cancelled) return;
      attempt.session = await this.request(
        attempt.base,
        "/api/sessions",
        attempt.accessToken,
        "POST",
        {
          device: {
            ...(attempt.platform === "android" ? { platform: "android" } : {}),
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
          platform: attempt.platform,
          id: attempt.session.id,
          deviceId: attempt.session.deviceId,
          state: "waiting_for_relay",
          ready: false,
          daemon: null,
          setup: { state: "idle", transcript: "", exitCode: null },
          task: null,
        },
      });
      const target = attempt.target;
      this.holdCustody(attempt);
      let result;
      try {
        result = await attempt.sdk.pairDevice({
          registryApiUrl: attempt.base || globalThis.location.origin,
          token: attempt.session.token,
          target,
          log: attempt.log,
        });
      } finally {
        // The SDK can finish opening resources after cancellation. Its target
        // stays captured until this in-flight pair settles for final cleanup.
        if (!attempt.target) attempt.target = target;
      }
      attempt.relay = result.relay;
      if (attempt.cancelled) return;
      if (result.pairRecord) await attempt.sdk.putPairRecord(
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
      this.releaseCustody(attempt);
    }
  }
  async cleanup(attempt) {
    attempt.detachUSB?.();
    attempt.detachUSB = null;
    const relay = attempt.relay,
      session = attempt.session,
      target = attempt.target;
    attempt.relay = null;
    attempt.session = null;
    attempt.target = null;
    try {
      relay?.close();
    } catch {}
    const abort = new AbortController();
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve();
      }, this.cleanupTimeoutMs);
    });
    // Close USB immediately; an unavailable server must not hold the USB device.
    const usb = target
      ? (async () => {
          const owner = Symbol("USB cleanup");
          this.holdCustody(owner);
          try {
            await attempt.sdk.closeDeviceRelayTarget(target);
          } catch {
          } finally {
            this.releaseCustody(owner);
          }
        })()
      : Promise.resolve();
    const deletion = session
      ? this.request(
          attempt.base,
          `/api/sessions/${session.id}`,
          session.token,
          "DELETE",
          undefined,
          abort.signal,
        )
      : Promise.resolve();
    try {
      await Promise.race([Promise.allSettled([usb, deletion]), timeout]);
    } finally {
      clearTimeout(timer);
    }
  }
  disconnect() {
    const attempt = this.attempt;
    if (attempt) attempt.cancelled = true;
    this.attempt = null;
    ++this.refreshSequence;
    this.update({
      phase: "offline",
      session: null,
      device: null,
      error: null,
      warning: null,
      transportStatus: "",
      cleanupPending: this.custody.size > 0,
    });
    this.publishCustody();
    return attempt ? this.cleanup(attempt) : Promise.resolve();
  }
  async connectionLost(
    attempt,
    {
      phase = "error",
      message = "设备连接已断开。请重新连接；已经发出的操作可能已执行。",
    } = {},
  ) {
    if (this.attempt !== attempt) return;
    attempt.cancelled = true;
    this.attempt = null;
    ++this.refreshSequence;
    this.update({
      phase,
      session: null,
      device: null,
      error: message,
    });
    this.publishCustody();
    await this.cleanup(attempt);
  }
  async sessionRequest(route = "", method = "GET", data) {
    const attempt = this.attempt,
      session = attempt?.session;
    if (!session || attempt.cancelled) throw new Error("请先连接手机");
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
        attempt &&
        this.attempt === attempt &&
        !attempt.cancelled &&
        sequence === this.refreshSequence
      )
        this.update({ session: result });
      return result;
    } catch (error) {
      if (
        attempt &&
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
    return this.sessionRequest("/preview");
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
  startTask(instruction, model) {
    return this.sessionRequest("/tasks", "POST", { instruction, ...(model ? { model } : {}) });
  }
  confirmTask(id, actionId, approved) {
    return this.sessionRequest(
      `/tasks/${encodeURIComponent(id)}/confirm`,
      "POST",
      { actionId, approved },
    );
  }
  async stopTask(id) {
    const attempt = this.attempt;
    ++this.refreshSequence;
    const result = await this.sessionRequest(
      `/tasks/${encodeURIComponent(id)}/stop`,
      "POST",
      {},
    );
    if (
      this.attempt === attempt &&
      !attempt.cancelled &&
      this.view.session?.task?.id === id
    ) {
      ++this.refreshSequence;
      this.update({ session: { ...this.view.session, task: result } });
    }
    return result;
  }
}
