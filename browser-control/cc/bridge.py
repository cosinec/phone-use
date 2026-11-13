#!/usr/bin/env python3
"""Local, bounded HTTP-to-Claude bridge over an explicitly selected Unix socket."""

import argparse
import asyncio
import base64
import binascii
import errno
import json
import os
from pathlib import Path
import re
import signal
import socket
import stat
import sys

MAX_REQUEST = 16 * 1024 * 1024
MAX_OUTPUT = 1024 * 1024
MAX_HEADERS = 16 * 1024
TIMEOUT = 90


class BridgeError(Exception):
    def __init__(self, status, message):
        self.status = status
        self.message = message
        super().__init__(message)


def translate_plan(body):
    try:
        plan = json.loads(body)
    except (ValueError, UnicodeError):
        raise BridgeError(400, "Invalid JSON request") from None
    if not isinstance(plan, dict):
        raise BridgeError(400, "Expected a plan object")
    model, system, content = (plan.get(k) for k in ("model", "system", "content"))
    if not isinstance(model, str) or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}", model):
        raise BridgeError(400, "Invalid model")
    if not isinstance(system, str) or "\x00" in system:
        raise BridgeError(400, "Invalid system prompt")
    if not isinstance(content, list) or not content:
        raise BridgeError(400, "Expected nonempty content")
    blocks = []
    for block in content:
        if not isinstance(block, dict):
            raise BridgeError(400, "Invalid content block")
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            blocks.append({"type": "text", "text": block["text"]})
        elif block.get("type") == "image_url":
            image = block.get("image_url")
            url = image.get("url") if isinstance(image, dict) else None
            match = re.fullmatch(r"data:(image/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]*={0,2})", url) if isinstance(url, str) else None
            if not match:
                raise BridgeError(400, "Expected a supported base64 image data URL")
            try:
                decoded = base64.b64decode(match[2], validate=True)
            except (ValueError, binascii.Error):
                raise BridgeError(400, "Invalid base64 image") from None
            if not decoded:
                raise BridgeError(400, "Empty image")
            blocks.append({"type": "image", "source": {
                "type": "base64", "media_type": match[1], "data": match[2]}})
        else:
            raise BridgeError(400, "Unsupported content block")
    return model, system, blocks


def parse_result(output):
    try:
        events = [json.loads(line) for line in output.splitlines() if line.strip()]
        envelope = next(event for event in reversed(events) if isinstance(event, dict) and event.get("type") == "result")
        if envelope.get("is_error") or envelope.get("subtype", "success") != "success":
            raise ValueError
        text = envelope["result"]
        if not isinstance(text, str):
            raise ValueError
        text = text.strip()
        fenced = re.fullmatch(r"```(?:json)?\s*\n(.*?)\n```", text, re.DOTALL)
        if fenced:
            text = fenced[1]
        reply = json.loads(text)
        if not isinstance(reply, dict):
            raise ValueError
        return {"reply": reply}
    except (ValueError, KeyError, TypeError, UnicodeError, StopIteration):
        raise BridgeError(502, "Invalid Claude response") from None


async def read_request(reader):
    try:
        header = await reader.readuntil(b"\r\n\r\n")
    except asyncio.LimitOverrunError:
        raise BridgeError(431, "Request headers too large") from None
    except asyncio.IncompleteReadError:
        raise BridgeError(400, "Incomplete request") from None
    if len(header) > MAX_HEADERS:
        raise BridgeError(431, "Request headers too large")
    try:
        lines = header[:-4].decode("ascii").split("\r\n")
        method, target, version = lines[0].split(" ")
        if version not in ("HTTP/1.0", "HTTP/1.1"):
            raise ValueError
        headers = {}
        for line in lines[1:]:
            key, value = line.split(":", 1)
            if not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", key):
                raise ValueError
            key = key.lower()
            if key in headers:
                raise ValueError
            headers[key] = value.strip()
        if "transfer-encoding" in headers or "expect" in headers:
            raise ValueError
        length = headers.get("content-length", "0")
        if not re.fullmatch(r"[0-9]{1,10}", length):
            raise ValueError
        length = int(length)
    except ValueError:
        raise BridgeError(400, "Invalid HTTP request") from None
    if length > MAX_REQUEST:
        raise BridgeError(413, "Request body too large")
    if method == "POST" and "content-length" not in headers:
        raise BridgeError(411, "Content-Length required")
    try:
        body = await reader.readexactly(length)
    except asyncio.IncompleteReadError:
        raise BridgeError(400, "Incomplete request body") from None
    return method, target, body


class Bridge:
    def __init__(self, claude_bin, work_dir, timeout=TIMEOUT):
        self.claude_bin = claude_bin
        self.work_dir = str(work_dir)
        self.timeout = timeout
        self.active = 0
        self.handlers = set()

    async def plan(self, body, reader):
        model, system, blocks = translate_plan(body)
        if self.active >= 2:
            raise BridgeError(503, "Bridge is busy")
        self.active += 1
        proc = None
        tasks = []
        try:
            env = os.environ.copy()
            env.pop("CLAUDECODE", None)
            env.pop("CLAUDE_CODE_ENTRYPOINT", None)
            command = [self.claude_bin, "-p", "--input-format", "stream-json",
                       "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config",
                       "--mcp-config", '{"mcpServers":{}}', "--setting-sources", "",
                       "--disable-slash-commands", "--no-session-persistence", "--safe-mode",
                       "--permission-mode", "dontAsk", "--system-prompt", system,
                       "--model", model, "--settings", '{"disableAllHooks":true}']
            try:
                proc = await asyncio.create_subprocess_exec(
                    *command, cwd=self.work_dir, env=env, start_new_session=True,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE)
            except (OSError, ValueError):
                raise BridgeError(502, "Could not start Claude") from None
            used = 0

            async def drain(stream, retain):
                nonlocal used
                chunks = []
                while True:
                    chunk = await stream.read(65536)
                    if not chunk:
                        break
                    used += len(chunk)
                    if used > MAX_OUTPUT:
                        raise BridgeError(502, "Claude output exceeded limit")
                    if retain:
                        chunks.append(chunk)
                return b"".join(chunks)

            async def exchange():
                outgoing = {"type": "user", "message": {"role": "user", "content": blocks}}
                proc.stdin.write((json.dumps(outgoing) + "\n").encode())
                try:
                    await proc.stdin.drain()
                except (BrokenPipeError, ConnectionResetError):
                    pass
                finally:
                    proc.stdin.close()
                stdout, _ = await asyncio.gather(drain(proc.stdout, True), drain(proc.stderr, False))
                await proc.wait()
                if proc.returncode != 0:
                    raise BridgeError(502, "Claude execution failed")
                return parse_result(stdout)

            # Additional data is also rejected: each connection carries one request.
            work = asyncio.create_task(exchange())
            disconnected = asyncio.create_task(reader.read(1))
            tasks = [work, disconnected]
            done, _ = await asyncio.wait(tasks, timeout=self.timeout, return_when=asyncio.FIRST_COMPLETED)
            if disconnected in done:
                raise BridgeError(499, "Client disconnected")
            if work not in done:
                raise BridgeError(504, "Claude request timed out")
            return work.result()
        finally:
            if proc is not None:
                # Kill descendants even when the CLI leader has already exited.
                try:
                    os.killpg(proc.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                await proc.wait()
            for task in tasks:
                task.cancel()
            if tasks:
                await asyncio.gather(*tasks, return_exceptions=True)
            self.active -= 1

    async def handle(self, reader, writer):
        task = asyncio.current_task()
        self.handlers.add(task)
        try:
            try:
                method, target, body = await asyncio.wait_for(read_request(reader), 15)
                if method == "GET" and target == "/health":
                    status, response = 200, {"ok": True}
                elif method == "POST" and target == "/plan":
                    response = await self.plan(body, reader)
                    status = 200
                else:
                    raise BridgeError(404, "Not found")
            except BridgeError as exc:
                status, response = exc.status, {"error": exc.message}
            except asyncio.TimeoutError:
                status, response = 408, {"error": "Request timed out"}
            except (ConnectionError, OSError):
                return
            except Exception:
                status, response = 500, {"error": "Internal bridge error"}
            payload = json.dumps(response, ensure_ascii=True).encode()
            writer.write((f"HTTP/1.1 {status} Response\r\nContent-Type: application/json\r\n"
                          f"Content-Length: {len(payload)}\r\nConnection: close\r\n\r\n").encode() + payload)
            await writer.drain()
        except (ConnectionError, OSError):
            pass
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass
            self.handlers.discard(task)


def prepare_socket(path):
    path = Path(path)
    if not path.is_absolute() or not path.parent.is_dir():
        raise ValueError("Socket requires an absolute path in an existing runtime directory")
    try:
        original = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(original.st_mode):
        raise ValueError("Refusing an existing non-socket path")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as probe:
        probe.settimeout(1)
        try:
            probe.connect(str(path))
        except OSError as exc:
            if exc.errno != errno.ECONNREFUSED:
                raise ValueError("Cannot verify that the existing socket is stale") from None
        else:
            raise ValueError("Socket is already in use")
    current = path.lstat()
    if (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
        raise ValueError("Socket path changed during startup")
    path.unlink()


async def serve(args):
    work_dir = Path(args.work_dir)
    if not work_dir.is_absolute():
        raise ValueError("Work directory must be absolute")
    work_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
    if work_dir.is_symlink() or not work_dir.is_dir() or any(work_dir.iterdir()):
        raise ValueError("Work directory must be a dedicated empty directory")
    prepare_socket(args.socket)
    bridge = Bridge(args.claude_bin, work_dir)
    # Bind synchronously so no client can connect before permissions are restricted.
    listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    identity = None
    server = None
    try:
        old_umask = os.umask(0o177)
        try:
            listener.bind(args.socket)
        finally:
            os.umask(old_umask)
        identity = os.lstat(args.socket)
        os.chmod(args.socket, 0o600)
        listener.listen(16)
        listener.setblocking(False)
        server = await asyncio.start_unix_server(bridge.handle, sock=listener, limit=MAX_HEADERS)
        stop = asyncio.Event()
        loop = asyncio.get_running_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, stop.set)
        await stop.wait()
    finally:
        if server is not None:
            server.close()
            await server.wait_closed()
        listener.close()
        pending = list(bridge.handlers)
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if identity is not None:
            try:
                current = os.lstat(args.socket)
                if (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
                    os.unlink(args.socket)
            except FileNotFoundError:
                pass


def check_health(path):
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
        client.settimeout(3)
        client.connect(path)
        client.sendall(b"GET /health HTTP/1.1\r\nHost: localhost\r\n\r\n")
        data = bytearray()
        while True:
            chunk = client.recv(4096)
            if not chunk:
                break
            data.extend(chunk)
            if len(data) > MAX_HEADERS:
                return False
    header, body = bytes(data).split(b"\r\n\r\n", 1)
    return header.startswith(b"HTTP/1.1 200 ") and json.loads(body) == {"ok": True}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--socket", required=True, help="Absolute Unix socket in an existing runtime directory")
    parser.add_argument("--claude-bin", default="claude")
    parser.add_argument("--work-dir", help="Dedicated empty absolute working directory (required unless --check)")
    parser.add_argument("--check", action="store_true", help="Check an already running bridge and exit")
    args = parser.parse_args()
    if not args.check and not args.work_dir:
        parser.error("--work-dir is required unless --check is used")
    try:
        if args.check:
            if not check_health(args.socket):
                raise ValueError
            print('{"ok":true}')
        else:
            asyncio.run(serve(args))
    except (OSError, ValueError, KeyboardInterrupt):
        print("Bridge operation failed; check socket, executable and clean work directory", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
