from __future__ import annotations

import json
import queue
import shlex
import shutil
import subprocess
import threading
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


@dataclass
class StdioMcpClient:
    command: str
    timeout_seconds: float = 30.0
    cwd: Path | None = None
    process: subprocess.Popen | None = field(default=None, init=False)
    _next_id: int = field(default=1, init=False)
    _stdout_queue: queue.Queue[str] = field(default_factory=queue.Queue, init=False)

    def __enter__(self) -> "StdioMcpClient":
        self.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()

    def start(self) -> None:
        args = shlex.split(self.command, posix=False)
        if not args:
            raise ValueError("MCP command is empty")
        resolved = shutil.which(args[0])
        if resolved:
            args[0] = resolved
        self.process = subprocess.Popen(
            args,
            cwd=str(self.cwd) if self.cwd else None,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        if self.process.stdout is None:
            raise RuntimeError("MCP process stdout is not available")
        thread = threading.Thread(target=self._read_stdout, args=(self.process.stdout,), daemon=True)
        thread.start()

    def initialize(self) -> dict[str, Any]:
        response = self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "manual-video-agent", "version": "0.1.0"},
            },
        )
        self.notify("notifications/initialized", {})
        return response

    def list_tools(self) -> set[str]:
        response = self.request("tools/list", {})
        tools = response.get("tools", []) if isinstance(response, dict) else []
        return {tool["name"] for tool in tools if isinstance(tool, dict) and tool.get("name")}

    def call_tool(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        return self.request("tools/call", {"name": name, "arguments": arguments})

    def request(self, method: str, params: dict[str, Any] | None = None) -> dict[str, Any]:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("MCP process is not started")
        request_id = self._next_id
        self._next_id += 1
        message = {"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}}
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

        while True:
            line = self._stdout_queue.get(timeout=self.timeout_seconds)
            if not line.strip():
                continue
            payload = json.loads(line)
            if payload.get("id") != request_id:
                continue
            if "error" in payload:
                raise RuntimeError(f"MCP {method} failed: {payload['error']}")
            result = payload.get("result", {})
            return result if isinstance(result, dict) else {"result": result}

    def notify(self, method: str, params: dict[str, Any] | None = None) -> None:
        if self.process is None or self.process.stdin is None:
            raise RuntimeError("MCP process is not started")
        message = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        self.process.stdin.write(json.dumps(message, ensure_ascii=False) + "\n")
        self.process.stdin.flush()

    def close(self) -> None:
        if self.process is None:
            return
        if self.process.poll() is None:
            self.process.terminate()
            try:
                self.process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                self.process.kill()
        self.process = None

    def _read_stdout(self, stdout: Any) -> None:
        for line in stdout:
            self._stdout_queue.put(line)
