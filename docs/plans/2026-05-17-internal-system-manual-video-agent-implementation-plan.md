# Internal System Manual Video Agent Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a local FastAPI wizard that turns one user-provided internal-system scenario into a rehearsed Playwright action plan and an HTML/MP4/Markdown/PDF manual package with masking and Korean TTS narration.

**Architecture:** The backend owns jobs, planning, approvals, masking, TTS, and export orchestration. A Node/TypeScript runner owns deterministic Playwright execution and capture, while `playwright-mcp` is used only through an adapter for rehearsal/exploration. HyperFrames is isolated behind an export adapter so tests can validate the package contract before the real renderer is wired in.

**Tech Stack:** Python 3.11+, FastAPI, Pydantic, pytest, vanilla HTML/CSS/JS, Node.js/TypeScript, Playwright, playwright-mcp, HyperFrames, MeloTTS, ffmpeg, Markdown/PDF export.

---

## Implementation Notes

- Keep the MVP local-only: no central server, no remote storage, no system catalog.
- Start with a sample internal web app and deterministic fixtures before touching any real operating system.
- Do not put secrets, passwords, OTP, or SSO tokens in job records.
- Every renderer and model provider must have a test-friendly fake implementation.
- Keep the first runnable demo narrow: one sample scenario, one local browser session, one MP4/HTML/Markdown/PDF package.

## Task 1: Repository Scaffold

**Files:**
- Create: `pyproject.toml`
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `backend/app/__init__.py`
- Create: `backend/app/main.py`
- Create: `backend/tests/test_health.py`
- Create: `runner/package.json`
- Create: `runner/tsconfig.json`
- Create: `runner/src/index.ts`
- Create: `.gitignore`

**Step 1: Write the failing health test**

```python
# backend/tests/test_health.py
from fastapi.testclient import TestClient

from backend.app.main import app


def test_health_returns_ok():
    client = TestClient(app)
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_health.py -v`

Expected: FAIL because `backend.app.main` or `/api/health` does not exist.

**Step 3: Create minimal FastAPI app**

```python
# backend/app/main.py
from fastapi import FastAPI

app = FastAPI(title="Manual Video Agent")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
```

**Step 4: Add project dependencies**

`pyproject.toml` should include at minimum:

```toml
[project]
name = "internal-system-manual-video-agent"
version = "0.1.0"
requires-python = ">=3.11"
dependencies = [
  "fastapi",
  "uvicorn[standard]",
  "pydantic",
  "python-multipart",
  "jinja2",
]

[project.optional-dependencies]
dev = ["pytest", "httpx"]
```

**Step 5: Run test to verify it passes**

Run: `python -m pytest backend/tests/test_health.py -v`

Expected: PASS.

**Step 6: Commit**

```bash
git add pyproject.toml package.json tsconfig.json runner/package.json runner/tsconfig.json runner/src/index.ts backend/app backend/tests .gitignore
git commit -m "chore: scaffold local manual video agent"
```

## Task 2: Domain Models and Job Store

**Files:**
- Create: `backend/app/models.py`
- Create: `backend/app/job_store.py`
- Create: `backend/tests/test_job_store.py`

**Step 1: Write model and storage tests**

```python
# backend/tests/test_job_store.py
from backend.app.job_store import JobStore
from backend.app.models import JobCreate


def test_create_job_persists_user_input(tmp_path):
    store = JobStore(tmp_path)
    job = store.create(JobCreate(
        request_text="MES에서 LOT 조회 영상 만들기",
        target_url="http://localhost:9001/sample",
        role="작업자",
        completion_condition="상세 화면이 보인다",
        input_values={"lot": "LOT-001"},
    ))

    loaded = store.get(job.id)
    assert loaded.request_text == "MES에서 LOT 조회 영상 만들기"
    assert loaded.input_values == {"lot": "LOT-001"}
    assert loaded.status == "draft"
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_job_store.py -v`

Expected: FAIL because models/store do not exist.

**Step 3: Implement Pydantic models**

Create `JobCreate`, `JobRecord`, `ScenarioStep`, `ActionPlan`, `Action`, `DangerClassification`, `ArtifactPaths`.

Minimal fields:

```python
class JobCreate(BaseModel):
    request_text: str
    target_url: str
    role: str
    completion_condition: str
    input_values: dict[str, str] = Field(default_factory=dict)
```

**Step 4: Implement filesystem JobStore**

Persist each job as `data/jobs/<job_id>/job.json`. Use atomic write through a temporary file in the same directory.

**Step 5: Run tests**

Run: `python -m pytest backend/tests/test_job_store.py -v`

Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/models.py backend/app/job_store.py backend/tests/test_job_store.py
git commit -m "feat: add job domain model and store"
```

## Task 3: API for Wizard Job Lifecycle

**Files:**
- Create: `backend/app/api.py`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_jobs_api.py`

**Step 1: Write API tests**

```python
def test_create_and_read_job(client):
    response = client.post("/api/jobs", json={
        "request_text": "샘플 시스템에서 공지 등록 매뉴얼",
        "target_url": "http://localhost:9001",
        "role": "관리자",
        "completion_condition": "등록 완료 메시지",
        "input_values": {"title": "테스트 공지"},
    })
    assert response.status_code == 201
    job_id = response.json()["id"]

    detail = client.get(f"/api/jobs/{job_id}")
    assert detail.status_code == 200
    assert detail.json()["role"] == "관리자"
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_jobs_api.py -v`

Expected: FAIL because endpoints do not exist.

**Step 3: Implement endpoints**

Endpoints:

- `POST /api/jobs`
- `GET /api/jobs/{job_id}`
- `GET /api/jobs`
- `DELETE /api/jobs/{job_id}`

Use an app-level `JobStore` pointed at `MANUAL_AGENT_DATA_DIR` or `./data`.

**Step 4: Run tests**

Run: `python -m pytest backend/tests/test_jobs_api.py -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/api.py backend/app/main.py backend/tests/test_jobs_api.py
git commit -m "feat: expose job lifecycle api"
```

## Task 4: Sample Internal Web App

**Files:**
- Create: `backend/app/sample_app.py`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_sample_app.py`

**Step 1: Write sample app tests**

```python
def test_sample_app_contains_menu_and_form(client):
    response = client.get("/sample")
    assert response.status_code == 200
    assert "공지 관리" in response.text
    assert "저장" in response.text
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_sample_app.py -v`

Expected: FAIL because `/sample` does not exist.

**Step 3: Implement sample app**

Create a realistic but fake internal UI with:

- left navigation
- search screen
- detail screen
- create/edit form
- save/submit buttons that simulate danger actions
- Korean labels and sample table data

**Step 4: Run test**

Run: `python -m pytest backend/tests/test_sample_app.py -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/sample_app.py backend/app/main.py backend/tests/test_sample_app.py
git commit -m "feat: add sample internal web app"
```

## Task 5: Scenario Planner with Fake and Internal LLM Adapter

**Files:**
- Create: `backend/app/planner.py`
- Create: `backend/app/internal_llm.py`
- Create: `backend/tests/test_planner.py`

**Step 1: Write planner test**

```python
def test_fake_planner_creates_steps_and_narration():
    planner = FakeScenarioPlanner()
    plan = planner.plan(job_input)
    assert plan.steps[0].title
    assert plan.steps[0].narration
    assert any(action.type == "capture_step" for action in plan.actions)
```

**Step 2: Run test to verify it fails**

Run: `python -m pytest backend/tests/test_planner.py -v`

Expected: FAIL because planner does not exist.

**Step 3: Implement fake planner**

The fake planner should produce deterministic action JSON for the sample app. Include narration text per step.

**Step 4: Add internal LLM client shell**

Use `D:\Python\appendix\appendix.md` conventions:

- OpenAI-compatible base URL
- `x-dep-ticket`
- `Send-System-Name`
- `User-Id`
- `User-Type`
- `Prompt-Msg-Id`
- `Completion-Msg-Id`

Do not require real credentials in tests. Read config from environment and raise a clear configuration error when missing.

**Step 5: Run tests**

Run: `python -m pytest backend/tests/test_planner.py -v`

Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/planner.py backend/app/internal_llm.py backend/tests/test_planner.py
git commit -m "feat: add scenario planner contract"
```

## Task 6: Action JSON Schema and Danger Classification

**Files:**
- Modify: `backend/app/models.py`
- Create: `backend/app/danger.py`
- Create: `backend/tests/test_action_plan.py`
- Create: `backend/tests/test_danger.py`

**Step 1: Write schema and danger tests**

```python
def test_danger_keywords_mark_submit_action():
    result = classify_danger("저장 버튼을 클릭한다", selector_text="저장")
    assert result.is_danger is True
    assert "keyword" in result.reasons
```

**Step 2: Run tests to verify failure**

Run: `python -m pytest backend/tests/test_action_plan.py backend/tests/test_danger.py -v`

Expected: FAIL.

**Step 3: Implement validation**

Action fields:

- `id`
- `type`
- `description`
- `selector`
- `value_ref`
- `assertion`
- `step_id`
- `requires_approval`
- `danger`

Danger keywords:

- 저장
- 등록
- 제출
- 삭제
- 결재
- 발송
- 승인
- 확정
- 업로드

**Step 4: Run tests**

Run: `python -m pytest backend/tests/test_action_plan.py backend/tests/test_danger.py -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/models.py backend/app/danger.py backend/tests/test_action_plan.py backend/tests/test_danger.py
git commit -m "feat: validate action plans and danger actions"
```

## Task 7: Wizard UI Skeleton

**Files:**
- Create: `backend/app/static/app.js`
- Create: `backend/app/static/styles.css`
- Create: `backend/app/templates/index.html`
- Modify: `backend/app/main.py`
- Create: `backend/tests/test_wizard_ui.py`

**Step 1: Write UI smoke test**

```python
def test_wizard_ui_loads(client):
    response = client.get("/")
    assert response.status_code == 200
    assert "Manual Video Agent" in response.text
    assert "요청 입력" in response.text
```

**Step 2: Run test to verify failure**

Run: `python -m pytest backend/tests/test_wizard_ui.py -v`

Expected: FAIL.

**Step 3: Implement static wizard**

Create a single-page wizard with:

- request input
- plan review placeholder
- rehearsal placeholder
- narration/callout review placeholder
- HTML preview placeholder
- artifact list placeholder

Apply AI Center-inspired tokens from `D:\Python\appendix\AI Center DESIGN.md`: cool canvas, blue/indigo/violet accents, 6px buttons, 8px cards, 1px hairlines.

**Step 4: Run test**

Run: `python -m pytest backend/tests/test_wizard_ui.py -v`

Expected: PASS.

**Step 5: Commit**

```bash
git add backend/app/static backend/app/templates backend/app/main.py backend/tests/test_wizard_ui.py
git commit -m "feat: add wizard ui skeleton"
```

## Task 8: Planner API and UI Plan Review

**Files:**
- Modify: `backend/app/api.py`
- Modify: `backend/app/static/app.js`
- Modify: `backend/app/templates/index.html`
- Create: `backend/tests/test_plan_api.py`

**Step 1: Write API test**

```python
def test_generate_plan_updates_job(client):
    job_id = create_job(client)
    response = client.post(f"/api/jobs/{job_id}/plan")
    assert response.status_code == 200
    body = response.json()
    assert body["plan"]["steps"]
    assert body["plan"]["actions"]
```

**Step 2: Run test to verify failure**

Run: `python -m pytest backend/tests/test_plan_api.py -v`

Expected: FAIL.

**Step 3: Implement plan endpoint**

Add `POST /api/jobs/{job_id}/plan`. Persist draft plan to the job.

**Step 4: Wire UI**

Submit request form, call plan endpoint, show:

- steps
- action JSON summary
- danger badges
- narration text fields
- callout text fields

**Step 5: Run tests**

Run: `python -m pytest backend/tests/test_plan_api.py backend/tests/test_wizard_ui.py -v`

Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/api.py backend/app/static/app.js backend/app/templates/index.html backend/tests/test_plan_api.py
git commit -m "feat: generate and review scenario plans"
```

## Task 9: MCP Rehearsal Adapter

**Files:**
- Create: `backend/app/rehearsal.py`
- Create: `backend/tests/test_rehearsal.py`

**Step 1: Write fake rehearsal test**

```python
def test_fake_rehearsal_marks_plan_passed():
    adapter = FakeRehearsalAdapter()
    result = adapter.rehearse(plan)
    assert result.status == "passed"
    assert result.observations
```

**Step 2: Run test to verify failure**

Run: `python -m pytest backend/tests/test_rehearsal.py -v`

Expected: FAIL.

**Step 3: Implement adapter boundary**

Define:

- `RehearsalAdapter`
- `FakeRehearsalAdapter`
- `PlaywrightMcpRehearsalAdapter`

The real adapter should be configuration-driven and may shell out to a wrapper script or connect to a managed MCP client. Tests should use the fake adapter only.

**Step 4: Add endpoint**

Add `POST /api/jobs/{job_id}/rehearse`.

**Step 5: Run tests**

Run: `python -m pytest backend/tests/test_rehearsal.py -v`

Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/rehearsal.py backend/app/api.py backend/tests/test_rehearsal.py
git commit -m "feat: add mcp rehearsal adapter boundary"
```

## Task 10: Direct Playwright Runner

**Files:**
- Create: `runner/src/action-plan.ts`
- Create: `runner/src/run-plan.ts`
- Create: `runner/tests/run-plan.test.ts`
- Modify: `runner/package.json`
- Create: `backend/app/runner.py`
- Create: `backend/tests/test_runner_adapter.py`

**Step 1: Write runner adapter test**

```python
def test_runner_command_writes_capture_manifest(tmp_path):
    runner = FakeRunner(tmp_path)
    result = runner.run(plan)
    assert result.status == "completed"
    assert result.capture_manifest_path.exists()
```

**Step 2: Run backend test to verify failure**

Run: `python -m pytest backend/tests/test_runner_adapter.py -v`

Expected: FAIL.

**Step 3: Implement TypeScript runner contract**

Runner input:

```json
{
  "jobId": "job_123",
  "targetUrl": "http://localhost:8000/sample",
  "actions": []
}
```

Runner output:

```json
{
  "status": "completed",
  "captures": [
    {"stepId": "step_1", "path": "captures/step_1.png"}
  ]
}
```

**Step 4: Implement minimal TS runner**

Use Playwright to:

- launch browser
- navigate
- perform click/fill/wait/assert actions
- capture screenshots for `capture_step`
- stop before actions marked `requires_approval` unless approval token is present

**Step 5: Add Python runner adapter**

The backend adapter shells out to `node runner/dist/run-plan.js` and parses the output manifest.

**Step 6: Run tests**

Run:

```bash
python -m pytest backend/tests/test_runner_adapter.py -v
npm --prefix runner test
```

Expected: PASS.

**Step 7: Commit**

```bash
git add runner backend/app/runner.py backend/tests/test_runner_adapter.py
git commit -m "feat: add direct playwright runner"
```

## Task 11: Masking Engine

**Files:**
- Create: `backend/app/masking.py`
- Create: `backend/tests/test_masking.py`

**Step 1: Write masking tests**

```python
def test_detects_email_and_phone():
    matches = detect_sensitive_text("홍길동 hong@example.com 010-1234-5678")
    assert any(match.kind == "email" for match in matches)
    assert any(match.kind == "phone" for match in matches)
```

**Step 2: Run test to verify failure**

Run: `python -m pytest backend/tests/test_masking.py -v`

Expected: FAIL.

**Step 3: Implement detection**

Support:

- email
- phone
- employee-like ID
- money
- account-like numbers
- user-provided input values

**Step 4: Implement image redaction shell**

Start with a testable placeholder that copies input to output and writes a masking log. Follow up with OCR/DOM text-coordinate masking when capture metadata is available.

**Step 5: Run tests**

Run: `python -m pytest backend/tests/test_masking.py -v`

Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/masking.py backend/tests/test_masking.py
git commit -m "feat: add basic masking engine"
```

## Task 12: TTS Narration Engine

**Files:**
- Create: `backend/app/tts.py`
- Create: `backend/tests/test_tts.py`
- Create: `config/pronunciation_ko.json`

**Step 1: Write TTS tests**

```python
def test_splits_korean_narration_into_sentences():
    chunks = split_narration("MES 메뉴를 엽니다. LOT 번호를 입력합니다.")
    assert chunks == ["MES 메뉴를 엽니다.", "LOT 번호를 입력합니다."]


def test_pronunciation_dictionary_rewrites_terms():
    rewritten = apply_pronunciation("MES에서 LOT를 조회합니다.", {"MES": "엠이이에스", "LOT": "로트"})
    assert "엠이이에스" in rewritten
    assert "로트" in rewritten
```

**Step 2: Run test to verify failure**

Run: `python -m pytest backend/tests/test_tts.py -v`

Expected: FAIL.

**Step 3: Implement provider interface**

Providers:

- `FakeTtsProvider`: writes short silent wav files for tests.
- `MeloTtsProvider`: wraps MeloTTS Korean.
- `XttsProvider`: optional future provider for voice cloning.

**Step 4: Implement queue-safe synthesis**

Generate per-step wav files under `data/jobs/<job_id>/tts/`. Do not run TTS concurrently with Playwright capture or HyperFrames render.

**Step 5: Run tests**

Run: `python -m pytest backend/tests/test_tts.py -v`

Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/tts.py backend/tests/test_tts.py config/pronunciation_ko.json
git commit -m "feat: add korean tts narration engine"
```

## Task 13: HyperFrames Export Adapter

**Files:**
- Create: `backend/app/export.py`
- Create: `backend/app/templates/hyperframes/storyboard.html.j2`
- Create: `backend/tests/test_export.py`

**Step 1: Write export test**

```python
def test_export_creates_html_preview(tmp_path):
    exporter = FakeHyperFramesExporter(tmp_path)
    result = exporter.export(package)
    assert result.html_preview.exists()
    assert result.html_preview.name == "preview.html"
```

**Step 2: Run test to verify failure**

Run: `python -m pytest backend/tests/test_export.py -v`

Expected: FAIL.

**Step 3: Implement HTML storyboard generation**

Use Jinja2 to render:

- intro chapter card
- step sections
- screenshot or clip
- callout
- subtitle
- narration audio reference
- summary slide

**Step 4: Add HyperFrames command adapter**

Read `HYPERFRAMES_CMD` from config. If unset, generate HTML and a clear "render unavailable" state. Tests should use fake exporter.

**Step 5: Run tests**

Run: `python -m pytest backend/tests/test_export.py -v`

Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/export.py backend/app/templates/hyperframes backend/tests/test_export.py
git commit -m "feat: add hyperframes export adapter"
```

## Task 14: Markdown and PDF Manual Export

**Files:**
- Create: `backend/app/manual_export.py`
- Create: `backend/tests/test_manual_export.py`

**Step 1: Write manual export test**

```python
def test_markdown_manual_contains_steps_and_warnings(tmp_path):
    result = export_markdown_manual(package, tmp_path)
    content = result.read_text(encoding="utf-8")
    assert "# " in content
    assert "위험 액션" in content
    assert "단계" in content
```

**Step 2: Run test to verify failure**

Run: `python -m pytest backend/tests/test_manual_export.py -v`

Expected: FAIL.

**Step 3: Implement Markdown export**

Markdown includes:

- title
- request summary
- role and completion condition
- step list
- screenshots
- warnings
- narration text
- artifact metadata

**Step 4: Implement PDF placeholder**

Use a renderer abstraction. Start with HTML-to-PDF if an approved local renderer exists; otherwise produce a clear `pdf_status.json` and keep the adapter testable.

**Step 5: Run tests**

Run: `python -m pytest backend/tests/test_manual_export.py -v`

Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/manual_export.py backend/tests/test_manual_export.py
git commit -m "feat: export markdown and pdf manuals"
```

## Task 15: End-to-End Demo Pipeline

**Files:**
- Create: `backend/app/pipeline.py`
- Create: `backend/tests/test_demo_pipeline.py`
- Create: `scripts/run_demo.ps1`

**Step 1: Write pipeline test**

```python
def test_demo_pipeline_creates_package(tmp_path):
    result = run_demo_pipeline(data_dir=tmp_path, fake_external_tools=True)
    assert result.html_preview.exists()
    assert result.markdown_manual.exists()
    assert result.package_manifest.exists()
```

**Step 2: Run test to verify failure**

Run: `python -m pytest backend/tests/test_demo_pipeline.py -v`

Expected: FAIL.

**Step 3: Implement orchestration**

Pipeline steps:

- create job
- generate plan
- rehearse
- approve plan
- run Playwright capture
- mask captures
- synthesize TTS
- export HTML
- export MP4 when renderer configured
- export Markdown/PDF
- write package manifest

**Step 4: Add demo script**

`scripts/run_demo.ps1` should:

- start FastAPI
- create a sample job
- run pipeline with fake external providers by default
- print output package path

**Step 5: Run tests**

Run: `python -m pytest backend/tests/test_demo_pipeline.py -v`

Expected: PASS.

**Step 6: Commit**

```bash
git add backend/app/pipeline.py backend/tests/test_demo_pipeline.py scripts/run_demo.ps1
git commit -m "feat: add end-to-end demo pipeline"
```

## Task 16: Browser E2E Verification

**Files:**
- Create: `runner/tests/wizard-e2e.spec.ts`
- Modify: `runner/package.json`
- Create: `docs/demo.md`

**Step 1: Write Playwright UI test**

Test flow:

1. Open `/`.
2. Enter request, URL, role, completion condition, and input values.
3. Generate plan.
4. Approve plan.
5. Run fake rehearsal.
6. Run fake export.
7. Verify artifact list appears.

**Step 2: Run test to verify failure**

Run: `npm --prefix runner run test:e2e`

Expected: FAIL until UI hooks are complete.

**Step 3: Implement missing UI hooks**

Wire buttons and API calls needed by the E2E test.

**Step 4: Run all verification**

Run:

```bash
python -m pytest -q
npm --prefix runner test
npm --prefix runner run test:e2e
```

Expected: PASS.

**Step 5: Document demo**

`docs/demo.md` should include:

- local startup command
- sample scenario
- expected package outputs
- TTS engine configuration
- when to enable real playwright-mcp and HyperFrames

**Step 6: Commit**

```bash
git add runner/tests/wizard-e2e.spec.ts runner/package.json docs/demo.md backend/app/static/app.js
git commit -m "test: add wizard e2e demo verification"
```

## Task 17: Final Integration Gate

**Files:**
- Modify: `README.md`
- Modify: `docs/demo.md`
- Create: `docs/security.md`

**Step 1: Write docs**

Document:

- local-only architecture
- login handling policy
- operating-system caution
- danger approval rule
- masking limitations
- TTS engine choices
- package retention and deletion

**Step 2: Run final verification**

Run:

```bash
python -m pytest -q
npm --prefix runner test
npm --prefix runner run test:e2e
```

Expected: all tests pass.

**Step 3: Manual smoke**

Run:

```powershell
python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

Open `http://127.0.0.1:8000`, run the sample wizard, and verify the generated package includes:

- `preview.html`
- `manual.md`
- PDF or `pdf_status.json`
- MP4 or `render_status.json`
- `action_plan.json`
- `approval_log.json`
- `masking_log.json`
- TTS wav files

**Step 4: Commit**

```bash
git add README.md docs/demo.md docs/security.md
git commit -m "docs: document local manual video agent mvp"
```

## Handoff

Execute this plan with frequent commits. Keep fake providers in place until the deterministic sample pipeline passes. Only then wire real `playwright-mcp`, MeloTTS, and HyperFrames commands behind the existing adapter boundaries.
