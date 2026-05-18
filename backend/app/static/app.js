const form = document.querySelector("#job-form");
const sampleButton = document.querySelector("#load-sample");
const panelState = document.querySelector(".panel-state");
const pipelineNodes = Array.from(document.querySelectorAll(".pipeline-node"));
const artifactStatus = document.querySelector("#artifact-status");
const artifactLinks = document.querySelector("#artifact-links");
const submitButton = form?.querySelector("button[type='submit']");
const configGrid = document.querySelector("#config-grid");
const inputValues = document.querySelector("#input-values");
const inputValueList = inputValues?.querySelector("[data-input-value-list]");
const sampleInputValues = [
  { key: "LOT", value: "LOT-001" },
  { key: "라인", value: "A3" },
];

loadConfigStatus();

sampleButton?.addEventListener("click", () => {
  form.elements.request.value = "MES에서 LOT 조회 방법 영상 만들기";
  form.elements.url.value = `${window.location.origin}/sample`;
  form.elements.role.value = "작업자";
  form.elements.login_mode.value = "";
  form.elements.login_success_selector.value = "";
  form.elements.done.value = "상세 화면이 보이면 완료";
  renderInputValues(sampleInputValues);
  panelState.textContent = "Sample loaded";
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
  setBusy(true);
  setPipelineProgress(0);
  setStatus("Planning");
  setArtifactMessage("파이프라인을 실행하고 있습니다. 샘플 화면 캡처, 마스킹, 내레이션, 문서/영상 패키지를 생성합니다.");

  try {
    const payload = {
      request_text: form.elements.request.value.trim(),
      target_url: form.elements.url.value.trim(),
      role: form.elements.role.value.trim(),
      completion_condition: form.elements.done.value.trim(),
      login_mode: form.elements.login_mode.value,
      login_success_selector: form.elements.login_success_selector.value.trim(),
      input_values: readInputValues(),
    };

    const response = await fetch("/api/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Pipeline failed: ${response.status}`);
    }

    const result = await response.json();
    setPipelineProgress(5);
    setStatus("Completed");
    renderArtifacts(result);
  } catch (error) {
    setStatus("Failed");
    setArtifactMessage(error.message || "파이프라인 실행 중 오류가 발생했습니다.");
  } finally {
    setBusy(false);
  }
});

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

function setBusy(isBusy) {
  if (!submitButton) return;
  submitButton.disabled = isBusy;
  submitButton.querySelector(".play-icon").style.display = isBusy ? "none" : "inline-block";
  submitButton.lastChild.textContent = isBusy ? " 실행 중..." : " 파이프라인 실행";
}

function setStatus(status) {
  panelState.textContent = status;
}

function setPipelineProgress(activeIndex) {
  pipelineNodes.forEach((node, index) => {
    node.classList.toggle("is-active", index <= activeIndex);
    node.classList.toggle("is-complete", index < activeIndex);
  });
}

function setArtifactMessage(message) {
  artifactStatus.textContent = message;
  artifactLinks.innerHTML = "";
}

function renderArtifacts(result) {
  artifactStatus.textContent = `작업 ${result.job_id} 패키지가 생성되었습니다.`;
  const supporting = result.supporting_artifacts || {};
  const links = [
    ["HTML 미리보기", result.artifacts.html_preview_url],
    ["영상", result.artifacts.video_url],
    ["Markdown", result.artifacts.markdown_manual_url],
    ["PDF", result.artifacts.pdf_manual_url],
    ["Action JSON", result.artifacts.action_plan_url],
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
  artifactLinks.innerHTML = links
    .map(([label, url]) => `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`)
    .join("");
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
