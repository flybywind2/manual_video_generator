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
    assert "OpenCode Agent" in body
    assert "Playwright MCP / CDP" in body
    assert "Supertonic M1" in body
    assert "HyperFrames + FFmpeg" in body
    assert "MeloTTS" not in body
    assert "LLM Planner" not in body
    assert "직접 시연" not in body
    assert "AI 자동 실행" not in body
    assert "browser-use 초안 탐색" not in body
    assert ".env 설정 상태" in body
    assert 'id="work"' in body
    assert 'id="artifacts"' in body
    assert 'id="security"' in body
    assert 'id="settings"' in body
    assert 'href="#work"' in body
    assert 'href="#artifacts"' in body
    assert 'href="#security"' in body
    assert 'href="#settings"' in body
    assert 'id="input-values"' in body
    assert 'name="login_mode"' not in body
    assert 'name="login_success_selector"' not in body
    assert 'name="execution_mode"' not in body
    assert 'name="login_password"' not in body
    assert 'data-action="add-input-value"' in body
    assert 'data-action="remove-input-value"' in body


def test_static_app_exposes_review_artifact_links():
    client = TestClient(app)

    response = client.get("/static/app.js")

    assert response.status_code == 200
    body = response.text
    assert "OpenCode Trace" in body
    assert "OpenCode Events" in body
    assert "Replay Log" in body
    assert "HyperFrames Composition" in body
    assert "OpenCode Prompt" in body
    assert "login_mode" not in body
    assert "execution_mode" not in body
    assert "Browser Agent" not in body
    assert "Page Agent" not in body
    assert "Decision Policy" not in body
    assert "VLM every meaningful step" not in body
    assert "browser_agent_max_steps" not in body
    assert "/api/pipeline/draft" in body
    assert "/api/generation/scenario-drafts/discover" not in body
    assert "/api/pipeline/continue/" in body
    assert "renderPlanReview" in body
    assert "continue-workflow" in body
    assert "요청 확인 후 실행" in body
    assert 'document.querySelectorAll(".step-list .step")' in body
    assert "setWorkflowStep(1)" in body
    assert "setWorkflowStep(5)" in body
    assert "startWorkflowPolling" in body
    assert "pollWorkflowState" in body
    assert "applyWorkflowState" in body
    assert "workflowStepIndexForState" in body
    assert "workflow_state_url" in body
    assert "clearWorkflowPoll" in body
    assert "WorkflowStep" in body
    assert "workflowUiState" in body
    assert "opencode_discovery" in body
    assert "trace_validation" in body
    assert "mcp_rehearsal_after_login" not in body
    assert "renderDegradationPanel" in body
    assert "degradationReasonInfo" in body
    assert "render_quality_failed" in body
    assert "렌더 품질 검증 실패" in body
    assert "재렌더링 영향" in body
    assert "is-complete" in body
    assert "openArtifactEditor" in body
    assert "saveArtifactEditor" in body
    assert "isTextArtifact" in body
    assert "/api/artifacts/text/" in body
    assert "rerenderPackage" in body
    assert "/api/pipeline/rerender/" in body
    assert "패키지 기반 재렌더링" in body
    assert "renderFriendlyArtifact" in body
    assert "parseArtifactContent" in body
    assert "artifactEditorFriendly" in body
    assert "renderPlanArtifact" in body
    assert "renderGenericJsonValue" in body
    assert "renderEditableJsonEditor" in body
    assert "syncFriendlyEditorToRaw" in body
    assert "setJsonPathValue" in body
    assert "data-action=\"edit-json-value\"" in body
    assert "data-action=\"rename-json-key\"" in body
    assert "data-action=\"add-json-item\"" in body
    assert "data-action=\"remove-json-item\"" in body
    assert "필드 추가" in body
    assert "항목 추가" in body
    assert "원본 편집" in body
    assert "쉬운 보기" in body
    assert "loadingSpinnerHtml" in body
    assert "setButtonLoading" in body
    assert "setArtifactLoading" in body
    assert "loading-spinner" in body
    assert "aria-busy" in body
    assert "작업이 진행 중입니다" in body
    assert "OpenCode Agent" in body
    assert "Playwright MCP / CDP" in body
    assert "Supertonic M1" in body
    assert "HyperFrames / FFmpeg" in body
    assert "navLinks" in body
    assert "setActiveNav" in body
    assert "scrollIntoView" in body


def test_home_screen_includes_text_artifact_editor_modal():
    client = TestClient(app)

    response = client.get("/")

    assert response.status_code == 200
    body = response.text
    assert 'id="artifact-editor-modal"' in body
    assert 'id="artifact-editor-friendly"' in body
    assert 'id="artifact-editor-text"' in body
    assert 'data-action="show-friendly-artifact"' in body
    assert 'data-action="show-raw-artifact"' in body
    assert 'data-action="save-artifact-editor"' in body
    assert 'data-action="close-artifact-editor"' in body
    assert "텍스트 산출물 편집" in body


def test_static_app_marks_local_disabled_and_none_config_as_neutral_not_missing():
    client = TestClient(app)

    response = client.get("/static/app.js")

    assert response.status_code == 200
    body = response.text
    assert "configStatusRows" in body
    assert "OpenCode Agent" in body
    assert "Playwright MCP / CDP" in body
    assert "Supertonic M1" in body
    assert "HyperFrames / FFmpeg" in body
    assert "Login Default" not in body
    assert "status.llm" not in body
    assert "status.vlm" not in body
    assert "status.rag" not in body
    assert "status.reranker" not in body


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


def test_static_styles_define_loading_spinner():
    client = TestClient(app)

    response = client.get("/static/styles.css")

    assert response.status_code == 200
    body = response.text
    assert ".loading-spinner" in body
    assert "@keyframes loading-spin" in body
    assert ".artifact-loading" in body
    assert ".button.is-loading" in body


def test_static_app_exposes_selector_trace_artifact_and_friendly_view():
    client = TestClient(app)

    response = client.get("/static/app.js")

    assert response.status_code == 200
    body = response.text
    assert "Selector Trace" in body
    assert "selector_trace" in body
    assert "renderSelectorTraceArtifact" in body


def test_static_app_exposes_support_log_artifact_link():
    client = TestClient(app)

    response = client.get("/static/app.js")

    assert response.status_code == 200
    body = response.text
    assert "Support Log" in body
    assert "support_log" in body


def test_sample_screen_includes_login_modal_and_iframe_variants():
    client = TestClient(app)

    response = client.get("/sample")

    assert response.status_code == 200
    body = response.text
    assert 'variant") === "login"' in body
    assert 'variant") === "modal"' in body
    assert 'variant") === "iframe"' in body
    assert 'data-action="login"' in body
    assert 'data-action="close-modal"' in body
    assert "sample embedded help" in body
