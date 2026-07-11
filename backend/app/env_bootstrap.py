from __future__ import annotations

import os
import platform
import shutil
import subprocess
from pathlib import Path
from typing import Callable, Mapping


WhichResolver = Callable[..., str | None]


def discover_browser_executable(
    channel: str,
    *,
    configured_path: str = "",
    environ: Mapping[str, str] | None = None,
    which: WhichResolver = shutil.which,
) -> Path | None:
    env = os.environ if environ is None else environ
    configured = Path(configured_path).expanduser() if configured_path.strip() else None
    if configured is not None and configured.is_file():
        return configured.resolve()

    normalized = channel.strip().lower() or "msedge"
    executable_names = {
        "msedge": ("msedge.exe", "msedge"),
        "chrome": ("chrome.exe", "chrome"),
        "chromium": ("chromium.exe", "chromium", "chrome.exe"),
    }.get(normalized, (f"{normalized}.exe", normalized))
    for name in executable_names:
        resolved = which(name, path=env.get("PATH"))
        if resolved and Path(resolved).is_file():
            return Path(resolved).resolve()

    candidates: list[Path] = []
    if normalized == "msedge":
        candidates.extend(_environment_file_candidates(env, ("EDGE_PATH", "MSEDGE_PATH")))
        candidates.extend(
            _browser_install_candidates(
                env,
                Path("Microsoft") / "Edge" / "Application" / "msedge.exe",
            )
        )
    elif normalized == "chrome":
        candidates.extend(_environment_file_candidates(env, ("CHROME_PATH",)))
        candidates.extend(
            _browser_install_candidates(
                env,
                Path("Google") / "Chrome" / "Application" / "chrome.exe",
            )
        )
    elif normalized == "chromium":
        candidates.extend(_environment_file_candidates(env, ("CHROMIUM_PATH", "CHROME_PATH")))

    for candidate in candidates:
        if candidate.is_file():
            return candidate.resolve()
    return None


def _environment_file_candidates(env: Mapping[str, str], keys: tuple[str, ...]) -> list[Path]:
    return [Path(value).expanduser() for key in keys if (value := env.get(key, "").strip())]


def _browser_install_candidates(env: Mapping[str, str], suffix: Path) -> list[Path]:
    roots = [
        env.get("PROGRAMFILES", "").strip(),
        env.get("PROGRAMFILES(X86)", "").strip(),
        env.get("LOCALAPPDATA", "").strip(),
    ]
    return [Path(root) / suffix for root in roots if root]


def bundle_root(environ: Mapping[str, str] | None = None) -> Path:
    env = os.environ if environ is None else environ
    configured = env.get("MANUAL_AGENT_BUNDLE_ROOT", "").strip()
    if configured:
        return Path(configured).resolve()
    return Path.cwd().resolve()


def build_runtime_environment(
    *,
    root: Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> dict[str, str]:
    env = dict(os.environ if environ is None else environ)
    base = (root or bundle_root(env)).resolve()
    for key, value in _parse_env_file(base / ".env").items():
        env.setdefault(key, value)
    runtime = base / "runtime"
    updates: dict[str, str] = {
        "MANUAL_AGENT_BUNDLE_ROOT": str(base),
        "HF_HOME": env.get("HF_HOME") or str(runtime / "hf-cache"),
        "NPM_CONFIG_CACHE": env.get("NPM_CONFIG_CACHE") or str(runtime / "npm-cache"),
        "SUPERTONIC_CACHE_DIR": env.get("SUPERTONIC_CACHE_DIR") or str(runtime / "supertonic3"),
    }
    playwright_browsers = env.get("PLAYWRIGHT_BROWSERS_PATH") or ""
    if not playwright_browsers and (runtime / "browsers").exists():
        playwright_browsers = str(runtime / "browsers")
    if playwright_browsers:
        updates["PLAYWRIGHT_BROWSERS_PATH"] = playwright_browsers
    if not env.get("MANUAL_AGENT_OUTPUT_DIR"):
        updates["MANUAL_AGENT_OUTPUT_DIR"] = str(base / "output")

    cert = base / "config" / "corp-root-ca.pem"
    if cert.exists():
        cert_value = str(cert)
        for key in ("REQUESTS_CA_BUNDLE", "SSL_CERT_FILE", "PIP_CERT", "NODE_EXTRA_CA_CERTS"):
            updates.setdefault(key, env.get(key) or cert_value)

    path_entries = [
        runtime / "python",
        runtime / "node",
        runtime / "node" / "bin",
        runtime / "ffmpeg" / "bin",
    ]
    existing_path = env.get("PATH", "")
    updates["PATH"] = os.pathsep.join([str(path) for path in path_entries if path.exists()] + [existing_path])
    return updates


def apply_runtime_environment(*, root: Path | None = None) -> dict[str, str]:
    updates = build_runtime_environment(root=root)
    for key, value in updates.items():
        if key == "PATH":
            os.environ[key] = value
        else:
            os.environ.setdefault(key, value)
    return updates


def runtime_fingerprint(environ: Mapping[str, str] | None = None) -> dict[str, str]:
    env = os.environ if environ is None else environ
    return {
        "bundle_root": str(bundle_root(env)),
        "python_version": platform.python_version(),
        "node_version": _command_version(["node", "--version"], env=env),
        "npm_version": _command_version(["npm", "--version"], env=env),
        "ffmpeg_version": _command_version(["ffmpeg", "-version"], env=env, first_line=True),
        "playwright_browsers_path": env.get("PLAYWRIGHT_BROWSERS_PATH", ""),
        "hf_home": env.get("HF_HOME", ""),
        "npm_config_cache": env.get("NPM_CONFIG_CACHE", ""),
        "supertonic_cache_dir": env.get("SUPERTONIC_CACHE_DIR", ""),
        "requests_ca_bundle_set": str(bool(env.get("REQUESTS_CA_BUNDLE"))).lower(),
        "node_extra_ca_certs_set": str(bool(env.get("NODE_EXTRA_CA_CERTS"))).lower(),
    }


def _command_version(command: list[str], *, env: Mapping[str, str], first_line: bool = False) -> str:
    executable = shutil.which(command[0], path=env.get("PATH"))
    if not executable:
        return "missing"
    try:
        completed = subprocess.run(
            [executable, *command[1:]],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            env=dict(env),
        )
    except (OSError, subprocess.TimeoutExpired):
        return "error"
    output = (completed.stdout or completed.stderr).strip()
    if not output:
        return "unknown"
    return output.splitlines()[0] if first_line else output.splitlines()[-1]


def _parse_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return {key: value for key, value in values.items() if key}
