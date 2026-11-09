import path from "node:path";
import { realpath, readFile, stat } from "node:fs/promises";
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};
export function createStaticFiles(directory) {
  const root = path.resolve(directory);
  return async (request, response) => {
    if (!["GET", "HEAD"].includes(request.method)) return false;
    let pathname;
    try {
      pathname = decodeURIComponent(
        new URL(request.url, "http://static").pathname,
      );
    } catch {
      return false;
    }
    if (
      pathname === "/api" ||
      pathname.startsWith("/api/") ||
      pathname.startsWith("/ios/") ||
      pathname.includes("\0") ||
      pathname.includes("\\") ||
      pathname.split("/").some((part) => part === ".." || part.startsWith("."))
    )
      return false;
    const candidate = path.resolve(root, "." + pathname);
    if (candidate !== root && !candidate.startsWith(root + path.sep))
      return false;
    let file;
    try {
      const info = await stat(candidate);
      file = info.isFile()
        ? candidate
        : pathname === "/"
          ? path.join(root, "index.html")
          : null;
    } catch (error) {
      if (error.code !== "ENOENT") return false;
      if (path.extname(pathname) || pathname.startsWith("/assets/"))
        return false;
      file = path.join(root, "index.html");
    }
    if (!file) return false;
    try {
      const [resolvedRoot, resolvedFile] = await Promise.all([
        realpath(root),
        realpath(file),
      ]);
      if (!resolvedFile.startsWith(resolvedRoot + path.sep)) return false;
      const data = await readFile(resolvedFile);
      response.writeHead(200, {
        "Content-Type": types[path.extname(file)] || "application/octet-stream",
        "Content-Length": data.length,
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
      });
      response.end(request.method === "HEAD" ? undefined : data);
      return true;
    } catch {
      return false;
    }
  };
}
