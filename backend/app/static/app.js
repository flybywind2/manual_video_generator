const form = document.querySelector("#job-form");
const sampleButton = document.querySelector("#load-sample");
const panelState = document.querySelector(".panel-state");
const pipelineNodes = Array.from(document.querySelectorAll(".pipeline-node"));
const artifactStatus = document.querySelector("#artifact-status");
const artifactLinks = document.querySelector("#artifact-links");
const submitButton = form?.querySelector("button[type='submit']");
const configGrid = document.querySelector("#config-grid");

loadConfigStatus();

sampleButton?.addEventListener("click", () => {
  form.elements.request.value = "MES에서 LOT 조회 방법 영상 만들기";
  form.elements.url.value = `${window.location.origin}/sample`;
  form.elements.role.value = "작업자";
  form.elements.done.value = "상세 화면이 보이면 완료";
  panelState.textContent = "Sample loaded";
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
  return Array.from(document.querySelectorAll(".value-chip:not(.add-chip)")).reduce((values, chip) => {
    const [key, ...rest] = chip.textContent.split("=");
    if (key && rest.length) {
      values[key.trim()] = rest.join("=").trim();
    }
    return values;
  }, {});
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
  const links = [
    ["HTML 미리보기", result.artifacts.html_preview_url],
    ["영상 WebM", result.artifacts.video_url],
    ["Markdown", result.artifacts.markdown_manual_url],
    ["PDF", result.artifacts.pdf_manual_url],
    ["Action JSON", result.artifacts.action_plan_url],
    ["마스킹 로그", result.artifacts.masking_log_url],
    ["패키지 매니페스트", result.artifacts.package_manifest_url],
  ];
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
    const rows = [
      ["LLM", status.llm.configured, status.llm.model || "QWEN3"],
      ["VLM", status.vlm.configured, status.vlm.model || "QWEN3-VL"],
      ["RAG", status.rag.configured, status.rag.index_name || "index 미설정"],
      ["Reranker", status.reranker.configured, status.reranker.model || "model 미설정"],
      ["TTS", true, status.tts_provider],
    ];
    configGrid.innerHTML = rows
      .map(([label, configured, detail]) => {
        const state = configured ? "configured" : "missing";
        const text = configured ? "Configured" : "Missing";
        return `<div class="config-item ${state}"><strong>${label}</strong><span>${text}</span><small>${detail}</small></div>`;
      })
      .join("");
  } catch (error) {
    configGrid.innerHTML = `<span class="config-error">${error.message || "설정 상태를 불러오지 못했습니다."}</span>`;
  }
}
