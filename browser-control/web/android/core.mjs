// Android command adapter. All shell arguments are quoted independently; never evaluate model text.
export function quote(value) { return `'${String(value).replaceAll("'", "'\\''")}'`; }
export function androidUID(value) {
  if (typeof value !== "string") throw new Error("Invalid Android device serial");
  const serial = value.replace(/\0+$/, "").replace(/^android:/, "");
  if (!/^[A-Za-z0-9_.:-]{1,128}$/.test(serial)) throw new Error("Invalid Android device serial");
  return `android:${serial}`;
}
const decodeXML = (value) => value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (all, key) => {
  if (key[0] === "#") {
    const n = key[1].toLowerCase() === "x" ? parseInt(key.slice(2), 16) : Number(key.slice(1));
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  }
  return { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" }[key] || all;
});
export function parseHierarchy(xml) {
  if (!xml.includes("<hierarchy") || !xml.includes("</hierarchy>")) throw new Error("Android UI hierarchy unavailable");
  const nodes = [];
  for (const match of xml.matchAll(/<node\s+([^<>]*)\/?\s*>/g)) {
    const attrs = Object.fromEntries([...match[1].matchAll(/([\w:-]+)="([^"]*)"/g)].map((m) => [m[1], decodeXML(m[2])]));
    const box = /^\[(\d+),(\d+)\]\[(\d+),(\d+)\]$/.exec(attrs.bounds || "");
    if (!box || attrs["visible-to-user"] === "false") continue;
    const [x, y, right, bottom] = box.slice(1).map(Number);
    if (right <= x || bottom <= y) continue;
    nodes.push({ text: (attrs.text || "").slice(0, 1024), label: (attrs["content-desc"] || "").slice(0, 1024), id: (attrs["resource-id"] || "").slice(0, 512), type: (attrs.class || "").slice(0, 256), enabled: attrs.enabled !== "false", clickable: attrs.clickable === "true", focusable: attrs.focusable === "true", x, y, right, bottom });
    if (nodes.length >= 5000) break;
  }
  return nodes;
}
export function inputViewport(input) {
  const line = input.split("\n").find((line) => /Viewport/.test(line) && /displayId[=: ]+0\b/.test(line) && /logicalFrame/.test(line) && !/valid=false/.test(line));
  const box = /logicalFrame=\[0,\s*0,\s*(\d+),\s*(\d+)\]/.exec(line || "");
  const orientation = /orientation=(\d+)/.exec(line || "");
  return box && orientation ? { width: +box[1], height: +box[2], orientation: +orientation[1] } : null;
}
export function mapPoint(view, x, y) {
  if (!view || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= view.width || y >= view.height)
    throw new Error("Coordinates outside the latest Android screenshot; observe again");
  return [Math.min(view.nativeWidth - 1, Math.round(x * view.nativeWidth / view.width)), Math.min(view.nativeHeight - 1, Math.round(y * view.nativeHeight / view.height))];
}
const textResult = (value) => ({ kind: "text", text: typeof value === "string" ? value : JSON.stringify(value) });
export class AndroidCommands {
  constructor({ shell, capture, controller, deviceId, now = () => performance.now(), delay = (ms, signal) => new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stop); resolve(); }, ms);
    signal?.addEventListener("abort", stop, { once: true });
  }) }) {
    Object.assign(this, { shell, capture, controller, deviceId, delay, now });
    this.view = null; this.sequence = 1n;
  }
  async screenshot(signal, region) {
    const image = await this.capture(signal, region, this.view);
    if (!region) this.view = image.view;
    return image;
  }
  async nodes(signal, budget = 1800) {
    // Unique paths prevent a cancelled dump from being mistaken for a fresh result.
    const filename = `/data/local/tmp/ictl-ui-${crypto.randomUUID()}.xml`;
    const xml = await this.shell(`uiautomator dump --compressed ${quote(filename)} >/dev/null && cat ${quote(filename)}; rm -f ${quote(filename)}`, signal, budget);
    return parseHierarchy(xml);
  }
  formatNodes(nodes, limit = 80, filter = "") {
    const v = this.view;
    return nodes.filter((n) => (n.text || n.label || n.id || n.clickable || n.focusable) && `${n.text} ${n.label} ${n.id} ${n.type}`.includes(filter)).slice(0, limit).map((n) => JSON.stringify({ text: n.text, label: n.label, id: n.id, type: n.type, enabled: n.enabled,
      bounds: v ? [n.x * v.width / v.nativeWidth, n.y * v.height / v.nativeHeight, (n.right - n.x) * v.width / v.nativeWidth, (n.bottom - n.y) * v.height / v.nativeHeight].map(Math.round) : [n.x, n.y, n.right - n.x, n.bottom - n.y] })).join("\n").slice(0, 48000);
  }
  async geometry(signal) {
    // Rotation is cheap to validate through input viewports, without capturing another PNG.
    if (!this.view) throw new Error("Take a full screenshot before coordinate actions");
    const input = await this.shell("dumpsys input", signal, 3000);
    const viewport = inputViewport(input);
    if (!viewport || viewport.width !== this.view.nativeWidth || viewport.height !== this.view.nativeHeight || viewport.orientation !== this.view.orientation)
      throw new Error("Android display size changed or cannot be verified; refresh the screenshot before acting");
  }
  async key(code, signal) {
    signal.throwIfAborted();
    if (this.controller?.injectKeyCode) {
      const key = { keyCode: code, repeat: 0, metaState: 0 };
      // Always release a key whose DOWN might have reached the device, even
      // when cancellation arrives between the two writes. Never replay DOWN.
      try {
        await this.controller.injectKeyCode({ ...key, action: 0 });
        signal.throwIfAborted();
      } finally { await this.controller.injectKeyCode({ ...key, action: 1 }); }
      signal.throwIfAborted();
    } else await this.shell(`input keyevent ${code}`, signal);
  }
  async execute(request, signal) {
    signal.throwIfAborted();
    const { op } = request;
    if (op === "screenshot") {
      const image = await this.screenshot(signal, request.region);
      return { kind: "image", jpeg_base64: image.imageBase64, caption: image.caption };
    }
    if (op === "observe") {
      const start = this.now();
      const nodesPromise = this.nodes(signal, Math.min(request.snapshot_timeout_ms || 1000, 1800)).then(
        (nodes) => ({ nodes, elementsMs: Math.round(this.now() - start) }),
        () => ({ error: "UI hierarchy unavailable; use screenshot coordinates", elementsMs: Math.round(this.now() - start) }),
      );
      const image = await this.screenshot(signal);
      const screenshotMs = Math.round(this.now() - start);
      const tree = await nodesPromise;
      return textResult({ deviceId: this.deviceId, imageBase64: image.imageBase64, caption: image.caption,
        elementsText: tree.nodes ? this.formatNodes(tree.nodes, request.limit || 80) : "", ...(tree.error ? { elementsError: tree.error } : {}),
        timings: { screenshotMs, elementsMs: tree.elementsMs, sourceBytes: image.sourceBytes, sourceFormat: image.sourceFormat || "png", uploadedBytes: image.uploadedBytes } });
    }
    if (op === "status") return textResult({ platform: "android", deviceId: this.deviceId, screen: this.view });
    if (op === "list_devices") return textResult([{ platform: "android", deviceId: this.deviceId }]);
    if (op === "list_elements") return textResult(this.formatNodes(await this.nodes(signal, 5000), request.limit, request.filter || ""));
    if (op === "tap_element" || op === "wait_for") {
      if (!request.text?.trim()) throw new Error("Element text must not be empty");
      const deadline = performance.now() + (request.timeout_ms ?? 5000);
      do {
        const nodes = await this.nodes(signal, 5000);
        const matches = nodes.filter((n) => n.enabled && [n.text, n.label, n.id].some((s) => s.includes(request.text)));
        const found = matches[request.index || 0];
        if (found) {
          if (op === "wait_for") return textResult({ found: true, text: found.text, label: found.label });
          // Native element coordinates were freshly read; no screenshot mapping needed.
          await this.shell(`input tap ${Math.round((found.x + found.right) / 2)} ${Math.round((found.y + found.bottom) / 2)}`, signal);
          await this.delay(180, signal); return textResult({ tapped: true, text: found.text });
        }
        if (op === "tap_element") return { ...textResult({ tapped: false, reason: "No matching element" }), outcome: { tapped_nothing: true } };
        if (performance.now() >= deadline) break;
        await this.delay(250, signal);
      } while (performance.now() < deadline);
      return textResult({ found: false });
    }
    if (["tap", "long_press", "swipe"].includes(op)) {
      await this.geometry(signal);
      if (op === "tap") {
        const [x, y] = mapPoint(this.view, request.x, request.y);
        await this.shell(`input tap ${x} ${y}`, signal);
      } else {
        const [x, y] = mapPoint(this.view, ...(op === "swipe" ? request.from : [request.x, request.y]));
        const [tx, ty] = op === "swipe" ? mapPoint(this.view, ...request.to) : [x, y];
        const ms = Math.max(1, Math.round((request.seconds ?? (op === "swipe" ? 0.3 : 1)) * 1000));
        await this.shell(`input swipe ${x} ${y} ${tx} ${ty} ${ms}`, signal, ms + 3000);
      }
    } else if (op === "type_text") {
      if (!this.controller) throw new Error("Android Unicode input is not ready");
      signal.throwIfAborted();
      // Clipboard+paste handles Unicode, unlike Android's `input text` key mapping.
      await this.controller.setClipboard({ sequence: this.sequence++, content: request.text, paste: true });
      signal.throwIfAborted();
      if (request.submit) await this.key(66, signal);
    } else if (op === "press_button") {
      const code = { home: 3, back: 4, volume_up: 24, volume_down: 25, lock: 223 }[request.button];
      if (!code) throw new Error("Unsupported Android button");
      await this.key(code, signal);
    } else if (op === "list_apps") {
      return textResult(await this.shell(`pm list packages ${request.include_system ? "" : "-3"}`, signal, 5000));
    } else if (op === "launch_app") {
      if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/.test(request.app)) throw new Error("Use an installed Android package ID from list_apps");
      const component = (await this.shell(`cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER ${quote(request.app)}`, signal, 5000)).trim().split("\n").at(-1);
      if (!/^[\w.$]+\/[\w.$]+$/.test(component || "")) throw new Error("App has no launchable activity");
      const output = await this.shell(`am start -W -n ${quote(component)}`, signal, 10000);
      if (/Error:|Exception|Status:\s*(?!ok)\w+/i.test(output)) throw new Error("Android could not launch this app");
    } else if (op === "terminate_app") {
      if (!/^[\w.]+$/.test(request.app)) throw new Error("Invalid Android package ID");
      await this.shell(`am force-stop ${quote(request.app)}`, signal);
    } else if (op === "open_url") {
      if (!/^(https?:|tel:|sms:|mailto:)/i.test(request.url)) throw new Error("Unsupported URL scheme");
      const output = await this.shell(`am start -W -a android.intent.action.VIEW -d ${quote(request.url)}`, signal, 10000);
      if (/Error:|Exception/i.test(output)) throw new Error("Android could not open this URL");
    } else throw new Error(`Unsupported Android operation: ${op}`);
    await this.delay(180, signal);
    return textResult({ ok: true });
  }
}
