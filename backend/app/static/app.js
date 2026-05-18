const form = document.querySelector("#job-form");
const sampleButton = document.querySelector("#load-sample");
const panelState = document.querySelector(".panel-state");
const workflowSteps = Array.from(document.querySelectorAll(".step-list .step"));
const pipelineNodes = Array.from(document.querySelectorAll(".pipeline-node"));
const artifactStatus = document.querySelector("#artifact-status");
const artifactLinks = document.querySelector("#artifact-links");
const submitButton = form?.querySelector("button[type='submit']");
const configGrid = document.querySelector("#config-grid");
const inputValues = document.querySelector("#input-values");
const inputValueList = inputValues?.querySelector("[data-input-value-list]");
const artifactEditorModal = document.querySelector("#artifact-editor-modal");
const artifactEditorText = document.querySelector("#artifact-editor-text");
const artifactEditorTitle = document.querySelector("#artifact-editor-title");
const artifactEditorPath = document.querySelector("#artifact-editor-path");
const artifactEditorStatus = document.querySelector("#artifact-editor-status");
const artifactEditorOpenLink = document.querySelector("#artifact-editor-open-link");
const artifactEditorSaveButton = artifactEditorModal?.querySelector("[data-action='save-artifact-editor']");
const sampleInputValues = [
  { key: "LOT", value: "LOT-001" },
  { key: "라인", value: "A3" },
];
let currentDraft = null;
let currentArtifactEditor = null;

loadConfigStatus();

sampleButton?.addEventListener("click", () => {
  form.elements.request.value = "MES에서 LOT 조회 방법 영상 만들기";
  form.elements.url.value = `${window.location.origin}/sample`;
  form.elements.role.value = "작업자";
  form.elements.login_mode.value = "";
  form.elements.login_success_selector.value = "";
  form.elements.execution_mode.value = "demonstration";
  form.elements.done.value = "상세 화면이 보이면 완료";
  renderInputValues(sampleInputValues);
  panelState.textContent = "Sample loaded";
  currentDraft = null;
  setWorkflowStep(0);
  setPipelineProgress(0);
});

inputValues?.addEventListener("click", (event) => {
  const action = event.target?.dataset?.action;
  if (action === "add-input-value") {
    const row = addInputValueRow("", "");
    row.querySelector(".input-value-key")?.focus();
  }
  if (action === "remove-input-value") {
    event.target.closest(".input-value-row")?.remove();
  }
});

form?.addEventListener("submit", async (event) => {
  event.preventDefault();
  currentDraft = null;
  setBusy(true, "계획 생성 중...");
  setWorkflowStep(0);
  setPipelineProgress(0);
  setStatus("Planning");
  setArtifactMessage(planningMessage());

  try {
    const response = await fetch("/api/pipeline/draft", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(createPipelinePayload()),
    });

    if (!response.ok) {
      throw new Error(`Draft failed: ${response.status}`);
    }

    currentDraft = await response.json();
    setWorkflowStep(1);
    setPipelineProgress(1);
    setStatus("Plan review");
    renderPlanReview(currentDraft);
  } catch (error) {
    setStatus("Failed");
    setArtifactMessage(error.message || "계획 생성 중 오류가 발생했습니다.");
  } finally {
    setBusy(false);
  }
});

artifactLinks?.addEventListener("click", async (event) => {
  const editorButton = event.target?.closest("[data-action='edit-artifact']");
  if (editorButton) {
    event.preventDefault();
    await openArtifactEditor(editorButton.dataset.url, editorButton.dataset.label);
    return;
  }

  const rerenderButton = event.target?.closest("[data-action='rerender-package']");
  if (rerenderButton) {
    event.preventDefault();
    await rerenderPackage(rerenderButton.dataset.jobId, rerenderButton);
    return;
  }

  const button = event.target?.closest("[data-action='continue-workflow']");
  if (!button) return;
  event.preventDefault();
  if (!currentDraft?.job_id) {
    setArtifactMessage("계획 검수 대기 중인 작업을 찾지 못했습니다.");
    return;
  }
  await continueWorkflow(currentDraft.job_id, button);
});

artifactEditorModal?.addEventListener("click", async (event) => {
  const action = event.target?.closest("[data-action]")?.dataset?.action;
  if (action === "close-artifact-editor") {
    closeArtifactEditor();
  }
  if (action === "save-artifact-editor") {
    await saveArtifactEditor();
  }
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && artifactEditorModal && !artifactEditorModal.hidden) {
    closeArtifactEditor();
  }
});

function createPipelinePayload() {
  return {
    request_text: form.elements.request.value.trim(),
    target_url: form.elements.url.value.trim(),
    role: form.elements.role.value.trim(),
    completion_condition: form.elements.done.value.trim(),
    login_mode: form.elements.login_mode.value,
    login_success_selector: form.elements.login_success_selector.value.trim(),
    execution_mode: form.elements.execution_mode.value,
    input_values: readInputValues(),
  };
}

async function continueWorkflow(jobId, button) {
  button.disabled = true;
  setBusy(true, "실행 중...");
  setWorkflowStep(2);
  setPipelineProgress(2);
  setStatus("Running");
  setArtifactMessage(continueMessage(currentDraft));

  try {
    const response = await fetch(`/api/pipeline/continue/${encodeURIComponent(jobId)}`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Continue failed: ${response.status}`);
    }

    const result = await response.json();
    currentDraft = null;
    setWorkflowStep(5);
    setPipelineProgress(5);
    setStatus("Completed");
    renderArtifacts(result);
  } catch (error) {
    button.disabled = false;
    setStatus("Failed");
    renderPlanReview(currentDraft, error.message || "승인 후 실행 중 오류가 발생했습니다.");
  } finally {
    setBusy(false);
  }
}

async function rerenderPackage(jobId, button) {
  if (!jobId) return;
  button.disabled = true;
  setBusy(true, "재렌더링 중...");
  setWorkflowStep(5);
  setPipelineProgress(5);
  setStatus("Rerendering");
  artifactStatus.textContent = `작업 ${jobId} 패키지 기반으로 TTS, 미리보기, 영상 렌더를 다시 생성합니다.`;
  try {
    const response = await fetch(`/api/pipeline/rerender/${encodeURIComponent(jobId)}`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Rerender failed: ${response.status}`);
    }
    const result = await response.json();
    setStatus("Completed");
    renderArtifacts(result, "패키지 기반 재렌더링이 완료되었습니다.");
  } catch (error) {
    button.disabled = false;
    setStatus("Failed");
    artifactStatus.textContent = error.message || "재렌더링 중 오류가 발생했습니다.";
  } finally {
    setBusy(false);
  }
}

function planningMessage() {
  if (form.elements.execution_mode.value === "demonstration") {
    return "요청을 분석하고 검수용 계획을 만듭니다. 승인 후 브라우저가 열리면 직접 시연하고 시연 완료 버튼을 누릅니다.";
  }
  return "요청을 분석하고 Action Plan, 승인 로그, MCP 리허설 결과를 생성합니다. 승인 후 AI가 화면을 보고 안전 동작을 선택합니다.";
}

function continueMessage(draft) {
  const mode = draft?.execution_mode || form.elements.execution_mode.value;
  if (mode === "demonstration") {
    return "브라우저가 열리면 사용자가 직접 로그인/입력/클릭을 시연합니다. 완료 후 화면의 시연 완료 버튼을 누르면 마스킹, TTS, 렌더를 진행합니다.";
  }
  return "승인된 계획으로 AI 브라우저 판단, 캡처, 마스킹, TTS, HyperFrames 렌더를 실행합니다.";
}

function readInputValues() {
  return Array.from(document.querySelectorAll(".input-value-row")).reduce((values, row) => {
    const key = row.querySelector(".input-value-key")?.value.trim();
    const value = row.querySelector(".input-value-value")?.value.trim();
    if (key) {
      values[key] = value || "";
    }
    return values;
  }, {});
}

function renderInputValues(entries) {
  if (!inputValueList) return;
  inputValueList.innerHTML = "";
  entries.forEach(({ key, value }) => addInputValueRow(key, value));
}

function addInputValueRow(key = "", value = "") {
  const row = document.createElement("div");
  row.className = "input-value-row";

  const keyInput = document.createElement("input");
  keyInput.className = "input-value-key";
  keyInput.type = "text";
  keyInput.setAttribute("aria-label", "입력값 이름");
  keyInput.value = key;

  const valueInput = document.createElement("input");
  valueInput.className = "input-value-value";
  valueInput.type = "text";
  valueInput.setAttribute("aria-label", "입력값 값");
  valueInput.value = value;

  const removeButton = document.createElement("button");
  removeButton.className = "icon-button danger";
  removeButton.type = "button";
  removeButton.dataset.action = "remove-input-value";
  removeButton.setAttribute("aria-label", "입력값 삭제");
  removeButton.textContent = "×";

  row.append(keyInput, valueInput, removeButton);
  inputValueList?.append(row);
  return row;
}

function setBusy(isBusy, label = "") {
  if (!submitButton) return;
  submitButton.disabled = isBusy;
  submitButton.querySelector(".play-icon").style.display = isBusy ? "none" : "inline-block";
  submitButton.lastChild.textContent = isBusy ? ` ${label || "실행 중..."}` : " 파이프라인 실행";
}

function setStatus(status) {
  if (panelState) panelState.textContent = status;
}

function setPipelineProgress(activeIndex) {
  pipelineNodes.forEach((node, index) => {
    node.classList.toggle("is-active", index <= activeIndex);
    node.classList.toggle("is-complete", index < activeIndex);
  });
}

function setWorkflowStep(activeIndex) {
  workflowSteps.forEach((step, index) => {
    step.classList.toggle("is-active", index === activeIndex);
    step.classList.toggle("is-complete", index < activeIndex);
  });
}

function setArtifactMessage(message) {
  artifactStatus.textContent = message;
  artifactLinks.innerHTML = "";
}

function renderPlanReview(draft, errorMessage = "") {
  const actions = draft.plan?.actions || [];
  const steps = draft.plan?.steps || [];
  const dangerActions = draft.approval?.danger_actions || [];
  artifactStatus.textContent = `작업 ${draft.job_id} 계획 검수 대기 중입니다. 승인해야 캡처와 영상 렌더가 시작됩니다.`;

  const supporting = draft.supporting_artifacts || {};
  const artifacts = draft.artifacts || {};
  const links = [
    ["Action JSON", artifacts.action_plan_url],
    ["승인 로그", artifacts.approval_log_url],
    ["리허설 로그", artifacts.rehearsal_log_url],
    ["Planner Trace", supporting.planner_trace || artifacts.planner_trace_url],
    ["MCP Calls", supporting.playwright_mcp_calls || artifacts.mcp_calls_url],
    ["Workflow State", supporting.workflow_state || artifacts.workflow_state_url],
  ].filter(([, url]) => Boolean(url));

  artifactLinks.innerHTML = `
    <div class="plan-review">
      ${errorMessage ? `<div class="review-error">${escapeHtml(errorMessage)}</div>` : ""}
      <div class="review-summary">
        <span><strong>${steps.length}</strong> 단계</span>
        <span><strong>${actions.length}</strong> 액션</span>
        <span><strong>${dangerActions.length}</strong> 위험 액션</span>
      </div>
      <div class="review-links">
        ${links.map(([label, url]) => artifactAnchor(label, url)).join("")}
      </div>
      <div class="review-actions">
        <button class="button primary" type="button" data-action="continue-workflow">계획 승인 후 실행</button>
      </div>
    </div>
  `;
}

function renderArtifacts(result, message = "") {
  artifactStatus.textContent = message || `작업 ${result.job_id} 패키지가 생성되었습니다.`;
  const supporting = result.supporting_artifacts || {};
  const links = [
    ["HTML 미리보기", result.artifacts.html_preview_url],
    ["영상", result.artifacts.video_url],
    ["Markdown", result.artifacts.markdown_manual_url],
    ["자막", result.artifacts.subtitles_url],
    ["PDF", result.artifacts.pdf_manual_url],
    ["Action JSON", result.artifacts.action_plan_url],
    ["Media Plan", supporting.media_plan || result.artifacts.media_plan_url],
    ["Planner Trace", supporting.planner_trace || result.artifacts.planner_trace_url],
    ["리허설 로그", supporting.rehearsal_log || result.artifacts.rehearsal_log_url],
    ["MCP Calls", supporting.playwright_mcp_calls || result.artifacts.mcp_calls_url],
    ["MCP 실행 로그", supporting.playwright_mcp_execution || result.artifacts.mcp_execution_url],
    ["마스킹 로그", result.artifacts.masking_log_url],
    ["TTS 메타데이터", result.artifacts.tts_metadata_url],
    ["렌더링 메타데이터", result.artifacts.video_render_metadata_url],
    ["Skills 메타데이터", result.artifacts.skills_metadata_url],
    ["HyperFrames Composition", supporting.hyperframes_composition || result.artifacts.hyperframes_composition_url],
    ["OpenCode Prompt", supporting.opencode_prompt || result.artifacts.opencode_prompt_url],
    ["OpenCode 메타데이터", result.artifacts.opencode_metadata_url],
    ["패키지 매니페스트", result.artifacts.package_manifest_url],
  ].filter(([, url]) => Boolean(url));
  artifactLinks.innerHTML = `
    <div class="artifact-action-row">
      <button class="button secondary" type="button" data-action="rerender-package" data-job-id="${escapeHtml(result.job_id)}">패키지 기반 재렌더링</button>
    </div>
    <div class="artifact-link-grid">
      ${links.map(([label, url]) => artifactAnchor(label, url)).join("")}
    </div>
  `;
}

function artifactAnchor(label, url) {
  if (isTextArtifact(url)) {
    return `<button class="artifact-link editable" type="button" data-action="edit-artifact" data-label="${escapeHtml(label)}" data-url="${escapeHtml(url)}">${escapeHtml(label)}</button>`;
  }
  return `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(label)}</a>`;
}

function isTextArtifact(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.pathname.startsWith("/artifacts/") && /\.(md|json|jsonl|vtt|txt|html)$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function artifactTextApiUrl(url) {
  const parsed = new URL(url, window.location.origin);
  const prefix = "/artifacts/";
  if (!parsed.pathname.startsWith(prefix)) {
    throw new Error("편집 가능한 산출물 URL이 아닙니다.");
  }
  return `/api/artifacts/text/${parsed.pathname.slice(prefix.length)}`;
}

async function openArtifactEditor(url, label = "텍스트 산출물") {
  if (!artifactEditorModal || !artifactEditorText || !artifactEditorPath || !artifactEditorStatus) return;
  const apiUrl = artifactTextApiUrl(url);
  currentArtifactEditor = { url, apiUrl, label };
  artifactEditorModal.hidden = false;
  artifactEditorText.value = "";
  artifactEditorText.disabled = true;
  artifactEditorStatus.textContent = "불러오는 중...";
  artifactEditorPath.textContent = url;
  if (artifactEditorTitle) artifactEditorTitle.textContent = `${label} 편집`;
  if (artifactEditorOpenLink) artifactEditorOpenLink.href = url;
  if (artifactEditorSaveButton) artifactEditorSaveButton.disabled = true;

  try {
    const response = await fetch(apiUrl);
    if (!response.ok) {
      throw new Error(`텍스트 산출물을 불러오지 못했습니다: ${response.status}`);
    }
    const payload = await response.json();
    artifactEditorText.value = payload.content || "";
    artifactEditorText.disabled = false;
    artifactEditorStatus.textContent = "편집 후 저장할 수 있습니다.";
    if (artifactEditorSaveButton) artifactEditorSaveButton.disabled = false;
    artifactEditorText.focus();
  } catch (error) {
    artifactEditorStatus.textContent = error.message || "텍스트 산출물을 불러오지 못했습니다.";
  }
}

async function saveArtifactEditor() {
  if (!currentArtifactEditor || !artifactEditorText || !artifactEditorStatus || !artifactEditorSaveButton) return;
  artifactEditorSaveButton.disabled = true;
  artifactEditorStatus.textContent = "저장 중...";
  try {
    const response = await fetch(currentArtifactEditor.apiUrl, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: artifactEditorText.value }),
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw new Error(detail.detail || `저장 실패: ${response.status}`);
    }
    artifactEditorStatus.textContent = "저장되었습니다.";
  } catch (error) {
    artifactEditorStatus.textContent = error.message || "저장 중 오류가 발생했습니다.";
  } finally {
    artifactEditorSaveButton.disabled = false;
  }
}

function closeArtifactEditor() {
  if (!artifactEditorModal) return;
  artifactEditorModal.hidden = true;
  currentArtifactEditor = null;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

async function loadConfigStatus() {
  if (!configGrid) return;
  try {
    const response = await fetch("/api/config/status");
    if (!response.ok) throw new Error(`config status failed: ${response.status}`);
    const status = await response.json();
    configGrid.innerHTML = configStatusRows(status).map(renderConfigItem).join("");
  } catch (error) {
    configGrid.innerHTML = `<span class="config-error">${error.message || "설정 상태를 불러오지 못했습니다."}</span>`;
  }
}

function configStatusRows(status) {
  return [
    requiredConfigRow("LLM", status.llm.configured, status.llm.model || "QWEN3"),
    requiredConfigRow("VLM", status.vlm.configured, status.vlm.model || "QWEN3-VL"),
    optionalServiceRow("RAG", status.rag.configured, status.rag.index_name || "index 미설정", status.runtime.enable_rag_context),
    optionalServiceRow("Reranker", status.reranker.configured, status.reranker.model || "model 미설정", status.runtime.enable_reranker),
    inputExtractorStatusRow(status),
    plannerStatusRow(status),
    browserAgentStatusRow(status),
    { label: "TTS", state: "ready", text: "Ready", detail: status.runtime.tts_provider },
    { label: "Renderer", state: "ready", text: "Ready", detail: status.runtime.video_renderer },
    loginStatusRow(status),
    featureToggleRow("Skills", status.runtime.enable_hyperframes_skills, "enabled", "disabled"),
    mcpStatusRow(status),
    featureToggleRow("OpenCode", status.runtime.enable_opencode, status.runtime.opencode_agent || "enabled", "disabled"),
  ];
}

function requiredConfigRow(label, configured, detail) {
  return configured
    ? { label, state: "ready", text: "Ready", detail }
    : { label, state: "missing", text: "Missing", detail };
}

function optionalServiceRow(label, configured, detail, enabled) {
  if (!enabled) {
    return { label, state: "disabled", text: "Disabled", detail: "disabled" };
  }
  return configured
    ? { label, state: "ready", text: "Ready", detail }
    : { label, state: "missing", text: "Missing", detail };
}

function inputExtractorStatusRow(status) {
  if (!status.runtime.enable_input_extractor) {
    return { label: "Input Extractor", state: "disabled", text: "Disabled", detail: "manual input only" };
  }
  return status.llm.configured
    ? { label: "Input Extractor", state: "ready", text: "Ready", detail: "LLM + local fallback" }
    : { label: "Input Extractor", state: "neutral", text: "Local", detail: "request text heuristic" };
}

function plannerStatusRow(status) {
  if (!status.runtime.enable_internal_planner) {
    return { label: "Planner", state: "neutral", text: "Local", detail: "deterministic planner" };
  }
  return status.llm.configured
    ? { label: "Planner", state: "ready", text: "Ready", detail: "internal LLM" }
    : { label: "Planner", state: "missing", text: "Missing", detail: "LLM config required" };
}

function browserAgentStatusRow(status) {
  if (!status.runtime.enable_browser_agent) {
    return { label: "Browser Agent", state: "disabled", text: "Disabled", detail: "deterministic capture" };
  }
  return status.llm.configured
    ? { label: "Browser Agent", state: "ready", text: "Ready", detail: `${status.runtime.browser_agent_max_steps || 8} steps` }
    : { label: "Browser Agent", state: "missing", text: "Missing", detail: "LLM config required" };
}

function loginStatusRow(status) {
  if (status.login.mode === "none") {
    return { label: "Login Default", state: "disabled", text: "None", detail: "per-run 선택 가능" };
  }
  if (status.login.mode === "manual") {
    return { label: "Login Default", state: "ready", text: "Manual", detail: "브라우저에서 직접 로그인" };
  }
  if (status.login.mode === "credentials") {
    return status.login.credentials_configured
      ? { label: "Login Default", state: "ready", text: "Ready", detail: "credentials" }
      : { label: "Login Default", state: "missing", text: "Missing", detail: "credentials missing" };
  }
  return { label: "Login Default", state: "disabled", text: "None", detail: status.login.mode || "none" };
}

function featureToggleRow(label, enabled, enabledDetail, disabledDetail) {
  return enabled
    ? { label, state: "ready", text: "Ready", detail: enabledDetail }
    : { label, state: "disabled", text: "Disabled", detail: disabledDetail };
}

function mcpStatusRow(status) {
  if (status.runtime.playwright_mcp_mode === "off") {
    return { label: "MCP", state: "disabled", text: "Disabled", detail: "off" };
  }
  if (status.runtime.playwright_mcp_mode === "manifest") {
    return { label: "MCP", state: "neutral", text: "Manifest only", detail: "no rehearsal" };
  }
  return status.runtime.playwright_mcp_command_set
    ? { label: "MCP", state: "ready", text: "Ready", detail: status.runtime.playwright_mcp_mode }
    : { label: "MCP", state: "missing", text: "Missing", detail: "command required" };
}

function renderConfigItem(row) {
  return `<div class="config-item ${row.state}"><strong>${row.label}</strong><span>${row.text}</span><small>${row.detail}</small></div>`;
}
