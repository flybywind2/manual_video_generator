from pathlib import Path

from backend.app.config import load_settings
from backend.app.main import app
from fastapi.testclient import TestClient


def test_load_settings_reads_appendix_env_file(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(
            [
                "MANUAL_AGENT_OPENAI_API_KEY=local-api-key",
                "MANUAL_AGENT_LLM_BASE_URL=http://api.net:8000/v1",
                "MANUAL_AGENT_LLM_MODEL=QWEN3",
                "MANUAL_AGENT_DEP_TICKET=credential:TICKET-123",
                "MANUAL_AGENT_SEND_SYSTEM_NAME=manual-video-agent",
                "MANUAL_AGENT_USER_ID=USER01",
                "MANUAL_AGENT_USER_TYPE=AD_ID",
                "MANUAL_AGENT_VLM_BASE_URL=http://api.net/vl/v1",
                "MANUAL_AGENT_VLM_MODEL=QWEN3-VL",
                "MANUAL_AGENT_RAG_RETRIEVE_URL=http://api.net/elastic/v2/retrieve-rrf",
                "MANUAL_AGENT_RAG_API_KEY=rag-key",
                "MANUAL_AGENT_RAG_INDEX_NAME=manual-video",
                "MANUAL_AGENT_RAG_PERMISSION_GROUPS=rag-public,manual-private",
                "MANUAL_AGENT_RERANKER_URL=http://api.net/reranker/v2/rerank",
                "MANUAL_AGENT_RERANKER_MODEL=bge-reranker-v2-m3-ko",
                "MANUAL_AGENT_ENABLE_INTERNAL_PLANNER=true",
                "MANUAL_AGENT_ENABLE_RAG_CONTEXT=true",
                "MANUAL_AGENT_ENABLE_RERANKER=true",
                "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE=manifest",
                "MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND=npx @playwright/mcp@latest",
                "MANUAL_AGENT_TTS_PROVIDER=melotts",
                "MANUAL_AGENT_TTS_DEVICE=cpu",
                "MANUAL_AGENT_TTS_SPEED=1.1",
                "MANUAL_AGENT_VIDEO_RENDERER=hyperframes",
                "MANUAL_AGENT_HYPERFRAMES_COMMAND=npx hyperframes render",
                "MANUAL_AGENT_ENABLE_HYPERFRAMES_SKILLS=true",
                "MANUAL_AGENT_HYPERFRAMES_SKILLS_COMMAND=npx hyperframes skills --codex",
                "MANUAL_AGENT_ENABLE_OPENCODE=true",
                "MANUAL_AGENT_OPENCODE_COMMAND=opencode run --format json",
                "MANUAL_AGENT_OPENCODE_AGENT=build",
                "MANUAL_AGENT_OPENCODE_MODEL=openai/gpt-5",
                "MANUAL_AGENT_OPENCODE_TIMEOUT_SECONDS=900",
            ]
        ),
        encoding="utf-8",
    )

    settings = load_settings(env_file=env_file, environ={})

    assert settings.llm.base_url == "http://api.net:8000/v1"
    assert settings.llm.model == "QWEN3"
    assert settings.vlm.base_url == "http://api.net/vl/v1"
    assert settings.rag.permission_groups == ["rag-public", "manual-private"]
    assert settings.reranker.model == "bge-reranker-v2-m3-ko"
    assert settings.enable_internal_planner is True
    assert settings.enable_rag_context is True
    assert settings.enable_reranker is True
    assert settings.playwright_mcp_mode == "manifest"
    assert settings.playwright_mcp_command == "npx @playwright/mcp@latest"
    assert settings.tts_provider == "melotts"
    assert settings.tts_device == "cpu"
    assert settings.tts_speed == 1.1
    assert settings.video_renderer == "hyperframes"
    assert settings.hyperframes_command == "npx hyperframes render"
    assert settings.enable_hyperframes_skills is True
    assert settings.hyperframes_skills_command == "npx hyperframes skills --codex"
    assert settings.enable_opencode is True
    assert settings.opencode_command == "opencode run --format json"
    assert settings.opencode_agent == "build"
    assert settings.opencode_model == "openai/gpt-5"
    assert settings.opencode_timeout_seconds == 900
    assert settings.llm.is_configured is True
    headers = settings.llm.default_headers()
    assert headers["x-dep-ticket"] == "credential:TICKET-123"
    assert headers["Send-System-Name"] == "manual-video-agent"
    assert headers["User-Id"] == "USER01"
    assert headers["User-Type"] == "AD_ID"
    assert headers["Prompt-Msg-Id"]
    assert headers["Completion-Msg-Id"]


def test_settings_status_does_not_expose_secret_values(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(
            [
                "MANUAL_AGENT_OPENAI_API_KEY=super-secret",
                "MANUAL_AGENT_LLM_BASE_URL=http://api.net:8000/v1",
                "MANUAL_AGENT_DEP_TICKET=credential:SECRET",
                "MANUAL_AGENT_SEND_SYSTEM_NAME=manual-video-agent",
                "MANUAL_AGENT_USER_ID=USER01",
                "MANUAL_AGENT_USER_TYPE=AD_ID",
            ]
        ),
        encoding="utf-8",
    )

    status = load_settings(env_file=env_file, environ={}).safe_status()

    rendered = repr(status)
    assert "super-secret" not in rendered
    assert "credential:SECRET" not in rendered
    assert status["llm"]["configured"] is True
    assert status["llm"]["base_url_set"] is True
    assert "enable_internal_planner" in status["runtime"]


def test_process_environment_overrides_env_file_values(tmp_path: Path):
    env_file = tmp_path / ".env"
    env_file.write_text(
        "\n".join(
            [
                "MANUAL_AGENT_LLM_MODEL=file-model",
                "MANUAL_AGENT_ENABLE_OPENCODE=false",
            ]
        ),
        encoding="utf-8",
    )

    settings = load_settings(
        env_file=env_file,
        environ={
            "MANUAL_AGENT_LLM_MODEL": "env-model",
            "MANUAL_AGENT_ENABLE_OPENCODE": "true",
        },
    )

    assert settings.llm.model == "env-model"
    assert settings.enable_opencode is True


def test_config_status_api_does_not_expose_secret_values(monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OPENAI_API_KEY", "super-secret")
    monkeypatch.setenv("MANUAL_AGENT_LLM_BASE_URL", "http://api.net:8000/v1")
    monkeypatch.setenv("MANUAL_AGENT_DEP_TICKET", "credential:SECRET")
    monkeypatch.setenv("MANUAL_AGENT_SEND_SYSTEM_NAME", "manual-video-agent")
    monkeypatch.setenv("MANUAL_AGENT_USER_ID", "USER01")
    monkeypatch.setenv("MANUAL_AGENT_USER_TYPE", "AD_ID")

    response = TestClient(app).get("/api/config/status")

    assert response.status_code == 200
    body = response.text
    assert "super-secret" not in body
    assert "credential:SECRET" not in body
    assert response.json()["llm"]["configured"] is True
