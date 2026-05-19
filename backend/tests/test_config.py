from pathlib import Path

from backend.app.config import load_settings
from backend.app.main import app
from fastapi.testclient import TestClient


def test_env_example_includes_llm_browser_agent_toggles():
    env_example = Path(".env.example").read_text(encoding="utf-8")

    assert "MANUAL_AGENT_LLM_PROVIDER=" in env_example
    assert "MANUAL_AGENT_ENABLE_INTERNAL_PLANNER=" in env_example
    assert "MANUAL_AGENT_ENABLE_BROWSER_AGENT=" in env_example
    assert "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS=" in env_example
    assert "MANUAL_AGENT_DEMONSTRATION_TIMEOUT_SECONDS=" in env_example
    assert "MANUAL_AGENT_SUPERTONIC_VOICE=" in env_example
    assert "MANUAL_AGENT_SUPERTONIC_LANG=" in env_example
    assert "MANUAL_AGENT_SUPERTONIC_AUTO_DOWNLOAD=" in env_example


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
                "MANUAL_AGENT_ENABLE_INPUT_EXTRACTOR=false",
                "MANUAL_AGENT_LLM_TIMEOUT_SECONDS=180",
                "MANUAL_AGENT_ENABLE_RAG_CONTEXT=true",
                "MANUAL_AGENT_ENABLE_RERANKER=true",
                "MANUAL_AGENT_PLAYWRIGHT_MCP_MODE=manifest",
                "MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND=npx @playwright/mcp@latest",
                "MANUAL_AGENT_PLAYWRIGHT_EXECUTABLE_PATH=D:\\browsers\\chrome.exe",
                "MANUAL_AGENT_ENABLE_BROWSER_AGENT=true",
                "MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS=7",
                "MANUAL_AGENT_LOGIN_MODE=credentials",
                "MANUAL_AGENT_LOGIN_USERNAME_SELECTOR=#uid",
                "MANUAL_AGENT_LOGIN_PASSWORD_SELECTOR=#pwd",
                "MANUAL_AGENT_LOGIN_SUBMIT_SELECTOR=button.login",
                "MANUAL_AGENT_LOGIN_SUCCESS_SELECTOR=.home",
                "MANUAL_AGENT_LOGIN_USERNAME=user01",
                "MANUAL_AGENT_LOGIN_PASSWORD=plain-password",
                "MANUAL_AGENT_LOGIN_MANUAL_TIMEOUT_SECONDS=90",
                "MANUAL_AGENT_TTS_PROVIDER=melotts",
                "MANUAL_AGENT_TTS_DEVICE=cpu",
                "MANUAL_AGENT_TTS_SPEED=1.1",
                "MANUAL_AGENT_SUPERTONIC_VOICE=F2",
                "MANUAL_AGENT_SUPERTONIC_LANG=ko",
                "MANUAL_AGENT_SUPERTONIC_AUTO_DOWNLOAD=false",
                "MANUAL_AGENT_VIDEO_RENDERER=hyperframes",
                "MANUAL_AGENT_HYPERFRAMES_COMMAND=npx hyperframes render",
                "MANUAL_AGENT_ENABLE_HYPERFRAMES_SKILLS=true",
                "MANUAL_AGENT_HYPERFRAMES_SKILLS_COMMAND=npx hyperframes skills --codex",
                "MANUAL_AGENT_ENABLE_OPENCODE=true",
                "MANUAL_AGENT_OPENCODE_COMMAND=opencode run --format json",
                "MANUAL_AGENT_OPENCODE_AGENT=build",
                "MANUAL_AGENT_OPENCODE_MODEL=openai/gpt-5",
                "MANUAL_AGENT_OPENCODE_TIMEOUT_SECONDS=900",
                "MANUAL_AGENT_DEMONSTRATION_TIMEOUT_SECONDS=720",
                "MANUAL_AGENT_ENABLE_TERMINAL_LOGS=true",
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
    assert settings.enable_input_extractor is False
    assert settings.llm_timeout_seconds == 180
    assert settings.enable_rag_context is True
    assert settings.enable_reranker is True
    assert settings.playwright_mcp_mode == "manifest"
    assert settings.playwright_mcp_command == "npx @playwright/mcp@latest"
    assert settings.playwright_executable_path == "D:\\browsers\\chrome.exe"
    assert settings.enable_browser_agent is True
    assert settings.browser_agent_max_steps == 7
    assert settings.login.mode == "credentials"
    assert settings.login.username_selector == "#uid"
    assert settings.login.password_selector == "#pwd"
    assert settings.login.submit_selector == "button.login"
    assert settings.login.success_selector == ".home"
    assert settings.login.username == "user01"
    assert settings.login.password == "plain-password"
    assert settings.login.manual_timeout_seconds == 90
    assert settings.login.credentials_configured is True
    assert settings.tts_provider == "melotts"
    assert settings.tts_device == "cpu"
    assert settings.tts_speed == 1.1
    assert settings.supertonic_voice == "F2"
    assert settings.supertonic_lang == "ko"
    assert settings.supertonic_auto_download is False
    assert settings.video_renderer == "hyperframes"
    assert settings.hyperframes_command == "npx hyperframes render"
    assert settings.enable_hyperframes_skills is True
    assert settings.hyperframes_skills_command == "npx hyperframes skills --codex"
    assert settings.enable_opencode is True
    assert settings.opencode_command == "opencode run --format json"
    assert settings.opencode_agent == "build"
    assert settings.opencode_model == "openai/gpt-5"
    assert settings.opencode_timeout_seconds == 900
    assert settings.demonstration_timeout_seconds == 720
    assert settings.enable_terminal_logs is True
    assert settings.llm.is_configured is True
    headers = settings.llm.default_headers()
    assert headers["x-dep-ticket"] == "credential:TICKET-123"
    assert headers["Send-System-Name"] == "manual-video-agent"
    assert headers["User-Id"] == "USER01"
    assert headers["User-Type"] == "AD_ID"
    assert headers["Prompt-Msg-Id"]
    assert headers["Completion-Msg-Id"]
    assert headers["Accept"] == "application/json"


def test_supertonic_voice_setting_rejects_custom_voice_paths():
    settings = load_settings(
        environ={
            "MANUAL_AGENT_TTS_PROVIDER": "supertonic",
            "MANUAL_AGENT_SUPERTONIC_VOICE": r"C:\voices\employee.json",
        }
    )

    assert settings.supertonic_voice == "M1"
    status = settings.safe_status()
    assert status["runtime"]["supertonic_voice"] == "M1"
    assert status["runtime"]["supertonic_custom_voice_allowed"] is False


def test_ollama_llm_provider_uses_openai_compatible_endpoint_without_internal_headers():
    settings = load_settings(
        environ={
            "MANUAL_AGENT_LLM_PROVIDER": "ollama",
            "MANUAL_AGENT_LLM_BASE_URL": "http://127.0.0.1:11434/v1",
            "MANUAL_AGENT_LLM_MODEL": "gemma4:31b-cloud",
        }
    )

    assert settings.llm.provider == "ollama"
    assert settings.llm.is_configured is True
    assert settings.llm.base_url == "http://127.0.0.1:11434/v1"
    assert settings.llm.model == "gemma4:31b-cloud"
    headers = settings.llm.chat_headers()
    assert headers == {"Content-Type": "application/json", "Accept": "application/json"}
    status = settings.safe_status()
    assert status["llm"]["configured"] is True
    assert status["llm"]["provider"] == "ollama"
    assert status["llm"]["api_key_set"] is False
    assert status["llm"]["dep_ticket_set"] is False


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
                "MANUAL_AGENT_LOGIN_USERNAME=user01",
                "MANUAL_AGENT_LOGIN_PASSWORD=plain-password",
            ]
        ),
        encoding="utf-8",
    )

    status = load_settings(env_file=env_file, environ={}).safe_status()

    rendered = repr(status)
    assert "super-secret" not in rendered
    assert "credential:SECRET" not in rendered
    assert "plain-password" not in rendered
    assert "user01" not in rendered
    assert status["llm"]["configured"] is True
    assert status["llm"]["base_url_set"] is True
    assert status["login"]["username_set"] is True
    assert status["login"]["password_set"] is True
    assert "enable_internal_planner" in status["runtime"]
    assert "enable_input_extractor" in status["runtime"]
    assert "enable_browser_agent" in status["runtime"]
    assert "demonstration_timeout_seconds" in status["runtime"]
    assert status["runtime"]["enable_terminal_logs"] is False


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


def test_safe_status_reports_login_selector_auto_detection_when_llm_configured():
    settings = load_settings(
        environ={
            "MANUAL_AGENT_LLM_PROVIDER": "ollama",
            "MANUAL_AGENT_LLM_BASE_URL": "http://127.0.0.1:11434/v1",
            "MANUAL_AGENT_LLM_MODEL": "qwen3.5",
            "MANUAL_AGENT_LOGIN_MODE": "credentials",
            "MANUAL_AGENT_LOGIN_USERNAME": "user01",
            "MANUAL_AGENT_LOGIN_PASSWORD": "plain-password",
        }
    )

    status = settings.safe_status()

    assert status["login"]["credentials_configured"] is False
    assert status["login"]["selector_auto_detection_supported"] is True
    assert status["login"]["credentials_usable"] is True
    assert "plain-password" not in repr(status)
    assert "user01" not in repr(status)


def test_load_settings_reads_manual_agent_env_file_pointer(tmp_path: Path):
    env_file = tmp_path / "runtime.env"
    env_file.write_text(
        "\n".join(
            [
                "MANUAL_AGENT_LLM_MODEL=file-pointer-model",
                "MANUAL_AGENT_OUTPUT_DIR=D:\\manual-output",
                "MANUAL_AGENT_ENABLE_OPENCODE=true",
            ]
        ),
        encoding="utf-8",
    )

    settings = load_settings(environ={"MANUAL_AGENT_ENV_FILE": str(env_file)})

    assert settings.llm.model == "file-pointer-model"
    assert settings.output_dir == "D:\\manual-output"
    assert settings.enable_opencode is True


def test_process_environment_overrides_manual_agent_env_file_pointer(tmp_path: Path):
    env_file = tmp_path / "runtime.env"
    env_file.write_text(
        "\n".join(
            [
                "MANUAL_AGENT_LLM_MODEL=file-pointer-model",
                "MANUAL_AGENT_ENABLE_OPENCODE=false",
            ]
        ),
        encoding="utf-8",
    )

    settings = load_settings(
        environ={
            "MANUAL_AGENT_ENV_FILE": str(env_file),
            "MANUAL_AGENT_LLM_MODEL": "process-model",
            "MANUAL_AGENT_ENABLE_OPENCODE": "true",
        }
    )

    assert settings.llm.model == "process-model"
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


def test_config_status_api_reads_manual_agent_env_file_pointer(tmp_path: Path, monkeypatch):
    env_file = tmp_path / "runtime.env"
    env_file.write_text(
        "\n".join(
            [
                "MANUAL_AGENT_LLM_MODEL=api-pointer-model",
                "MANUAL_AGENT_ENABLE_OPENCODE=true",
            ]
        ),
        encoding="utf-8",
    )
    monkeypatch.setenv("MANUAL_AGENT_ENV_FILE", str(env_file))

    response = TestClient(app).get("/api/config/status")

    assert response.status_code == 200
    body = response.json()
    assert body["llm"]["model"] == "api-pointer-model"
    assert body["runtime"]["enable_opencode"] is True
