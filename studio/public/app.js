const WORKFLOW_EVENT_NAMES = Object.freeze([
  "JOB_CREATED",
  "START_AUTHENTICATION",
  "AUTHENTICATED",
  "AUTH_REQUIRED",
  "AUTHENTICATION_EXPIRED",
  "AUTHENTICATION_FAILED",
  "CONFIRM_LOGIN",
  "PLAN_READY",
  "PLANNING_FAILED",
  "UPDATE_PLAN",
  "APPROVE_PLAN",
  "START_EXECUTION",
  "EXECUTION_PROGRESS",
  "EXECUTION_COMPLETED",
  "EXECUTION_FAILED",
  "EXECUTION_MISMATCH",
  "REAPPROVE_EXECUTION",
  "NARRATION_COMPLETED",
  "NARRATION_FAILED",
  "COMPOSITION_COMPLETED",
  "COMPOSITION_FAILED",
  "APPROVE_PREVIEW",
  "RENDER_COMPLETED",
  "RENDER_FAILED",
  "CANCEL_JOB",
]);

const SAFE_ERROR_MESSAGES = Object.freeze({
  INVALID_JOB_REQUEST: "입력 내용을 확인해 주세요.",
  JOB_NOT_FOUND: "작업을 찾을 수 없습니다.",
  INVALID_TRANSITION: "현재 제작 단계에서는 이 작업을 실행할 수 없습니다.",
  JOB_COMPARE_FAILED: "다른 변경이 먼저 반영되었습니다. 최신 상태를 다시 확인해 주세요.",
  ROUTE_NOT_FOUND: "아직 사용할 수 없는 기능입니다.",
  METHOD_NOT_ALLOWED: "현재 서버가 이 작업을 지원하지 않습니다.",
  CONNECTION_FAILED: "로컬 Studio 서버에 연결하지 못했습니다.",
  STREAM_FAILED: "제작 상태 연결이 끊겼습니다. 자동으로 다시 연결합니다.",
});

const EVENT_LABELS = Object.freeze({
  JOB_CREATED: "작업이 생성되었습니다.",
  START_AUTHENTICATION: "AI 브라우저를 시작합니다.",
  AUTH_REQUIRED: "직접 로그인을 기다리고 있습니다.",
  AUTHENTICATED: "로그인을 확인했습니다.",
  CONFIRM_LOGIN: "로그인 완료를 전달했습니다.",
  PLAN_READY: "검토할 실행 계획이 준비되었습니다.",
  UPDATE_PLAN: "수정한 실행 계획을 고정했습니다.",
  APPROVE_PLAN: "실행 계획을 승인했습니다.",
  START_EXECUTION: "브라우저 녹화를 시작했습니다.",
  EXECUTION_PROGRESS: "승인된 브라우저 동작을 실행 중입니다.",
  EXECUTION_COMPLETED: "브라우저 녹화를 완료했습니다.",
  NARRATION_COMPLETED: "내레이션 생성을 완료했습니다.",
  COMPOSITION_COMPLETED: "검토할 영상 미리보기가 준비되었습니다.",
  APPROVE_PREVIEW: "미리보기를 승인하고 최종 렌더를 시작했습니다.",
  RENDER_COMPLETED: "최종 매뉴얼 영상이 완성되었습니다.",
  CANCEL_JOB: "작업을 취소했습니다.",
  AUTHENTICATION_FAILED: "브라우저 연결 단계에서 멈췄습니다.",
  PLANNING_FAILED: "실행 계획 생성 단계에서 멈췄습니다.",
  EXECUTION_FAILED: "브라우저 실행 단계에서 멈췄습니다.",
  EXECUTION_MISMATCH: "실행 증거를 다시 검토해야 합니다.",
  NARRATION_FAILED: "내레이션 생성 단계에서 멈췄습니다.",
  COMPOSITION_FAILED: "미리보기 구성 단계에서 멈췄습니다.",
  RENDER_FAILED: "최종 렌더 단계에서 멈췄습니다.",
});

const STATE_VIEW = Object.freeze({
  created: [0, "작업 생성", "브라우저 연결을 준비하고 있습니다."],
  authenticating: [0, "브라우저 연결", "대상 웹서비스에 안전하게 연결하고 있습니다."],
  awaiting_manual_login: [0, "로그인 확인", "AI 브라우저에서 로그인을 완료해 주세요."],
  planning: [1, "계획 생성", "대상 화면을 읽고 안전한 실행 계획을 만들고 있습니다."],
  plan_review: [1, "계획 검토", "브라우저 실행 전에 계획을 검토하고 승인해 주세요."],
  approved: [2, "실행 대기", "승인된 계획이 고정되었습니다. 녹화를 시작할 수 있습니다."],
  executing: [2, "브라우저 녹화", "승인한 동작만 차례대로 실행하고 있습니다."],
  needs_review: [2, "증거 재검토", "계획과 실행 증거가 달라 추가 확인이 필요합니다."],
  narrating: [3, "내레이션", "장면에 맞는 한국어 내레이션을 만들고 있습니다."],
  composing: [3, "미디어 구성", "녹화, 음성, 캡션을 하나의 미리보기로 연결하고 있습니다."],
  preview_review: [4, "미리보기 검토", "최종 렌더 전에 영상의 흐름을 확인해 주세요."],
  rendering: [4, "최종 렌더", "승인한 미리보기를 최종 영상으로 렌더링하고 있습니다."],
  completed: [5, "제작 완료", "품질 검사를 통과한 매뉴얼 영상이 준비되었습니다."],
  cancelled: [-1, "취소됨", "사용자 요청으로 작업을 취소했습니다."],
  failed: [-1, "확인 필요", "오류 내용을 확인한 뒤 다시 시도해 주세요."],
});

const API_PATHS = Object.freeze({
  health: () => "/api/health",
  jobs: () => "/api/jobs",
  job: (id) => `/api/jobs/${encodeURIComponent(id)}`,
  events: (id) => `/api/jobs/${encodeURIComponent(id)}/events`,
  confirmManualLogin: (id) => `/api/jobs/${encodeURIComponent(id)}/login/manual/confirm`,
  plan: (id) => `/api/jobs/${encodeURIComponent(id)}/plan`,
  approvePlan: (id) => `/api/jobs/${encodeURIComponent(id)}/plan/approve`,
  execute: (id) => `/api/jobs/${encodeURIComponent(id)}/execute`,
  mediaPlan: (id) => `/api/jobs/${encodeURIComponent(id)}/media-plan`,
  approvePreview: (id) => `/api/jobs/${encodeURIComponent(id)}/preview/approve`,
  cancel: (id) => `/api/jobs/${encodeURIComponent(id)}/cancel`,
  credential: (id) => `/api/credentials/${encodeURIComponent(id)}`,
});

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DIGEST = /^[a-f0-9]{64}$/u;
const SCENE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;

function isPlainRecord(value) {
  try {
    return value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype;
  } catch {
    return false;
  }
}

function safeArtifactName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 512) return null;
  const parts = name.split("/");
  if (parts.some((part) => !/^[A-Za-z0-9._-]+$/u.test(part) || part === "." || part === "..")) return null;
  return parts.join("/");
}

export function readWorkflowEvent(value) {
  if (!isPlainRecord(value) || typeof value.event !== "string" || !isPlainRecord(value.data)) {
    return {};
  }
  const data = value.data;
  if (["PLAN_READY", "UPDATE_PLAN", "APPROVE_PLAN"].includes(value.event)) {
    if (isPlainRecord(data.plan) && DIGEST.test(data.planDigest ?? "")) {
      return { plan: data.plan, planDigest: data.planDigest };
    }
    return {};
  }
  if (value.event === "COMPOSITION_COMPLETED") {
    const preview = data.preview;
    if (
      isPlainRecord(preview) &&
      isPlainRecord(preview.mediaPlan) &&
      DIGEST.test(preview.planDigest ?? "") &&
      DIGEST.test(preview.previewDigest ?? "") &&
      safeArtifactName(preview.previewArtifact) !== null &&
      safeArtifactName(preview.captionsArtifact) !== null
    ) {
      return {
        previewDigest: preview.previewDigest,
        previewArtifact: preview.previewArtifact,
      };
    }
    return {};
  }
  if (value.event === "RENDER_COMPLETED") {
    const outputArtifact = safeArtifactName(data.outputArtifact);
    return outputArtifact === null ? {} : { outputArtifact };
  }
  return {};
}

export function jobIdFromLocation(locationValue) {
  try {
    const url = new URL(locationValue?.href);
    const values = url.searchParams.getAll("job");
    return values.length === 1 && JOB_ID.test(values[0]) ? values[0] : null;
  } catch {
    return null;
  }
}

export function jobUrl(locationValue, jobId) {
  try {
    if (jobId !== null && !JOB_ID.test(jobId ?? "")) return null;
    const url = new URL(locationValue?.href);
    if (jobId === null) url.searchParams.delete("job");
    else url.searchParams.set("job", jobId);
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

export function createWorkflowCursor(snapshotSequence = 0) {
  let stateSequence = Number.isSafeInteger(snapshotSequence) && snapshotSequence >= 0
    ? snapshotSequence
    : 0;
  let lastEventSequence = 0;
  return Object.freeze({
    accept(event) {
      const sequence = event?.sequence;
      if (!Number.isSafeInteger(sequence) || sequence < 1 || sequence <= lastEventSequence) {
        return { processPayload: false, renderState: false };
      }
      lastEventSequence = sequence;
      const renderState = sequence >= stateSequence;
      if (renderState) stateSequence = sequence;
      return { processPayload: true, renderState };
    },
    acceptSnapshot(sequence) {
      if (!Number.isSafeInteger(sequence) || sequence <= stateSequence) return false;
      stateSequence = sequence;
      return true;
    },
  });
}

export function responseSnapshot(result) {
  const candidate = isPlainRecord(result?.job) ? result.job : result;
  if (
    !isPlainRecord(candidate) ||
    !JOB_ID.test(candidate.id ?? "") ||
    typeof candidate.state !== "string" ||
    !Object.hasOwn(STATE_VIEW, candidate.state) ||
    !Number.isSafeInteger(candidate.eventSequence) ||
    candidate.eventSequence < 1
  ) {
    return null;
  }
  return candidate;
}

export function sendTransientCredential(api, fields) {
  if (
    typeof api?.saveCredential !== "function" ||
    typeof fields?.id?.value !== "string" ||
    typeof fields?.username?.value !== "string" ||
    typeof fields?.secret?.value !== "string"
  ) {
    throw new TypeError("credential inputs are required");
  }
  let operation;
  try {
    operation = api.saveCredential(fields.id.value, {
      username: fields.username.value,
      password: fields.secret.value,
    });
  } finally {
    fields.username.value = "";
    fields.secret.value = "";
  }
  return Promise.resolve(operation);
}

export function mediaEditRequest(fields, previewDigest) {
  if (
    !DIGEST.test(previewDigest ?? "") ||
    typeof fields?.sceneId?.value !== "string" ||
    typeof fields?.narration?.value !== "string" ||
    typeof fields?.caption?.value !== "string"
  ) {
    return null;
  }
  const sceneId = fields.sceneId.value.trim();
  const narrationText = fields.narration.value.trim();
  const captionText = fields.caption.value.trim();
  const validText = (value) => value.length <= 4_000 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
  if (
    !SCENE_ID.test(sceneId) ||
    (narrationText.length === 0 && captionText.length === 0) ||
    !validText(narrationText) ||
    !validText(captionText)
  ) {
    return null;
  }
  return {
    previewDigest,
    edit: {
      sceneId,
      ...(narrationText.length === 0 ? {} : { narrationText }),
      ...(captionText.length === 0 ? {} : { captionText }),
    },
  };
}

export class StudioApiError extends Error {
  constructor(code, status = 0) {
    super(SAFE_ERROR_MESSAGES[code] ?? "요청을 안전하게 처리하지 못했습니다.");
    this.name = "StudioApiError";
    this.code = code;
    this.status = status;
  }
}

function assertClientDependency(value, name) {
  if (typeof value !== "function") {
    throw new TypeError(`${name} is required`);
  }
  return value;
}

async function safeResponseJson(response) {
  const contentType = response.headers?.get?.("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
}

export function createStudioApi({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  EventSourceImpl = globalThis.EventSource,
} = {}) {
  const requestFetch = assertClientDependency(fetchImpl, "fetchImpl");

  const request = async (path, { method = "GET", body } = {}) => {
    const init = {
      method,
      headers: { Accept: "application/json" },
      ...(body === undefined
        ? {}
        : {
            body: JSON.stringify(body),
            headers: { Accept: "application/json", "Content-Type": "application/json" },
          }),
    };
    let response;
    try {
      response = await requestFetch(path, init);
    } catch {
      throw new StudioApiError("CONNECTION_FAILED");
    }
    const payload = await safeResponseJson(response);
    if (!response.ok) {
      const code = typeof payload?.error?.code === "string" ? payload.error.code : "REQUEST_FAILED";
      throw new StudioApiError(code, response.status);
    }
    return payload;
  };

  return Object.freeze({
    health: () => request(API_PATHS.health()),
    createJob: (input) => request(API_PATHS.jobs(), { method: "POST", body: input }),
    getJob: (jobId) => request(API_PATHS.job(jobId)),
    confirmManualLogin: (jobId) => request(API_PATHS.confirmManualLogin(jobId), { method: "POST" }),
    updatePlan: (jobId, plan, planDigest) => request(API_PATHS.plan(jobId), {
      method: "PUT",
      body: { plan, planDigest },
    }),
    approvePlan: (jobId, planDigest) => request(API_PATHS.approvePlan(jobId), {
      method: "POST",
      body: { planDigest },
    }),
    execute: (jobId, planDigest) => request(API_PATHS.execute(jobId), {
      method: "POST",
      body: { planDigest },
    }),
    editMedia: (jobId, edit, previewDigest) => request(API_PATHS.mediaPlan(jobId), {
      method: "PUT",
      body: { ...edit, previewDigest },
    }),
    approvePreview: (jobId, previewDigest) => request(API_PATHS.approvePreview(jobId), {
      method: "POST",
      body: { previewDigest },
    }),
    cancel: (jobId) => request(API_PATHS.cancel(jobId), { method: "POST" }),
    saveCredential: (credentialId, values) => request(API_PATHS.credential(credentialId), {
      method: "PUT",
      body: values,
    }),
    subscribe(jobId, { onEvent, onError = () => {} } = {}) {
      const Source = assertClientDependency(EventSourceImpl, "EventSourceImpl");
      const receive = assertClientDependency(onEvent, "onEvent");
      const source = new Source(API_PATHS.events(jobId));
      const consume = (message) => {
        try {
          const event = JSON.parse(message.data);
          if (event !== null && typeof event === "object") receive(event);
        } catch {
          onError(new StudioApiError("STREAM_FAILED"));
        }
      };
      for (const name of WORKFLOW_EVENT_NAMES) source.addEventListener(name, consume);
      source.addEventListener("error", () => onError(new StudioApiError("STREAM_FAILED")));
      return Object.freeze({ close: () => source.close() });
    },
  });
}

function artifactPath(jobId, name) {
  const safeName = safeArtifactName(name);
  if (safeName === null || !JOB_ID.test(jobId ?? "")) return null;
  return `/api/jobs/${encodeURIComponent(jobId)}/artifacts/${safeName.split("/").map(encodeURIComponent).join("/")}`;
}

function initStudio(documentValue) {
  const api = createStudioApi();
  const byId = (id) => documentValue.getElementById(id);
  const elements = {
    form: byId("job-form"),
    targetUrl: byId("target-url"),
    prompt: byId("prompt"),
    completion: byId("completion-condition"),
    promptCount: byId("prompt-count"),
    credentialField: byId("credential-field"),
    credentialId: byId("credential-id"),
    newCredentialId: byId("new-credential-id"),
    credentialUsername: byId("credential-username"),
    credentialSecret: byId("credential-secret"),
    saveCredential: byId("save-credential-button"),
    credentialSaveStatus: byId("credential-save-status"),
    createButton: byId("create-button"),
    formError: byId("form-error"),
    health: byId("health-status"),
    workflow: byId("workflow"),
    workflowSummary: byId("workflow-summary"),
    jobBadge: byId("job-badge"),
    workspace: byId("workspace"),
    jobReference: byId("job-reference"),
    globalError: byId("global-error"),
    globalErrorMessage: byId("global-error-message"),
    dismissError: byId("dismiss-error-button"),
    cancel: byId("cancel-button"),
    manualPanel: byId("manual-login-panel"),
    confirmLogin: byId("confirm-login-button"),
    planPanel: byId("plan-panel"),
    planEditor: byId("plan-editor"),
    planDigest: byId("plan-digest"),
    savePlan: byId("save-plan-button"),
    approvePlan: byId("approve-plan-button"),
    executionPanel: byId("execution-panel"),
    executionStatus: byId("execution-status"),
    executionCopy: byId("execution-copy"),
    executionProgress: byId("execution-progress"),
    execute: byId("execute-button"),
    eventLog: byId("event-log"),
    previewPanel: byId("preview-panel"),
    previewDigest: byId("preview-digest"),
    previewPlayer: byId("preview-player"),
    approvePreview: byId("approve-preview-button"),
    mediaEditForm: byId("media-edit-form"),
    mediaSceneId: byId("media-scene-id"),
    mediaNarration: byId("media-narration-text"),
    mediaCaption: byId("media-caption-text"),
    saveMediaEdit: byId("save-media-edit-button"),
    mediaEditStatus: byId("media-edit-status"),
    completedPanel: byId("completed-panel"),
    videoLink: byId("download-video-link"),
    planLink: byId("download-plan-link"),
    newJob: byId("new-job-button"),
  };

  const memory = {
    jobId: null,
    state: null,
    plan: null,
    planDigest: null,
    previewDigest: null,
    subscription: null,
    cursor: createWorkflowCursor(),
  };

  const hideError = () => {
    elements.globalError.hidden = true;
    elements.globalErrorMessage.textContent = "";
  };

  const showError = (error, { form = false } = {}) => {
    const message = error instanceof StudioApiError
      ? error.message
      : error instanceof SyntaxError
        ? "실행 계획 JSON 형식을 확인해 주세요."
        : "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    if (form) {
      elements.formError.textContent = message;
      elements.formError.hidden = false;
      return;
    }
    elements.globalErrorMessage.textContent = message;
    elements.globalError.hidden = false;
    elements.globalError.focus();
  };

  const setButtonBusy = (button, busy) => {
    button.disabled = busy;
    button.setAttribute("aria-busy", String(busy));
  };

  const updateJobUrl = (jobId) => {
    const next = jobUrl(globalThis.location, jobId);
    if (next !== null && typeof globalThis.history?.replaceState === "function") {
      globalThis.history.replaceState(null, "", next);
    }
  };

  const applySnapshot = (value) => {
    const snapshot = responseSnapshot(value);
    if (
      snapshot === null ||
      snapshot.id !== memory.jobId ||
      !memory.cursor.acceptSnapshot(snapshot.eventSequence)
    ) {
      return false;
    }
    renderState(snapshot.state);
    return true;
  };

  const runAction = async (button, action) => {
    hideError();
    setButtonBusy(button, true);
    try {
      const result = await action();
      applySnapshot(result);
      if (isPlainRecord(result?.plan) && DIGEST.test(result?.planDigest ?? "")) {
        setPlan(result.plan, result.planDigest);
      }
      return result;
    } catch (error) {
      showError(error);
      return null;
    } finally {
      setButtonBusy(button, false);
    }
  };

  const setPanelVisibility = (state) => {
    elements.manualPanel.hidden = state !== "awaiting_manual_login";
    elements.planPanel.hidden = state !== "plan_review";
    elements.executionPanel.hidden = !["approved", "executing", "needs_review", "narrating", "composing"].includes(state);
    elements.previewPanel.hidden = !["preview_review", "rendering"].includes(state);
    elements.completedPanel.hidden = state !== "completed";
  };

  const renderSteps = (stageIndex) => {
    const steps = elements.workflow.querySelectorAll("[data-stage]");
    for (const [index, step] of [...steps].entries()) {
      const status = step.querySelector("i");
      step.classList.toggle("is-complete", stageIndex > index);
      step.classList.toggle("is-active", stageIndex === index);
      status.textContent = stageIndex > index ? "완료" : stageIndex === index ? "진행" : "대기";
    }
  };

  const syncMediaEditAvailability = () => {
    const busy = elements.saveMediaEdit.getAttribute("aria-busy") === "true";
    elements.saveMediaEdit.disabled = busy || memory.state !== "preview_review" || !DIGEST.test(memory.previewDigest ?? "");
  };

  function renderState(state) {
    memory.state = state;
    const view = STATE_VIEW[state] ?? [-1, "상태 확인", "최신 제작 상태를 확인하고 있습니다."];
    elements.workspace.hidden = memory.jobId === null;
    elements.jobBadge.textContent = view[1];
    elements.workflowSummary.textContent = view[2];
    elements.executionStatus.textContent = view[1];
    setPanelVisibility(state);
    renderSteps(view[0]);
    elements.cancel.disabled = ["completed", "cancelled", "failed"].includes(state);
    elements.execute.disabled = state !== "approved";
    elements.approvePreview.disabled = state !== "preview_review";
    syncMediaEditAvailability();

    const percentages = {
      approved: 0,
      executing: 42,
      needs_review: 55,
      narrating: 70,
      composing: 86,
    };
    elements.executionProgress.style.width = `${percentages[state] ?? 0}%`;
    if (state === "executing") elements.executionCopy.textContent = "AI가 승인된 호출을 실행하며 장면별 증거와 화면을 기록하고 있습니다.";
    if (state === "narrating") elements.executionCopy.textContent = "브라우저 녹화를 마치고 장면별 한국어 내레이션을 생성하고 있습니다.";
    if (state === "composing") elements.executionCopy.textContent = "녹화, 내레이션, 캡션을 미리보기 영상으로 구성하고 있습니다.";
    if (state === "needs_review") elements.executionCopy.textContent = "실행 증거가 계획과 일치하지 않습니다. 자동 진행을 멈췄습니다.";
  }

  function setPlan(plan, digest) {
    memory.plan = plan;
    if (typeof digest === "string") memory.planDigest = digest;
    elements.planEditor.value = JSON.stringify(plan, null, 2);
    elements.planDigest.textContent = memory.planDigest ? `SHA · ${memory.planDigest.slice(0, 12)}` : "계획 확인 필요";
  }

  const setPreview = (name) => {
    const src = artifactPath(memory.jobId, name);
    if (src === null) return;
    elements.previewPlayer.src = src;
    elements.previewPlayer.parentElement.classList.add("has-video");
  };

  const setCompletedArtifacts = (videoName = "video/final.mp4") => {
    const videoUrl = artifactPath(memory.jobId, videoName) ?? artifactPath(memory.jobId, "video/final.mp4");
    const planUrl = artifactPath(memory.jobId, "plan.json");
    if (videoUrl) elements.videoLink.href = videoUrl;
    if (planUrl) elements.planLink.href = planUrl;
  };

  const appendEvent = (event) => {
    const item = documentValue.createElement("li");
    const time = documentValue.createElement("time");
    const copy = documentValue.createElement("span");
    const parsed = Date.parse(event.timestamp ?? "");
    time.textContent = Number.isNaN(parsed)
      ? `#${event.sequence ?? "–"}`
      : new Intl.DateTimeFormat("ko-KR", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(parsed);
    copy.textContent = EVENT_LABELS[event.event] ?? "제작 상태가 업데이트되었습니다.";
    item.append(time, copy);
    elements.eventLog.prepend(item);
    while (elements.eventLog.children.length > 8) elements.eventLog.lastElementChild.remove();
  };

  const handleEvent = (event) => {
    if (!isPlainRecord(event) || event.jobId !== memory.jobId) return;
    const decision = memory.cursor.accept(event);
    if (!decision.processPayload) return;
    appendEvent(event);
    const payload = readWorkflowEvent(event);
    if (payload.plan && payload.planDigest) setPlan(payload.plan, payload.planDigest);
    if (payload.previewDigest && payload.previewArtifact) {
      memory.previewDigest = payload.previewDigest;
      elements.previewDigest.textContent = memory.previewDigest
        ? `SHA · ${memory.previewDigest.slice(0, 12)}`
        : "미리보기 준비됨";
      setPreview(payload.previewArtifact);
      elements.mediaNarration.value = "";
      elements.mediaCaption.value = "";
      elements.mediaEditStatus.textContent = "새 미리보기가 준비되었습니다. 확인 후 최종 렌더를 승인하세요.";
      elements.mediaEditStatus.classList.remove("is-error");
      elements.mediaEditStatus.classList.add("is-success");
      syncMediaEditAvailability();
    }
    if (payload.outputArtifact) setCompletedArtifacts(payload.outputArtifact);
    if (decision.renderState && Object.hasOwn(STATE_VIEW, event.state ?? "")) renderState(event.state);
  };

  const subscribe = () => {
    memory.subscription?.close();
    memory.subscription = api.subscribe(memory.jobId, {
      onEvent: handleEvent,
      onError: () => {
        elements.jobBadge.textContent = "재연결 중";
        elements.workflowSummary.textContent = "제작 상태 연결을 다시 시도하고 있습니다. 작업은 서버에서 계속됩니다.";
      },
    });
  };

  const authMode = () => elements.form.querySelector("[name='auth-mode']:checked")?.value ?? "manual";
  const updateAuthFields = () => {
    const automatic = authMode() === "automatic";
    elements.credentialField.hidden = !automatic;
    elements.credentialId.disabled = !automatic;
    elements.credentialId.required = automatic;
  };

  elements.form.addEventListener("change", (event) => {
    if (event.target?.name === "auth-mode") updateAuthFields();
  });
  elements.prompt.addEventListener("input", () => {
    elements.promptCount.textContent = String(elements.prompt.value.length);
  });
  elements.saveCredential.addEventListener("click", async () => {
    elements.credentialSaveStatus.classList.remove("is-success", "is-error");
    const credentialId = elements.newCredentialId.value.trim();
    elements.newCredentialId.value = credentialId;
    if (
      !JOB_ID.test(credentialId) ||
      elements.credentialUsername.value.length === 0 ||
      elements.credentialSecret.value.length === 0
    ) {
      elements.credentialUsername.value = "";
      elements.credentialSecret.value = "";
      elements.credentialSaveStatus.textContent = "참조 이름과 로그인 값을 다시 입력해 주세요.";
      elements.credentialSaveStatus.classList.add("is-error");
      return;
    }
    setButtonBusy(elements.saveCredential, true);
    elements.credentialSaveStatus.textContent = "Windows 보호 저장소에 저장 중입니다.";
    try {
      const saving = sendTransientCredential(api, {
        id: elements.newCredentialId,
        username: elements.credentialUsername,
        secret: elements.credentialSecret,
      });
      await saving;
      let option = [...elements.credentialId.options].find(({ value }) => value === credentialId);
      if (!option) {
        option = documentValue.createElement("option");
        option.value = credentialId;
        option.textContent = credentialId;
        elements.credentialId.append(option);
      }
      elements.credentialId.value = credentialId;
      elements.newCredentialId.value = "";
      elements.credentialSaveStatus.textContent = "암호화 저장을 완료했습니다.";
      elements.credentialSaveStatus.classList.add("is-success");
    } catch (error) {
      elements.credentialSaveStatus.textContent = error instanceof StudioApiError
        ? error.message
        : "로그인 값을 저장하지 못했습니다.";
      elements.credentialSaveStatus.classList.add("is-error");
    } finally {
      elements.credentialUsername.value = "";
      elements.credentialSecret.value = "";
      setButtonBusy(elements.saveCredential, false);
    }
  });
  elements.form.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.formError.hidden = true;
    if (!elements.form.reportValidity()) return;
    setButtonBusy(elements.createButton, true);
    try {
      const condition = elements.completion.value.trim() || "요청한 최종 화면이 보이면 완료";
      const mode = authMode();
      const request = {
        targetUrl: elements.targetUrl.value.trim(),
        prompt: elements.prompt.value.trim(),
        completionCondition: condition,
        authMode: mode,
        voice: "F1",
        ...(mode === "automatic" ? { credentialId: elements.credentialId.value } : {}),
      };
      const created = await api.createJob(request);
      if (!isPlainRecord(created) || !JOB_ID.test(created.id ?? "")) {
        throw new StudioApiError("CONNECTION_FAILED");
      }
      memory.jobId = created.id;
      memory.plan = null;
      memory.planDigest = null;
      memory.previewDigest = null;
      memory.cursor = createWorkflowCursor();
      elements.jobReference.textContent = `작업 ${created.id} · ${created.request?.targetUrl ?? request.targetUrl}`;
      elements.eventLog.replaceChildren();
      elements.previewPlayer.removeAttribute("src");
      elements.previewPlayer.parentElement.classList.remove("has-video");
      elements.mediaEditForm.reset();
      elements.mediaEditStatus.textContent = "내레이션과 자막 중 하나 이상을 입력하세요.";
      elements.mediaEditStatus.classList.remove("is-success", "is-error");
      elements.workspace.hidden = false;
      updateJobUrl(created.id);
      applySnapshot(created);
      subscribe();
      elements.workspace.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (error) {
      showError(error, { form: true });
    } finally {
      setButtonBusy(elements.createButton, false);
    }
  });

  elements.confirmLogin.addEventListener("click", () => runAction(
    elements.confirmLogin,
    () => api.confirmManualLogin(memory.jobId),
  ));
  elements.savePlan.addEventListener("click", async () => {
    let plan;
    try {
      plan = JSON.parse(elements.planEditor.value);
    } catch (error) {
      showError(error);
      return;
    }
    await runAction(elements.savePlan, async () => {
      const result = await api.updatePlan(memory.jobId, plan, memory.planDigest);
      setPlan(result?.plan ?? plan, result?.planDigest);
      return result;
    });
  });
  elements.approvePlan.addEventListener("click", () => runAction(
    elements.approvePlan,
    () => api.approvePlan(memory.jobId, memory.planDigest),
  ));
  elements.execute.addEventListener("click", () => runAction(
    elements.execute,
    () => api.execute(memory.jobId, memory.planDigest),
  ));
  elements.mediaEditForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    elements.mediaEditStatus.classList.remove("is-success", "is-error");
    const request = mediaEditRequest({
      sceneId: elements.mediaSceneId,
      narration: elements.mediaNarration,
      caption: elements.mediaCaption,
    }, memory.previewDigest);
    if (request === null) {
      elements.mediaEditStatus.textContent = "현재 미리보기에서 유효한 장면 ID와 변경할 내레이션 또는 자막을 입력해 주세요.";
      elements.mediaEditStatus.classList.add("is-error");
      syncMediaEditAvailability();
      return;
    }
    elements.mediaEditStatus.textContent = "원본 녹화를 보존한 채 미디어를 다시 구성하고 있습니다.";
    const result = await runAction(
      elements.saveMediaEdit,
      () => api.editMedia(memory.jobId, request.edit, request.previewDigest),
    );
    if (result === null) {
      elements.mediaEditStatus.textContent = "장면 수정을 반영하지 못했습니다. 최신 미리보기를 확인해 주세요.";
      elements.mediaEditStatus.classList.add("is-error");
    } else if (memory.previewDigest === request.previewDigest) {
      elements.mediaEditStatus.textContent = "수정 요청을 접수했습니다. 새 미리보기 이벤트를 기다리고 있습니다.";
    }
    syncMediaEditAvailability();
  });
  elements.approvePreview.addEventListener("click", () => runAction(
    elements.approvePreview,
    () => api.approvePreview(memory.jobId, memory.previewDigest),
  ));
  elements.cancel.addEventListener("click", async () => {
    if (!globalThis.confirm("현재 작업을 취소할까요? 진행 중인 브라우저와 제작 엔진이 안전하게 종료됩니다.")) return;
    await runAction(elements.cancel, () => api.cancel(memory.jobId));
  });
  elements.dismissError.addEventListener("click", hideError);
  elements.newJob.addEventListener("click", () => {
    memory.subscription?.close();
    memory.subscription = null;
    memory.jobId = null;
    memory.cursor = createWorkflowCursor();
    elements.workspace.hidden = true;
    elements.credentialUsername.value = "";
    elements.credentialSecret.value = "";
    elements.form.reset();
    elements.mediaEditForm.reset();
    elements.mediaEditStatus.textContent = "내레이션과 자막 중 하나 이상을 입력하세요.";
    elements.mediaEditStatus.classList.remove("is-success", "is-error");
    elements.promptCount.textContent = "0";
    updateAuthFields();
    updateJobUrl(null);
    elements.targetUrl.focus();
    documentValue.getElementById("app").scrollIntoView({ behavior: "smooth" });
  });

  const resumeFromUrl = async () => {
    const jobId = jobIdFromLocation(globalThis.location);
    if (jobId === null) return;
    memory.jobId = jobId;
    memory.cursor = createWorkflowCursor();
    elements.workspace.hidden = false;
    elements.jobReference.textContent = `작업 ${jobId} · 최신 상태를 불러오는 중`;
    try {
      const snapshot = await api.getJob(jobId);
      if (!isPlainRecord(snapshot) || snapshot.id !== jobId) {
        throw new StudioApiError("JOB_NOT_FOUND", 404);
      }
      elements.jobReference.textContent = `작업 ${jobId} · ${snapshot.request?.targetUrl ?? "저장된 대상"}`;
      applySnapshot(snapshot);
      subscribe();
    } catch (error) {
      showError(error);
    }
  };

  updateAuthFields();
  api.health().then((health) => {
    const ready = health?.ready === true;
    elements.health.textContent = ready ? "모든 도구 준비" : "도구 확인 필요";
    elements.health.classList.toggle("is-ready", ready);
    elements.health.classList.toggle("is-error", !ready);
  }).catch(() => {
    elements.health.textContent = "서버 연결 필요";
    elements.health.classList.add("is-error");
  });
  resumeFromUrl();
}

if (typeof document !== "undefined") {
  initStudio(document);
}
