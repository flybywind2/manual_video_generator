const form = document.querySelector("#job-form");
const sampleButton = document.querySelector("#load-sample");
const navLinks = Array.from(document.querySelectorAll(".nav-links a[href^='#']"));
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
const artifactEditorFriendly = document.querySelector("#artifact-editor-friendly");
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
const WorkflowStep = Object.freeze({
  PLAN_REVIEW: "plan_review",
  CAPTURE: "capture",
  MCP_REHEARSAL_AFTER_LOGIN: "mcp_rehearsal_after_login",
  REPLAY: "replay",
  MASKING: "masking",
  TTS: "tts",
  PREVIEW: "preview",
  RENDER: "render",
  OPENCODE: "opencode",
  MANIFEST: "manifest",
  COMPLETED: "completed",
  EXECUTION_FAILED: "execution_failed",
});
const workflowUiState = Object.freeze({
  [WorkflowStep.PLAN_REVIEW]: {
    workflowIndex: 1,
    pipelineIndex: 1,
    label: "Plan review",
  },
  [WorkflowStep.CAPTURE]: {
    workflowIndex: 2,
    pipelineIndex: 2,
    label: "Capture",
    message: "브라우저 캡처를 실행 중입니다.",
  },
  [WorkflowStep.MCP_REHEARSAL_AFTER_LOGIN]: {
    workflowIndex: 2,
    pipelineIndex: 1,
    label: "MCP rehearsal",
    message: "로그인 이후 지연된 Playwright MCP 리허설을 실행 중입니다.",
  },
  [WorkflowStep.REPLAY]: {
    workflowIndex: 2,
    pipelineIndex: 2,
    label: "Replay",
    message: "시연 기록을 내레이션 타이밍에 맞춰 재녹화 중입니다.",
  },
  [WorkflowStep.MASKING]: {
    workflowIndex: 2,
    pipelineIndex: 3,
    label: "Masking",
    message: "캡처와 로그의 민감 정보를 마스킹 중입니다.",
  },
  [WorkflowStep.TTS]: {
    workflowIndex: 3,
    pipelineIndex: 4,
    label: "TTS",
    message: "자막과 한국어 내레이션을 생성 중입니다.",
  },
  [WorkflowStep.PREVIEW]: {
    workflowIndex: 4,
    pipelineIndex: 5,
    label: "Preview",
    message: "미리보기와 텍스트 매뉴얼을 생성 중입니다.",
  },
  [WorkflowStep.RENDER]: {
    workflowIndex: 5,
    pipelineIndex: 5,
    label: "Rendering",
    message: "영상 렌더를 실행 중입니다.",
  },
  [WorkflowStep.OPENCODE]: {
    workflowIndex: 5,
    pipelineIndex: 5,
    label: "OpenCode",
    message: "선택적 OpenCode 후처리를 실행 중입니다.",
  },
  [WorkflowStep.MANIFEST]: {
    workflowIndex: 5,
    pipelineIndex: 5,
    label: "Packaging",
    message: "산출물 패키지를 확정 중입니다.",
  },
  [WorkflowStep.COMPLETED]: {
    workflowIndex: 5,
    pipelineIndex: 5,
    label: "Completed",
    message: "산출물 패키지 생성이 완료되었습니다.",
  },
  [WorkflowStep.EXECUTION_FAILED]: {
    workflowIndex: 2,
    pipelineIndex: 2,
    label: "Failed",
    message: "실행 중 오류가 발생했습니다.",
  },
});
let currentDraft = null;
let currentArtifactEditor = null;
let workflowPollTimer = null;

loadConfigStatus();

navLinks.forEach((link) => {
  link.addEventListener("click", (event) => {
    const targetId = link.getAttribute("href")?.slice(1);
    const target = targetId ? document.getElementById(targetId) : null;
    if (!target) return;
    event.preventDefault();
    target.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveNav(link.getAttribute("href") || "");
  });
});

sampleButton?.addEventListener("click", () => {
  clearWorkflowPoll();
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
  clearWorkflowPoll();
  currentDraft = null;
  setBusy(true, "계획 생성 중...");
  setWorkflowStep(0);
  setPipelineProgress(0);
  setStatus("Planning");
  setArtifactLoading(planningMessage());

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
  const control = event.target?.closest("[data-action]");
  const action = control?.dataset?.action;
  if (action === "close-artifact-editor") {
    closeArtifactEditor();
  }
  if (action === "show-friendly-artifact") {
    showArtifactEditorMode("friendly");
  }
  if (action === "show-raw-artifact") {
    showArtifactEditorMode("raw");
  }
  if (action === "save-artifact-editor") {
    await saveArtifactEditor();
  }
  if (action === "add-json-item") {
    addJsonItem(parseJsonPath(control.dataset.jsonPath));
  }
  if (action === "remove-json-item") {
    removeJsonItem(parseJsonPath(control.dataset.jsonPath));
  }
});

artifactEditorFriendly?.addEventListener("input", handleFriendlyJsonEdit);
artifactEditorFriendly?.addEventListener("change", handleFriendlyJsonEdit);

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
  setButtonLoading(button, true, "실행 중...");
  setBusy(true, "실행 중...");
  setWorkflowStep(2);
  setPipelineProgress(2);
  setStatus("Running");
  setArtifactLoading(continueMessage(currentDraft));
  startWorkflowPolling(workflowStateUrlForDraft(currentDraft));

  try {
    const response = await fetch(`/api/pipeline/continue/${encodeURIComponent(jobId)}`, {
      method: "POST",
    });
    if (!response.ok) {
      throw new Error(`Continue failed: ${response.status}`);
    }

    const result = await response.json();
    currentDraft = null;
    clearWorkflowPoll();
    setWorkflowStep(5);
    setPipelineProgress(5);
    setStatus("Completed");
    renderArtifacts(result);
  } catch (error) {
    clearWorkflowPoll();
    setButtonLoading(button, false);
    setStatus("Failed");
    renderPlanReview(currentDraft, error.message || "승인 후 실행 중 오류가 발생했습니다.");
  } finally {
    setBusy(false);
  }
}

function workflowStateUrlForDraft(draft) {
  return draft?.supporting_artifacts?.workflow_state || draft?.artifacts?.workflow_state_url || "";
}

function startWorkflowPolling(url) {
  clearWorkflowPoll();
  if (!url) return;
  pollWorkflowState(url);
  workflowPollTimer = window.setInterval(() => pollWorkflowState(url), 1200);
}

function clearWorkflowPoll() {
  if (!workflowPollTimer) return;
  window.clearInterval(workflowPollTimer);
  workflowPollTimer = null;
}

function setActiveNav(href) {
  navLinks.forEach((link) => {
    link.classList.toggle("is-active", link.getAttribute("href") === href);
  });
}

async function pollWorkflowState(url) {
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return;
    const state = await response.json();
    applyWorkflowState(state);
    if (state.status === "completed" || state.status === "failed") {
      clearWorkflowPoll();
    }
  } catch (_error) {
    // The continue request still owns the final error handling.
  }
}

function applyWorkflowState(state) {
  if (!state) return;
  const workflowIndex = workflowStepIndexForState(state);
  const pipelineIndex = pipelineProgressIndexForState(state);
  setWorkflowStep(workflowIndex);
  setPipelineProgress(pipelineIndex);
  setStatus(workflowStatusLabel(state));
  const message = state.details?.message || workflowMessageForState(state);
  if (artifactStatus && message) artifactStatus.textContent = message;
}

function workflowStepIndexForState(state) {
  const step = String(state.current_step || "");
  if (workflowUiState[step]) return workflowUiState[step].workflowIndex;
  return state.status === "completed" ? 5 : 0;
}

function pipelineProgressIndexForState(state) {
  const step = String(state.current_step || "");
  if (workflowUiState[step]) return workflowUiState[step].pipelineIndex;
  return state.status === "completed" ? 5 : 0;
}

function workflowStatusLabel(state) {
  if (state.status === "completed") return "Completed";
  if (state.status === "failed") return "Failed";
  const step = String(state.current_step || "");
  return workflowUiState[step]?.label || "Running";
}

function workflowMessageForState(state) {
  const step = String(state.current_step || "");
  return workflowUiState[step]?.message || "";
}

async function rerenderPackage(jobId, button) {
  if (!jobId) return;
  setButtonLoading(button, true, "재렌더링 중...");
  setBusy(true, "재렌더링 중...");
  setWorkflowStep(5);
  setPipelineProgress(5);
  setStatus("Rerendering");
  setArtifactLoading(`작업 ${jobId} 패키지 기반으로 TTS, 미리보기, 영상 렌더를 다시 생성합니다.`);
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
    setButtonLoading(button, false);
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
  setButtonLoading(submitButton, isBusy, label || "실행 중...");
}

function loadingSpinnerHtml(label = "작업이 진행 중입니다") {
  return `
    <span class="loading-spinner" aria-hidden="true"></span>
    <span class="loading-label">${escapeHtml(label)}</span>
  `;
}

function setButtonLoading(button, isLoading, label = "작업이 진행 중입니다") {
  if (!button) return;
  if (!button.dataset.defaultHtml) {
    button.dataset.defaultHtml = button.innerHTML;
  }
  button.classList.toggle("is-loading", isLoading);
  button.disabled = isLoading;
  if (isLoading) {
    button.setAttribute("aria-busy", "true");
    button.innerHTML = loadingSpinnerHtml(label);
    return;
  }
  button.removeAttribute("aria-busy");
  button.innerHTML = button.dataset.defaultHtml;
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
  artifactLinks?.removeAttribute("aria-busy");
}

function setArtifactLoading(message = "작업이 진행 중입니다") {
  if (artifactStatus) artifactStatus.textContent = message;
  if (!artifactLinks) return;
  artifactLinks.setAttribute("aria-busy", "true");
  artifactLinks.innerHTML = `
    <div class="artifact-loading" role="status" aria-live="polite">
      ${loadingSpinnerHtml(message)}
    </div>
  `;
}

function renderPlanReview(draft, errorMessage = "") {
  const actions = draft.plan?.actions || [];
  const steps = draft.plan?.steps || [];
  const dangerActions = draft.approval?.danger_actions || [];
  artifactStatus.textContent = `작업 ${draft.job_id} 계획 검수 대기 중입니다. 승인해야 캡처와 영상 렌더가 시작됩니다.`;

  const supporting = draft.supporting_artifacts || {};
  const artifacts = draft.artifacts || {};
  artifactLinks?.removeAttribute("aria-busy");
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
  artifactLinks?.removeAttribute("aria-busy");
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
    ["Selector Trace", supporting.selector_trace || result.artifacts.selector_trace_url],
    ["Support Log", supporting.support_log || result.artifacts.support_log_url],
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
    ${renderDegradationPanel(result.degradations || [])}
    <div class="artifact-link-grid">
      ${links.map(([label, url]) => artifactAnchor(label, url)).join("")}
    </div>
  `;
}

function renderDegradationPanel(degradations) {
  if (!Array.isArray(degradations) || !degradations.length) return "";
  return `
    <section class="degradation-panel" aria-label="Degraded 상태">
      <h3>확인 필요</h3>
      <div>
        ${degradations.map((item) => {
          const reason = degradationReasonInfo(item.reason);
          return `
            <article>
              <strong>${escapeHtml(reason.label)}</strong>
              <p>${escapeHtml(reason.action)}</p>
              <small>${escapeHtml(item.actor || "")} · ${escapeHtml(item.reason || "")}</small>
            </article>
          `;
        }).join("")}
      </div>
    </section>
  `;
}

function degradationReasonInfo(reason) {
  const labels = {
    browser_capture_disabled: ["브라우저 캡처 비활성화", "실제 화면 녹화 없이 placeholder 기반으로 패키지를 만들었습니다."],
    tts_silent_fallback: ["TTS fallback", "음성 엔진을 사용할 수 없어 무음 wav가 들어갔습니다. TTS 설정과 모델 캐시를 확인하세요."],
    hyperframes_fallback_video: ["HyperFrames fallback", "MP4 렌더 대신 WebM 또는 fallback 영상을 사용했습니다. FFmpeg/HyperFrames 설정을 확인하세요."],
    opencode_failed: ["OpenCode 실패", "선택적 OpenCode 후처리가 실패했습니다. 패키지 자체는 계속 검수할 수 있습니다."],
    login_required: ["로그인 필요", "로그인 화면이 감지되어 자동 실행이 중단되었습니다. 직접 로그인 또는 .env credentials를 설정하세요."],
    demonstration_replay_failed: ["시연 replay 실패", "직접 시연 원본은 보존됐지만 음성 타이밍 기준 재녹화가 실패했습니다."],
  };
  const [label, action] = labels[reason] || ["Degraded 상태", "패키지 매니페스트와 관련 로그에서 상세 원인을 확인하세요."];
  return { label, action };
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
  if (!artifactEditorModal || !artifactEditorText || !artifactEditorPath || !artifactEditorStatus || !artifactEditorFriendly) return;
  const apiUrl = artifactTextApiUrl(url);
  currentArtifactEditor = { url, apiUrl, label };
  artifactEditorModal.hidden = false;
  artifactEditorText.value = "";
  artifactEditorText.disabled = true;
  artifactEditorFriendly.innerHTML = `
    <div class="artifact-empty-state artifact-loading" role="status">
      ${loadingSpinnerHtml("산출물을 불러오는 중입니다.")}
    </div>
  `;
  showArtifactEditorMode("friendly");
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
    currentArtifactEditor.contentType = parseArtifactContent(payload.name || url, payload.content || "");
    renderFriendlyArtifact(currentArtifactEditor.contentType, label);
    artifactEditorText.disabled = false;
    artifactEditorStatus.textContent = currentArtifactEditor.contentType.kind === "plain"
      ? "원본 편집에서 내용을 수정할 수 있습니다."
      : "쉬운 보기에서 구조를 확인하고, 원본 편집에서 저장할 수 있습니다.";
    if (artifactEditorSaveButton) artifactEditorSaveButton.disabled = false;
    showArtifactEditorMode(currentArtifactEditor.contentType.kind === "plain" ? "raw" : "friendly");
  } catch (error) {
    artifactEditorStatus.textContent = error.message || "텍스트 산출물을 불러오지 못했습니다.";
  }
}

async function saveArtifactEditor() {
  if (!currentArtifactEditor || !artifactEditorText || !artifactEditorStatus || !artifactEditorSaveButton) return;
  setButtonLoading(artifactEditorSaveButton, true, "저장 중...");
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
    setButtonLoading(artifactEditorSaveButton, false);
  }
}

function closeArtifactEditor() {
  if (!artifactEditorModal) return;
  artifactEditorModal.hidden = true;
  currentArtifactEditor = null;
}

function parseArtifactContent(name, content) {
  const lowerName = String(name || "").toLowerCase();
  if (lowerName.endsWith(".json")) {
    try {
      return { kind: "json", name, data: JSON.parse(content) };
    } catch (error) {
      return { kind: "plain", name, content, error: error.message };
    }
  }
  if (lowerName.endsWith(".jsonl")) {
    try {
      const rows = content.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
      return { kind: "jsonl", name, data: rows };
    } catch (error) {
      return { kind: "plain", name, content, error: error.message };
    }
  }
  return { kind: "plain", name, content };
}

function renderFriendlyArtifact(parsed, label) {
  if (!artifactEditorFriendly) return;
  if (!parsed || parsed.kind === "plain") {
    artifactEditorFriendly.innerHTML = `
      <div class="artifact-empty-state">
        <strong>${escapeHtml(label)}</strong>
        <span>이 산출물은 원본 편집 화면에서 바로 수정합니다.</span>
      </div>
    `;
    return;
  }
  const data = parsed.data;
  const summary = renderArtifactSummary(data, parsed.name);
  const overview = renderKnownArtifact(parsed.name, data);
  const editor = renderEditableJsonEditor(data, parsed.kind);
  artifactEditorFriendly.innerHTML = `
    <div class="friendly-artifact">
      ${summary}
      ${overview ? `<div class="friendly-section">${overview}</div>` : ""}
      <div class="friendly-section">
        <div class="friendly-edit-heading">
          <h3>직접 편집</h3>
          <span>값을 바꾸면 원본 편집 내용도 같이 갱신됩니다. 저장 버튼을 눌러 파일에 반영합니다.</span>
        </div>
        ${editor}
      </div>
    </div>
  `;
}

function renderArtifactSummary(data, name) {
  const pathName = String(name || "").toLowerCase();
  const items = [];
  if (Array.isArray(data)) {
    items.push(["항목", data.length]);
  } else if (data && typeof data === "object") {
    if (data.status) items.push(["상태", data.status]);
    if (data.planner) items.push(["Planner", data.planner]);
    if (data.renderer) items.push(["Renderer", data.renderer]);
    if (Array.isArray(data.steps)) items.push(["단계", data.steps.length]);
    if (Array.isArray(data.actions)) items.push(["액션", data.actions.length]);
    if (Array.isArray(data.entries)) items.push(["로그", data.entries.length]);
    if (Array.isArray(data.degradations)) items.push(["Degrade", data.degradations.length]);
    if (data.artifacts && typeof data.artifacts === "object") items.push(["산출물", Object.keys(data.artifacts).length]);
    if (!items.length) items.push(["필드", Object.keys(data).length]);
  }
  if (pathName.includes("action_plan")) items.unshift(["유형", "Action Plan"]);
  if (pathName.includes("media_plan")) items.unshift(["유형", "Media Plan"]);
  if (pathName.includes("package_manifest")) items.unshift(["유형", "Package Manifest"]);
  if (pathName.includes("tts_metadata")) items.unshift(["유형", "TTS Metadata"]);
  if (pathName.includes("capture_action_log")) items.unshift(["유형", "Capture Log"]);
  if (pathName.includes("selector_trace")) items.unshift(["유형", "Selector Trace"]);
  return `<div class="friendly-summary">${items.map(([key, value]) => `
    <div class="friendly-summary-card"><span>${escapeHtml(key)}</span><strong>${escapeHtml(formatJsonValue(value))}</strong></div>
  `).join("")}</div>`;
}

function renderKnownArtifact(name, data) {
  const lowerName = String(name || "").toLowerCase();
  if (!data || typeof data !== "object") return "";
  if (lowerName.includes("action_plan") || lowerName.includes("media_plan")) {
    return renderPlanArtifact(data);
  }
  if (lowerName.includes("tts_metadata")) {
    return renderEntryCards(data.entries || [], "음성");
  }
  if (lowerName.includes("selector_trace")) {
    return renderSelectorTraceArtifact(data);
  }
  if (lowerName.includes("capture_action_log") || lowerName.includes("rehearsal") || lowerName.includes("mcp")) {
    return renderEntryCards(Array.isArray(data) ? data : data.entries || data.calls || [], "로그");
  }
  if (lowerName.includes("package_manifest")) {
    return renderManifestArtifact(data);
  }
  return "";
}

function renderSelectorTraceArtifact(data) {
  const selectors = Array.isArray(data.selectors) ? data.selectors : [];
  return `
    <section class="friendly-block">
      <h3>사용된 Selector</h3>
      ${selectors.length ? `<div class="friendly-card-list">${selectors.slice(0, 120).map((item, index) => `
        <article class="friendly-card selector-card">
          <span>${escapeHtml(item.type || "selector")} · ${index + 1}</span>
          <strong><code>${escapeHtml(item.selector || "")}</code></strong>
          <p>${escapeHtml([item.label, item.step_id, item.source].filter(Boolean).join(" · "))}</p>
          ${renderKeyValueList(item, { compact: true, exclude: ["selector", "label", "step_id", "source"] })}
        </article>
      `).join("")}</div>` : `<div class="artifact-empty-state">selector 기록 없음</div>`}
    </section>
  `;
}

function renderPlanArtifact(data) {
  const steps = Array.isArray(data.steps) ? data.steps : [];
  const actions = Array.isArray(data.actions) ? data.actions : [];
  return `
    <div class="friendly-columns">
      <section>
        <h3>단계</h3>
        ${steps.length ? steps.map((step, index) => `
          <article class="friendly-card">
            <span>Step ${index + 1}</span>
            <strong>${escapeHtml(step.title || step.id || "단계")}</strong>
            <p>${escapeHtml(step.caption || step.narration || "")}</p>
          </article>
        `).join("") : `<div class="artifact-empty-state">단계 없음</div>`}
      </section>
      <section>
        <h3>액션</h3>
        ${actions.length ? actions.map((action, index) => `
          <article class="friendly-card">
            <span>${escapeHtml(action.type || "action")} · ${index + 1}</span>
            <strong>${escapeHtml(action.label || action.text || action.selector || action.target || action.id || "동작")}</strong>
            <p>${escapeHtml(action.value || action.reason || action.step_id || "")}</p>
          </article>
        `).join("") : `<div class="artifact-empty-state">액션 없음</div>`}
      </section>
    </div>
  `;
}

function renderManifestArtifact(data) {
  return `
    <div class="friendly-columns">
      <section>
        <h3>주요 산출물</h3>
        ${renderKeyValueList(data.artifacts || {})}
      </section>
      <section>
        <h3>보조 산출물</h3>
        ${renderKeyValueList(data.supporting_artifacts || {})}
      </section>
    </div>
    ${data.artifact_dependencies ? `
      <section class="friendly-block">
        <h3>재렌더링 영향</h3>
        ${renderKeyValueList(data.artifact_dependencies)}
      </section>
    ` : ""}
    ${Array.isArray(data.degradations) && data.degradations.length ? `
      <section class="friendly-block">
        <h3>Degraded 항목</h3>
        ${renderEntryCards(data.degradations.map((item) => ({ ...item, reason: degradationReasonInfo(item.reason).label, action: degradationReasonInfo(item.reason).action })), "Degrade")}
      </section>
    ` : ""}
  `;
}

function renderEntryCards(entries, label) {
  if (!Array.isArray(entries) || !entries.length) {
    return `<div class="artifact-empty-state">${escapeHtml(label)} 항목 없음</div>`;
  }
  return `<div class="friendly-card-list">${entries.slice(0, 80).map((entry, index) => `
    <article class="friendly-card">
      <span>${escapeHtml(label)} ${index + 1}</span>
      <strong>${escapeHtml(entry.title || entry.type || entry.actor || entry.step_id || entry.status || "항목")}</strong>
      <p>${escapeHtml(entry.text || entry.caption || entry.reason || entry.error || entry.degrade_reason || entry.value || "")}</p>
      ${renderKeyValueList(entry, { compact: true, exclude: ["title", "caption", "text"] })}
    </article>
  `).join("")}</div>`;
}

function renderKeyValueList(value, options = {}) {
  if (!value || typeof value !== "object") return "";
  const exclude = new Set(options.exclude || []);
  return `<dl class="${options.compact ? "friendly-kv compact" : "friendly-kv"}">${Object.entries(value)
    .filter(([key]) => !exclude.has(key))
    .slice(0, 80)
    .map(([key, item]) => `
      <div><dt>${escapeHtml(formatJsonLabel(key))}</dt><dd>${escapeHtml(formatJsonValue(item))}</dd></div>
    `).join("")}</dl>`;
}

function renderGenericJsonValue(value, label = "값", depth = 0) {
  if (Array.isArray(value)) {
    return `
      <details class="friendly-tree" ${depth < 2 ? "open" : ""}>
        <summary>${escapeHtml(formatJsonLabel(label))} <span>${value.length}개 항목</span></summary>
        <div>${value.map((item, index) => renderGenericJsonValue(item, `${index + 1}`, depth + 1)).join("")}</div>
      </details>
    `;
  }
  if (value && typeof value === "object") {
    return `
      <details class="friendly-tree" ${depth < 2 ? "open" : ""}>
        <summary>${escapeHtml(formatJsonLabel(label))} <span>${Object.keys(value).length}개 필드</span></summary>
        <div>${Object.entries(value).map(([key, item]) => renderGenericJsonValue(item, key, depth + 1)).join("")}</div>
      </details>
    `;
  }
  return `<div class="friendly-leaf"><span>${escapeHtml(formatJsonLabel(label))}</span><strong>${escapeHtml(formatJsonValue(value))}</strong></div>`;
}

function renderEditableJsonEditor(value, kind = "json") {
  return `<div class="friendly-edit-editor" data-json-kind="${escapeHtml(kind)}">${renderEditableJsonValue(value, [], "전체 내용", 0)}</div>`;
}

function renderEditableJsonValue(value, path = [], label = "값", depth = 0) {
  const pathAttr = escapeHtml(jsonPathAttr(path));
  const formattedLabel = escapeHtml(formatJsonLabel(label));
  if (Array.isArray(value)) {
    return `
      <details class="friendly-edit-node" ${depth < 2 ? "open" : ""}>
        <summary>
          <span>${formattedLabel}</span>
          <strong>${value.length}개 항목</strong>
          <button class="friendly-mini-button" type="button" data-action="add-json-item" data-json-path="${pathAttr}">항목 추가</button>
        </summary>
        <div class="friendly-edit-children">
          ${value.map((item, index) => `
            <div class="friendly-edit-item">
              <div class="friendly-edit-item-bar">
                <span>${index + 1}번 항목</span>
                <button class="friendly-mini-button danger" type="button" data-action="remove-json-item" data-json-path="${escapeHtml(jsonPathAttr([...path, index]))}">삭제</button>
              </div>
              ${renderEditableJsonValue(item, [...path, index], `${index + 1}`, depth + 1)}
            </div>
          `).join("")}
        </div>
      </details>
    `;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value);
    return `
      <details class="friendly-edit-node" ${depth < 2 ? "open" : ""}>
        <summary>
          <span>${formattedLabel}</span>
          <strong>${entries.length}개 필드</strong>
          <button class="friendly-mini-button" type="button" data-action="add-json-item" data-json-path="${pathAttr}">필드 추가</button>
        </summary>
        <div class="friendly-edit-children">
          ${entries.map(([key, item]) => `
            <div class="friendly-edit-item">
              <div class="friendly-edit-item-bar">
                <label>
                  <span>필드</span>
                  <input class="friendly-key-input" data-action="rename-json-key" data-parent-path="${pathAttr}" data-json-key="${escapeHtml(key)}" value="${escapeHtml(key)}" />
                </label>
                <button class="friendly-mini-button danger" type="button" data-action="remove-json-item" data-json-path="${escapeHtml(jsonPathAttr([...path, key]))}">삭제</button>
              </div>
              ${renderEditableJsonValue(item, [...path, key], key, depth + 1)}
            </div>
          `).join("")}
        </div>
      </details>
    `;
  }
  return renderEditablePrimitive(value, path, label);
}

function renderEditablePrimitive(value, path, label) {
  const pathAttr = escapeHtml(jsonPathAttr(path));
  const labelText = escapeHtml(formatJsonLabel(label));
  if (typeof value === "boolean") {
    return `
      <label class="friendly-edit-field">
        <span>${labelText}</span>
        <select data-action="edit-json-value" data-json-path="${pathAttr}" data-json-type="boolean">
          <option value="true" ${value ? "selected" : ""}>예</option>
          <option value="false" ${!value ? "selected" : ""}>아니오</option>
        </select>
      </label>
    `;
  }
  if (typeof value === "number") {
    return `
      <label class="friendly-edit-field">
        <span>${labelText}</span>
        <input type="number" data-action="edit-json-value" data-json-path="${pathAttr}" data-json-type="number" value="${escapeHtml(value)}" />
      </label>
    `;
  }
  if (value === null) {
    return `
      <label class="friendly-edit-field">
        <span>${labelText}</span>
        <input data-action="edit-json-value" data-json-path="${pathAttr}" data-json-type="null" value="null" />
      </label>
    `;
  }
  return `
    <label class="friendly-edit-field">
      <span>${labelText}</span>
      <textarea rows="2" data-action="edit-json-value" data-json-path="${pathAttr}" data-json-type="string">${escapeHtml(value ?? "")}</textarea>
    </label>
  `;
}

function handleFriendlyJsonEdit(event) {
  const control = event.target?.closest("[data-action]");
  if (!control || !currentArtifactEditor?.contentType || currentArtifactEditor.contentType.kind === "plain") return;
  const action = control.dataset.action;
  if (action === "edit-json-value") {
    const path = parseJsonPath(control.dataset.jsonPath);
    const nextValue = coerceJsonInputValue(control.value, control.dataset.jsonType);
    const data = setJsonPathValue(currentArtifactEditor.contentType.data, path, nextValue);
    currentArtifactEditor.contentType.data = data;
    syncFriendlyEditorToRaw("쉬운 보기 변경사항이 원본 편집에 반영되었습니다. 저장을 누르면 파일에 반영됩니다.");
  }
  if (action === "rename-json-key" && event.type === "change") {
    renameJsonKey(parseJsonPath(control.dataset.parentPath), control.dataset.jsonKey || "", control.value);
  }
}

function addJsonItem(path) {
  if (!currentArtifactEditor?.contentType || currentArtifactEditor.contentType.kind === "plain") return;
  const target = getJsonPathValue(currentArtifactEditor.contentType.data, path);
  if (Array.isArray(target)) {
    target.push(defaultJsonValueForArray(target));
  } else if (target && typeof target === "object") {
    target[nextJsonFieldName(target)] = "";
  }
  syncFriendlyEditorToRaw("항목을 추가했습니다. 저장을 누르면 파일에 반영됩니다.", { rerender: true });
}

function removeJsonItem(path) {
  if (!currentArtifactEditor?.contentType || currentArtifactEditor.contentType.kind === "plain") return;
  if (!path.length) return;
  const parent = getJsonPathValue(currentArtifactEditor.contentType.data, path.slice(0, -1));
  const key = path[path.length - 1];
  if (Array.isArray(parent) && Number.isInteger(key)) {
    parent.splice(key, 1);
  } else if (parent && typeof parent === "object") {
    delete parent[key];
  }
  syncFriendlyEditorToRaw("항목을 삭제했습니다. 저장을 누르면 파일에 반영됩니다.", { rerender: true });
}

function renameJsonKey(parentPath, oldKey, nextKey) {
  if (!currentArtifactEditor?.contentType || currentArtifactEditor.contentType.kind === "plain") return;
  const parent = getJsonPathValue(currentArtifactEditor.contentType.data, parentPath);
  const trimmed = String(nextKey || "").trim();
  if (!parent || typeof parent !== "object" || Array.isArray(parent) || !oldKey || !trimmed) {
    syncFriendlyEditorToRaw("필드 이름을 변경하지 못했습니다.", { rerender: true });
    return;
  }
  if (oldKey === trimmed) return;
  const finalKey = Object.prototype.hasOwnProperty.call(parent, trimmed) ? nextJsonFieldName(parent, trimmed) : trimmed;
  parent[finalKey] = parent[oldKey];
  delete parent[oldKey];
  syncFriendlyEditorToRaw("필드 이름을 변경했습니다. 저장을 누르면 파일에 반영됩니다.", { rerender: true });
}

function syncFriendlyEditorToRaw(message = "", options = {}) {
  if (!currentArtifactEditor?.contentType || !artifactEditorText) return;
  const parsed = currentArtifactEditor.contentType;
  if (parsed.kind === "json") {
    artifactEditorText.value = `${JSON.stringify(parsed.data, null, 2)}\n`;
  } else if (parsed.kind === "jsonl" && Array.isArray(parsed.data)) {
    artifactEditorText.value = `${parsed.data.map((row) => JSON.stringify(row)).join("\n")}\n`;
  }
  if (message && artifactEditorStatus) artifactEditorStatus.textContent = message;
  if (options.rerender) renderFriendlyArtifact(parsed, currentArtifactEditor.label);
}

function refreshFriendlyEditorFromRaw() {
  if (!currentArtifactEditor || !artifactEditorText) return;
  const parsed = parseArtifactContent(currentArtifactEditor.contentType?.name || currentArtifactEditor.url, artifactEditorText.value);
  currentArtifactEditor.contentType = parsed;
  renderFriendlyArtifact(parsed, currentArtifactEditor.label);
}

function getJsonPathValue(root, path) {
  return path.reduce((value, key) => (value == null ? undefined : value[key]), root);
}

function setJsonPathValue(root, path, nextValue) {
  if (!path.length) return nextValue;
  const parent = getJsonPathValue(root, path.slice(0, -1));
  if (parent == null) return root;
  parent[path[path.length - 1]] = nextValue;
  return root;
}

function parseJsonPath(value) {
  if (!value) return [];
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    return [];
  }
}

function jsonPathAttr(path) {
  return encodeURIComponent(JSON.stringify(path));
}

function coerceJsonInputValue(value, type) {
  if (type === "boolean") return value === "true";
  if (type === "number") {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }
  if (type === "null") return value === "null" || value === "" ? null : value;
  return value;
}

function defaultJsonValueForArray(items) {
  const sample = items.find((item) => item !== null && item !== undefined);
  if (Array.isArray(sample)) return [];
  if (sample && typeof sample === "object") return {};
  if (typeof sample === "number") return 0;
  if (typeof sample === "boolean") return false;
  return "";
}

function nextJsonFieldName(target, base = "new_field") {
  const normalized = String(base || "new_field").trim() || "new_field";
  if (!Object.prototype.hasOwnProperty.call(target, normalized)) return normalized;
  let index = 2;
  while (Object.prototype.hasOwnProperty.call(target, `${normalized}_${index}`)) {
    index += 1;
  }
  return `${normalized}_${index}`;
}

function showArtifactEditorMode(mode) {
  const isRaw = mode === "raw";
  if (!isRaw && currentArtifactEditor?.contentType?.kind !== "plain") {
    refreshFriendlyEditorFromRaw();
  }
  if (artifactEditorFriendly) artifactEditorFriendly.hidden = isRaw;
  if (artifactEditorText) {
    artifactEditorText.hidden = !isRaw;
    if (isRaw) artifactEditorText.focus();
  }
  artifactEditorModal?.querySelectorAll(".artifact-editor-tab").forEach((button) => {
    const action = button.dataset.action;
    button.classList.toggle("is-active", (isRaw && action === "show-raw-artifact") || (!isRaw && action === "show-friendly-artifact"));
  });
}

function formatJsonLabel(value) {
  const labels = {
    action_plan: "액션 플랜",
    approval_log: "승인 로그",
    capture_action_log: "캡처 로그",
    completion_condition: "완료 조건",
    created_at: "생성 시각",
    current_step: "현재 단계",
    degrade_reason: "강등 사유",
    input_values: "입력값",
    package_manifest: "패키지 매니페스트",
    request_text: "요청문",
    target_url: "대상 URL",
    tts_metadata: "TTS 메타데이터",
    video_render: "영상 렌더",
  };
  const key = String(value || "");
  return labels[key] || key.replaceAll("_", " ");
}

function formatJsonValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "boolean") return value ? "예" : "아니오";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 180)}...` : value;
  if (Array.isArray(value)) return `${value.length}개 항목`;
  if (typeof value === "object") return `${Object.keys(value).length}개 필드`;
  return String(value);
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
    if (status.login.credentials_configured) {
      return { label: "Login Default", state: "ready", text: "Ready", detail: "credentials" };
    }
    return status.login.selector_auto_detection_supported
      ? { label: "Login Default", state: "ready", text: "LLM selector", detail: "ID/PW selector auto" }
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
