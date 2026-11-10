import { defineConfig } from "vite";
export default defineConfig({
  plugins: [
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
