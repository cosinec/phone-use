import { defineConfig } from "vite";

// @limrun/device-install 0.1.0（0.3.0 也一样）发数据时不看手机 usbmux 通告的接收窗口，
// 也不处理手机回的纯 ACK。守护进程上传 WDA 时 AFC 一次写 1 MiB，SDK 一口气发出去，
// 超过手机约 128 KB 的窗口，手机回 RST，守护进程读到 early eof（「device socket io failed」）。
// 这里按 usbmuxd 的做法补上发送窗口：记下手机 ACK 的序号和窗口（th_win << 8），
// 未确认字节超过窗口时先等 ACK。锚点对不上就让构建失败，避免补丁悄悄失效。
const SDK_CHUNK = /@limrun[\\/]device-install[\\/]dist[\\/]index-[^\\/]+\.js$/;
const SDK_PATCHES = [
  // TCP 头里的窗口字段
  ["    flags: t.getUint8(13),\n", "    flags: t.getUint8(13),\n    win: t.getUint16(14),\n"],
  // 每条流的发送窗口状态
  [
    "    rejectOpened: r\n  };",
    "    rejectOpened: r,\n    acked: 0,\n    win: 0,\n    winWaiters: []\n  };",
  ],
  // 发数据时按剩余窗口切块，像 TCP 一样只发窗口装得下的部分（超出窗口的数据手机会丢掉、不确认）。
  // 等窗口超过 3 秒打一条日志，便于在 Chrome 控制台里排查
  [
    "  await w(e, f, t), e.seq += t.byteLength;",
    `  for (let o = 0; o < t.byteLength; ) {
    if (e.error) throw e.error;
    if (e.session.closed) throw new Error("usbmux session is closed.");
    const room = e.win - Math.max(0, e.seq - e.acked);
    if (room <= 0) {
      const timer = setTimeout(() => console.warn("[usbmux] waiting for window", { port: e.dport, seq: e.seq, acked: e.acked, win: e.win }), 3e3);
      await new Promise((x) => e.winWaiters.push(x));
      clearTimeout(timer);
      continue;
    }
    const c = t.subarray(o, o + Math.min(room, t.byteLength - o));
    await w(e, f, c), e.seq += c.byteLength, o += c.byteLength;
  }`,
  ],
  // 读循环：带 ACK 的包更新已确认序号和窗口，并唤醒等待者（RST 时等待者会看到 error）
  [
    "      if (r) {\n        if (n.flags & G) {",
    `      if (r) {
        if (n.flags & f) {
          r.win || console.debug("[usbmux] stream window", { port: r.dport, rawWin: n.win, win: n.win << 8 });
          r.acked = n.ack, r.win = n.win << 8;
        }
        r.winWaiters.splice(0).forEach((x) => x());
        if (n.flags & G) {`,
  ],
  // 会话关闭时唤醒等窗口的写
  [
    "      t.waiters.shift()(new Uint8Array());\n  e.streams.clear();",
    "      t.waiters.shift()(new Uint8Array());\n  for (const t of e.streams.values()) t.winWaiters.splice(0).forEach((x) => x());\n  e.streams.clear();",
  ],
];

const usbmuxFlowControl = {
  name: "device-install-usbmux-flow-control",
  enforce: "pre",
  transform(code, id) {
    if (!SDK_CHUNK.test(id.split("?")[0])) return null;
    for (const [from, to] of SDK_PATCHES) {
      const count = code.split(from).length - 1;
      if (count !== 1)
        throw new Error(
          `@limrun/device-install 流控补丁锚点匹配 ${count} 次（应为 1）：${JSON.stringify(from.slice(0, 60))}。SDK 版本变了，需要重新核对补丁`,
        );
      code = code.replace(from, () => to);
    }
    return { code, map: null };
  },
};

export default defineConfig({
  plugins: [
    usbmuxFlowControl,
    {
      name: "android-third-party-notices",
      async generateBundle() {
        const { readFile } = await import("node:fs/promises");
        for (const filename of ["LICENSE", "NOTICE", "TANGO-LICENSE"])
          this.emitFile({
            type: "asset",
            fileName:
              filename === "TANGO-LICENSE"
                ? "licenses/tango-MIT.txt"
                : `licenses/scrcpy-${filename}.txt`,
            source: await readFile(
              new URL(`./web/android/vendor/${filename}`, import.meta.url),
              "utf8",
            ),
          });
      },
    },
  ],
  // 开发模式预打包依赖时不走 transform，排除掉才能让上面的补丁生效
  optimizeDeps: { exclude: ["@limrun/device-install"] },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:8787" },
      "/device": { target: "ws://127.0.0.1:8787", ws: true },
      "/ios": { target: "ws://127.0.0.1:8787", ws: true },
    },
  },
  build: { outDir: "dist", target: "es2022" },
});
