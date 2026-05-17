from __future__ import annotations

import os
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Mapping


APP_PREFIX = "MANUAL_AGENT_"


@dataclass(frozen=True)
class OpenAiCompatibleSettings:
    api_key: str
    base_url: str
    model: str
    dep_ticket: str
    send_system_name: str
    user_id: str
    user_type: str

    @property
    def is_configured(self) -> bool:
        return all(
            [
                self.api_key,
                self.base_url,
                self.model,
                self.dep_ticket,
                self.send_system_name,
                self.user_id,
                self.user_type,
            ]
        )

    def default_headers(self) -> dict[str, str]:
        return {
            "x-dep-ticket": self.dep_ticket,
            "Send-System-Name": self.send_system_name,
            "User-Id": self.user_id,
            "User-Type": self.user_type,
            "Prompt-Msg-Id": str(uuid.uuid4()),
            "Completion-Msg-Id": str(uuid.uuid4()),
        }

    def safe_status(self) -> dict[str, bool | str]:
        return {
            "configured": self.is_configured,
            "base_url_set": bool(self.base_url),
            "model": self.model,
            "dep_ticket_set": bool(self.dep_ticket),
            "api_key_set": bool(self.api_key),
            "send_system_name_set": bool(self.send_system_name),
            "user_id_set": bool(self.user_id),
            "user_type": self.user_type,
        }


@dataclass(frozen=True)
class RagSettings:
    insert_url: str
    retrieve_url: str
    delete_url: str
    dep_ticket: str
    api_key: str
    index_name: str
    permission_groups: list[str]

    @property
    def is_configured(self) -> bool:
        return all([self.retrieve_url, self.dep_ticket, self.api_key, self.index_name])

    def safe_status(self) -> dict[str, bool | str | list[str]]:
        return {
            "configured": self.is_configured,
            "insert_url_set": bool(self.insert_url),
            "retrieve_url_set": bool(self.retrieve_url),
            "delete_url_set": bool(self.delete_url),
            "api_key_set": bool(self.api_key),
            "dep_ticket_set": bool(self.dep_ticket),
            "index_name": self.index_name,
            "permission_groups": self.permission_groups,
        }


@dataclass(frozen=True)
class RerankerSettings:
    url: str
    model: str
    dep_ticket: str

    @property
    def is_configured(self) -> bool:
        return all([self.url, self.model, self.dep_ticket])

    def safe_status(self) -> dict[str, bool | str]:
        return {
            "configured": self.is_configured,
            "url_set": bool(self.url),
            "model": self.model,
            "dep_ticket_set": bool(self.dep_ticket),
        }


@dataclass(frozen=True)
class AppSettings:
    llm: OpenAiCompatibleSettings
    vlm: OpenAiCompatibleSettings
    rag: RagSettings
    reranker: RerankerSettings
    output_dir: str
    enable_internal_planner: bool
    enable_rag_context: bool
    enable_reranker: bool
    playwright_mcp_mode: str
    playwright_mcp_command: str
    tts_provider: str
    tts_device: str
    tts_language: str
    tts_speaker: str
    tts_speed: float
    video_renderer: str
    hyperframes_command: str
    enable_hyperframes_skills: bool
    hyperframes_skills_command: str
    enable_opencode: bool
    opencode_command: str
    opencode_agent: str
    opencode_model: str
    opencode_timeout_seconds: float
    request_timeout_seconds: float

    def safe_status(self) -> dict[str, object]:
        return {
            "llm": self.llm.safe_status(),
            "vlm": self.vlm.safe_status(),
            "rag": self.rag.safe_status(),
            "reranker": self.reranker.safe_status(),
            "runtime": {
                "output_dir": self.output_dir,
                "enable_internal_planner": self.enable_internal_planner,
                "enable_rag_context": self.enable_rag_context,
                "enable_reranker": self.enable_reranker,
                "playwright_mcp_mode": self.playwright_mcp_mode,
                "playwright_mcp_command_set": bool(self.playwright_mcp_command),
                "tts_provider": self.tts_provider,
                "tts_device": self.tts_device,
                "tts_language": self.tts_language,
                "tts_speaker": self.tts_speaker,
                "tts_speed": self.tts_speed,
                "video_renderer": self.video_renderer,
                "hyperframes_command_set": bool(self.hyperframes_command),
                "enable_hyperframes_skills": self.enable_hyperframes_skills,
                "hyperframes_skills_command_set": bool(self.hyperframes_skills_command),
                "enable_opencode": self.enable_opencode,
                "opencode_command_set": bool(self.opencode_command),
                "opencode_agent": self.opencode_agent,
                "opencode_model": self.opencode_model,
                "opencode_timeout_seconds": self.opencode_timeout_seconds,
                "request_timeout_seconds": self.request_timeout_seconds,
            },
        }


def load_settings(
    *,
    env_file: Path | None = None,
    environ: Mapping[str, str] | None = None,
) -> AppSettings:
    env = dict(os.environ if environ is None else environ)
    dot_env_path = Path(".env") if env_file is None else env_file
    env.update(parse_env_file(dot_env_path))

    dep_ticket = _get(env, "DEP_TICKET")
    send_system_name = _get(env, "SEND_SYSTEM_NAME", "manual-video-agent")
    user_id = _get(env, "USER_ID")
    user_type = _get(env, "USER_TYPE", "AD_ID")
    openai_api_key = _get(env, "OPENAI_API_KEY")

    llm = OpenAiCompatibleSettings(
        api_key=openai_api_key,
        base_url=_get(env, "LLM_BASE_URL"),
        model=_get(env, "LLM_MODEL", "QWEN3"),
        dep_ticket=dep_ticket,
        send_system_name=send_system_name,
        user_id=user_id,
        user_type=user_type,
    )
    vlm = OpenAiCompatibleSettings(
        api_key=_get(env, "VLM_API_KEY", openai_api_key),
        base_url=_get(env, "VLM_BASE_URL"),
        model=_get(env, "VLM_MODEL", "QWEN3-VL"),
        dep_ticket=_get(env, "VLM_DEP_TICKET", dep_ticket),
        send_system_name=_get(env, "VLM_SEND_SYSTEM_NAME", send_system_name),
        user_id=_get(env, "VLM_USER_ID", user_id),
        user_type=_get(env, "VLM_USER_TYPE", user_type),
    )
    rag = RagSettings(
        insert_url=_get(env, "RAG_INSERT_URL"),
        retrieve_url=_get(env, "RAG_RETRIEVE_URL"),
        delete_url=_get(env, "RAG_DELETE_URL"),
        dep_ticket=_get(env, "RAG_DEP_TICKET", dep_ticket),
        api_key=_get(env, "RAG_API_KEY"),
        index_name=_get(env, "RAG_INDEX_NAME"),
        permission_groups=_split_csv(_get(env, "RAG_PERMISSION_GROUPS", "rag-public")),
    )
    reranker = RerankerSettings(
        url=_get(env, "RERANKER_URL"),
        model=_get(env, "RERANKER_MODEL", "bge-reranker-v2-m3-ko"),
        dep_ticket=_get(env, "RERANKER_DEP_TICKET", dep_ticket),
    )
    return AppSettings(
        llm=llm,
        vlm=vlm,
        rag=rag,
        reranker=reranker,
        output_dir=_get(env, "OUTPUT_DIR", "output"),
        enable_internal_planner=_get_bool(env, "ENABLE_INTERNAL_PLANNER", False),
        enable_rag_context=_get_bool(env, "ENABLE_RAG_CONTEXT", False),
        enable_reranker=_get_bool(env, "ENABLE_RERANKER", False),
        playwright_mcp_mode=_get(env, "PLAYWRIGHT_MCP_MODE", "manifest"),
        playwright_mcp_command=_get(env, "PLAYWRIGHT_MCP_COMMAND", "npx @playwright/mcp@latest --headless"),
        tts_provider=_get(env, "TTS_PROVIDER", "fake-melotts-compatible"),
        tts_device=_get(env, "TTS_DEVICE", "cpu"),
        tts_language=_get(env, "TTS_LANGUAGE", "KR"),
        tts_speaker=_get(env, "TTS_SPEAKER", "KR"),
        tts_speed=_get_float(env, "TTS_SPEED", 1.0),
        video_renderer=_get(env, "VIDEO_RENDERER", "playwright-webm"),
        hyperframes_command=_get(env, "HYPERFRAMES_COMMAND", "npx hyperframes render"),
        enable_hyperframes_skills=_get_bool(env, "ENABLE_HYPERFRAMES_SKILLS", False),
        hyperframes_skills_command=_get(env, "HYPERFRAMES_SKILLS_COMMAND", "npx hyperframes skills --codex"),
        enable_opencode=_get_bool(env, "ENABLE_OPENCODE", False),
        opencode_command=_get(env, "OPENCODE_COMMAND", "opencode run --format json"),
        opencode_agent=_get(env, "OPENCODE_AGENT"),
        opencode_model=_get(env, "OPENCODE_MODEL"),
        opencode_timeout_seconds=_get_float(env, "OPENCODE_TIMEOUT_SECONDS", 600.0),
        request_timeout_seconds=_get_float(env, "REQUEST_TIMEOUT_SECONDS", 30.0),
    )


def parse_env_file(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}

    values: dict[str, str] = {}
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key:
            values[key] = value
    return values


def _get(env: Mapping[str, str], suffix: str, default: str = "") -> str:
    return env.get(f"{APP_PREFIX}{suffix}", default).strip()


def _get_bool(env: Mapping[str, str], suffix: str, default: bool) -> bool:
    value = _get(env, suffix)
    if not value:
        return default
    return value.lower() in {"1", "true", "yes", "on", "y"}


def _get_float(env: Mapping[str, str], suffix: str, default: float) -> float:
    value = _get(env, suffix)
    if not value:
        return default
    try:
        return float(value)
    except ValueError:
        return default


def _split_csv(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]
