from fastapi.testclient import TestClient

from backend.app.main import app


def test_home_screen_renders_ai_center_manual_video_agent():
    client = TestClient(app)

    response = client.get("/")

    assert response.status_code == 200
    body = response.text
    assert "AI Center · Manual Video Agent" in body
    assert "사내 시스템 매뉴얼 영상 생성" in body
    assert "새 영상 작업" in body
    assert "파이프라인 실행" in body
    assert "AI Center Pipeline" in body
    assert "MeloTTS" in body
    assert ".env 설정 상태" in body
    assert 'id="input-values"' in body
    assert 'data-action="add-input-value"' in body
    assert 'data-action="remove-input-value"' in body


def test_static_app_exposes_review_artifact_links():
    client = TestClient(app)

    response = client.get("/static/app.js")

    assert response.status_code == 200
    body = response.text
    assert "Planner Trace" in body
    assert "리허설 로그" in body
    assert "MCP Calls" in body
    assert "HyperFrames Composition" in body
    assert "OpenCode Prompt" in body


def test_static_app_supports_editable_input_value_rows():
    client = TestClient(app)

    response = client.get("/static/app.js")

    assert response.status_code == 200
    body = response.text
    assert "renderInputValues" in body
    assert "addInputValueRow" in body
    assert "remove-input-value" in body
    assert "input-value-key" in body
    assert "input-value-value" in body
