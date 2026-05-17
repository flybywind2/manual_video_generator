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
