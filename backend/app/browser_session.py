from __future__ import annotations

import ipaddress
import os
import socket
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable
from urllib.parse import urlsplit
from urllib.request import ProxyHandler, build_opener

from backend.app.env_bootstrap import discover_browser_executable


ProcessFactory = Callable[..., Any]
ReadinessProbe = Callable[[str], bool]
PortAllocator = Callable[[], int]
ExecutableResolver = Callable[..., Path | None]
ProcessTreeTerminator = Callable[[Any], None]


class BrowserSessionError(RuntimeError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class BrowserSession:
    cdp_endpoint: str
    owned: bool
    pid: int | None
    profile_path: Path | None
    browser_channel: str
    executable_path: Path | None

    def to_safe_dict(self) -> dict[str, object]:
        return {
            "cdp_endpoint": self.cdp_endpoint,
            "owned": self.owned,
            "pid": self.pid,
            "profile_path": str(self.profile_path) if self.profile_path else "",
            "browser_channel": self.browser_channel,
            "executable_path": str(self.executable_path) if self.executable_path else "",
        }


class BrowserSessionManager:
    def __init__(
        self,
        settings: Any,
        *,
        process_factory: ProcessFactory = subprocess.Popen,
        readiness_probe: ReadinessProbe | None = None,
        port_allocator: PortAllocator | None = None,
        executable_resolver: ExecutableResolver = discover_browser_executable,
        process_tree_terminator: ProcessTreeTerminator | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
        startup_timeout_seconds: float | None = None,
    ) -> None:
        self.settings = settings
        self.process_factory = process_factory
        self.readiness_probe = readiness_probe or _probe_cdp
        self.port_allocator = port_allocator or _allocate_loopback_port
        self.executable_resolver = executable_resolver
        self.process_tree_terminator = process_tree_terminator or _terminate_process_tree
        self.sleep = sleep
        self.clock = clock
        configured_timeout = float(getattr(settings, "request_timeout_seconds", 20.0) or 20.0)
        self.startup_timeout_seconds = (
            max(0.1, configured_timeout)
            if startup_timeout_seconds is None
            else max(0.0, startup_timeout_seconds)
        )
        self._process: Any | None = None
        self._session: BrowserSession | None = None
        self._profile_lock_path: Path | None = None
        self._owns_profile_lock = False

    def __enter__(self) -> BrowserSession:
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> bool:
        self.close()
        return False

    def start(self) -> BrowserSession:
        if self._session is not None:
            return self._session
        if _browser_runner_mode(self.settings) == "cdp_attach":
            endpoint = str(getattr(self.settings, "cdp_endpoint", "") or "").strip()
            _require_loopback_endpoint(endpoint)
            if not self.readiness_probe(endpoint):
                raise BrowserSessionError("cdp_unavailable", "Configured CDP endpoint is not ready")
            self._session = BrowserSession(
                cdp_endpoint=endpoint,
                owned=False,
                pid=None,
                profile_path=None,
                browser_channel="attached",
                executable_path=None,
            )
            return self._session

        login = getattr(self.settings, "login", None)
        channel = str(getattr(login, "browser_channel", "") or "msedge").strip().lower()
        configured_executable = str(getattr(self.settings, "playwright_executable_path", "") or "").strip()
        executable = self.executable_resolver(channel, configured_path=configured_executable)
        if executable is None:
            raise BrowserSessionError(
                "browser_executable_missing",
                f"No executable was found for browser channel {channel}",
            )

        profile_value = str(getattr(login, "sso_profile_dir", "") or "").strip()
        if not profile_value:
            profile_value = str(Path("runtime") / "browser-profile")
        profile_path = Path(profile_value).expanduser().resolve()
        profile_path.mkdir(parents=True, exist_ok=True)
        self._acquire_profile_lock(profile_path)

        endpoint = ""
        try:
            port = int(self.port_allocator())
            endpoint = f"http://127.0.0.1:{port}"
            _require_loopback_endpoint(endpoint)
            command = _build_edge_command(
                executable=executable,
                profile_path=profile_path,
                port=port,
                login=login,
            )
            self._process = self.process_factory(
                command,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                close_fds=True,
            )
            self._write_lock_owner(getattr(self._process, "pid", None))
            self._wait_until_ready(endpoint)
            self._session = BrowserSession(
                cdp_endpoint=endpoint,
                owned=True,
                pid=getattr(self._process, "pid", None),
                profile_path=profile_path,
                browser_channel=channel,
                executable_path=Path(executable),
            )
            return self._session
        except BrowserSessionError:
            self.close()
            raise
        except OSError as exc:
            self.close()
            raise BrowserSessionError("browser_launch_failed", "Browser process could not be launched") from exc
        except Exception:
            self.close()
            raise

    def close(self) -> None:
        process, self._process = self._process, None
        session, self._session = self._session, None
        if process is not None and (session is None or session.owned):
            try:
                self.process_tree_terminator(process)
            finally:
                self._release_profile_lock()
        else:
            self._release_profile_lock()

    def _acquire_profile_lock(self, profile_path: Path) -> None:
        lock_path = profile_path / ".manual-agent-cdp.lock"
        try:
            with lock_path.open("x", encoding="utf-8") as handle:
                handle.write("starting\n")
        except FileExistsError as exc:
            raise BrowserSessionError("profile_locked", "Browser profile is already in use") from exc
        self._profile_lock_path = lock_path
        self._owns_profile_lock = True

    def _write_lock_owner(self, pid: int | None) -> None:
        if self._owns_profile_lock and self._profile_lock_path is not None:
            self._profile_lock_path.write_text(f"pid={pid or ''}\n", encoding="utf-8")

    def _release_profile_lock(self) -> None:
        if self._owns_profile_lock and self._profile_lock_path is not None:
            try:
                self._profile_lock_path.unlink(missing_ok=True)
            finally:
                self._owns_profile_lock = False
                self._profile_lock_path = None

    def _wait_until_ready(self, endpoint: str) -> None:
        deadline = self.clock() + self.startup_timeout_seconds
        while True:
            if self._process is not None and self._process.poll() is not None:
                raise BrowserSessionError(
                    "browser_process_exited",
                    "Browser process exited before the CDP endpoint became ready",
                )
            if self.readiness_probe(endpoint):
                return
            if self.clock() >= deadline:
                raise BrowserSessionError(
                    "cdp_start_timeout",
                    "Browser CDP endpoint did not become ready before the timeout",
                )
            self.sleep(0.2)


def _browser_runner_mode(settings: Any) -> str:
    value = str(getattr(settings, "browser_runner", "playwright") or "playwright")
    normalized = value.strip().lower().replace("-", "_")
    return "cdp_attach" if normalized in {"cdp", "cdp_attach", "attach"} else "launch"


def _require_loopback_endpoint(endpoint: str) -> None:
    try:
        parsed = urlsplit(endpoint)
        port = parsed.port
    except ValueError as exc:
        raise BrowserSessionError("invalid_cdp_endpoint", "CDP endpoint is invalid") from exc
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        raise BrowserSessionError("invalid_cdp_endpoint", "CDP endpoint is invalid")
    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost":
        return
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError as exc:
        raise BrowserSessionError(
            "non_loopback_cdp_endpoint",
            "CDP endpoint must use a loopback address",
        ) from exc
    if not address.is_loopback:
        raise BrowserSessionError(
            "non_loopback_cdp_endpoint",
            "CDP endpoint must use a loopback address",
        )
    if port is not None and not (1 <= port <= 65535):
        raise BrowserSessionError("invalid_cdp_endpoint", "CDP endpoint port is invalid")


def _build_edge_command(*, executable: Path, profile_path: Path, port: int, login: Any) -> list[str]:
    command = [
        str(executable),
        f"--remote-debugging-port={port}",
        "--remote-debugging-address=127.0.0.1",
        f"--user-data-dir={profile_path}",
        "--no-first-run",
        "--no-default-browser-check",
        "--edge-skip-compat-layer-relaunch",
        "--new-window",
        "about:blank",
    ]
    auth_allowlist = str(getattr(login, "auth_server_allowlist", "") or "").strip()
    delegate_allowlist = str(
        getattr(login, "auth_negotiate_delegate_allowlist", "") or ""
    ).strip()
    if auth_allowlist:
        command.insert(-1, f"--auth-server-allowlist={auth_allowlist}")
    if delegate_allowlist:
        command.insert(-1, f"--auth-negotiate-delegate-allowlist={delegate_allowlist}")
    return command


def _allocate_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _probe_cdp(endpoint: str) -> bool:
    opener = build_opener(ProxyHandler({}))
    try:
        with opener.open(f"{endpoint.rstrip('/')}/json/version", timeout=0.75) as response:
            return 200 <= int(response.status) < 300
    except Exception:
        return False


def _terminate_process_tree(process: Any) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt" and getattr(process, "pid", None):
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            check=False,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        return
    process.terminate()
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
