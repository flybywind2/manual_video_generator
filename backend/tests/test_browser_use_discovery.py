import json
from pathlib import Path

from fastapi.testclient import TestClient

from backend.app.adapters.browser_use_discovery import BrowserUseDiscoveryInput, create_browser_use_discovery
from backend.app.main import app


def test_browser_use_discovery_creates_draft_only_manifest(tmp_path: Path):
    result = create_browser_use_discovery(
        BrowserUseDiscoveryInput(
            request_text="챗봇에 st.form과 st.input 차이점을 질문하고 모달이 뜨면 닫기",
            target_url="https://www.genspark.ai/agents?type=ai_chat",
            role="사내 사용자",
            completion_condition="답변이 보이면 완료",
            input_values={"질문": "st.form과 st.input의 입력 차이점"},
            viewport_mode="mobile",
            auth_profile="sso_profile",
        ),
        output_dir=tmp_path,
    )

    assert result.status == "draft_only"
    assert result.manifest_path.exists()
    assert result.scenario_draft_path.exists()
    assert result.candidate_action_plan_path.exists()
    manifest = json.loads(result.manifest_path.read_text(encoding="utf-8"))
    assert manifest["adapter"] == "browser-use-discovery"
    assert manifest["approval_required"] is True
    assert manifest["viewport"]["mode"] == "mobile"
    assert manifest["viewport"]["is_mobile"] is True
    assert any(action["intent"] == "close_modal" for action in manifest["candidate_actions"])
    assert any(action["intent"] == "send_prompt" for action in manifest["candidate_actions"])
    assert "password" not in json.dumps(manifest["request"], ensure_ascii=False).lower()


def test_browser_use_discovery_api_returns_artifact_links(tmp_path: Path, monkeypatch):
    monkeypatch.setenv("MANUAL_AGENT_OUTPUT_DIR", str(tmp_path))
    client = TestClient(app)

    response = client.post(
        "/api/generation/scenario-drafts/discover",
        json={
            "request_text": "LOT-001 조회 방법을 모바일 화면 기준으로 탐색",
            "target_url": "http://127.0.0.1:8000/sample",
            "viewport_mode": "mobile",
            "max_steps": 4,
        },
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "draft_only"
    assert body["approval_required"] is True
    assert body["manifest"]["viewport"]["mode"] == "mobile"
    assert body["artifacts"]["manifest"].endswith("/browser_use_discovery_manifest.json")
    manifest_path = tmp_path / "jobs" / body["job_id"] / "browser_use_discovery_manifest.json"
    assert manifest_path.exists()

