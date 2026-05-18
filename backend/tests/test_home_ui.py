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
    assert 'name="login_mode"' in body
    assert '<option value="" selected>설정값 사용</option>' in body
    assert 'name="login_success_selector"' in body
    assert "로그인 완료 신호" in body
    assert "로그인 완료 버튼" in body
    assert "직접 로그인" in body
    assert ".env ID/password" in body
    assert 'name="login_password"' not in body
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
    assert "login_mode" in body
    assert "Browser Agent" in body
    assert "browser_agent_max_steps" in body
    assert 'login_mode.value = "";' in body
    assert 'login_mode.value = "none";' not in body
    assert "login_success_selector" in body
    assert "/api/pipeline/draft" in body
    assert "/api/pipeline/continue/" in body
    assert "renderPlanReview" in body
    assert "continue-workflow" in body
    assert "계획 승인 후 실행" in body
    assert 'document.querySelectorAll(".step-list .step")' in body
    assert "setWorkflowStep(1)" in body
    assert "setWorkflowStep(5)" in body
    assert "is-complete" in body


def test_static_app_marks_local_disabled_and_none_config_as_neutral_not_missing():
    client = TestClient(app)

    response = client.get("/static/app.js")

    assert response.status_code == 200
    body = response.text
    assert "configStatusRows" in body
    assert "Login Default" in body
    assert 'state: "neutral"' in body
    assert 'state: "disabled"' in body
    assert '["Planner", status.runtime.enable_internal_planner' not in body
    assert '["Browser Agent", status.runtime.enable_browser_agent' not in body
    assert '["Login", status.login.mode !== "none"' not in body


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
