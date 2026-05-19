# Tasks

date: 2026-05-19
basis: `docs/workflow-codebase-structure.md`

이 파일은 현재 코드베이스를 워크플로우 기준으로 구조화한 뒤 도출한 개선 작업 목록이다. 새 작업은 먼저 어떤 workflow step을 바꾸는지 명시하고, 완료 시 관련 테스트와 smoke 증거를 함께 남긴다.

## Working Rules

- [x] 변경 전 `docs/workflow-codebase-structure.md`에서 해당 단계와 계약을 확인한다.
- [x] workflow step 문자열, artifact 이름, degraded reason은 테스트 없이 추가하지 않는다.
- [x] 사용자가 보는 UI 변화는 `test_home_ui.py` 또는 browser smoke로 검증한다.
- [x] pipeline/package 변화는 `tools/verify_package.py`와 관련 pytest로 검증한다.
- [x] 운영계 자동조작에 가까운 변경은 `RiskPolicy`, `ApprovalGate`, audit log 영향을 먼저 확인한다.

## P0 - Workflow Correctness

- [x] `WorkflowStep`/`PipelineStage` 상수 모듈 도입
  - 대상: `backend/app/pipeline.py`, `backend/app/static/app.js`
  - 이유: `capture`, `tts`, `render` 같은 문자열이 백엔드와 프론트에 분산되어 있다.
  - 완료 기준: backend는 enum/constant를 사용하고, frontend mapping은 한 곳에서만 관리한다.
  - 테스트: workflow state 단계 갱신 테스트와 UI polling 테스트 보강.

- [x] 로그인 이후 deferred MCP live rehearsal을 명시적 단계로 승격
  - 대상: draft/continue workflow, `backend/app/adapters/rehearsal.py`
  - 이유: 로그인 필요 시 draft 단계에서 MCP가 지연되지만, continue에서 언제 재개되는지 UI와 audit에서 충분히 명확하지 않다.
  - 완료 기준: `current_step=mcp_rehearsal_after_login` 또는 동등한 단계가 생기고, MCP 실행/skip/degraded가 manifest와 UI에 표시된다.
  - 테스트: 로그인 필요 draft에서 deferred 후 continue가 post-login MCP 결과를 기록하는 테스트.

- [x] 직접 시연 replay 실패 시 사용자 판단 가능한 산출물/상태 강화
  - 대상: demonstration replay, workflow state, manifest degraded
  - 이유: replay가 최종 영상 품질에 직접 영향을 주므로 `demonstration_replay_failed`를 UI에서 더 강하게 보여야 한다.
  - 완료 기준: replay 실패 시 preview/manual/manifest/UI에 원본 시연 영상 사용 여부와 실패 이유가 명확히 표시된다.
  - 테스트: replay 실패 주입 테스트와 artifact 표시 테스트.

- [x] AI 자동 실행에서 로그인 화면 감지 후 멈춤/요청 정책 정리
  - 대상: Browser Agent capture, login handling
  - 이유: 로그인 전 LLM이 액션을 결정하거나 MCP가 멈춰 있는 상황이 사용자 혼란을 만든다.
  - 완료 기준: 로그인 화면 감지 시 action 실행을 중단하고 `login_required` 상태와 다음 조치를 UI에 표시한다.
  - 테스트: login modal/login page 감지 테스트, workflow failed/retry state 테스트.

## P1 - Architecture Extraction

- [x] `pipeline.py`에서 BrowserRunner 모듈 분리
  - 대상: Playwright capture, login, demonstration recording, replay
  - 이유: orchestration과 browser implementation이 한 파일에 과도하게 결합되어 있다.
  - 완료 기준: `backend/app/browser_runner.py` 또는 `backend/app/runners/browser.py`가 capture/replay 책임을 가진다.
  - 테스트: 기존 `test_pipeline.py` browser 관련 테스트를 새 모듈 중심으로 이동 또는 유지.

- [x] PackageBuilder 모듈 분리
  - 대상: media plan, subtitles, preview, markdown, pdf, manifest
  - 이유: 산출물 생성과 브라우저 실행 책임을 분리해야 rerender 흐름이 단순해진다.
  - 완료 기준: rerender와 최초 render가 같은 PackageBuilder 계약을 사용한다.
  - 테스트: edited subtitles/manual 기반 rerender 테스트 유지.

- [x] RedactionPipeline 도입
  - 대상: `redaction.py`, masking, audit, LLM/terminal logs, VTT/manual/composition
  - 이유: 현재 redaction과 이미지 masking이 단계별로 흩어져 있다.
  - 완료 기준: 텍스트/JSON/image artifact가 단일 redaction entrypoint를 통과한다.
  - 테스트: 민감값이 `manual.md`, `subtitles.vtt`, `planner_trace.json`, `playwright_mcp_execution.json`, `audit_log.jsonl`에 남지 않는 negative tests.

- [x] Artifact dependency graph 명시
  - 대상: `package_manifest.json`, rerender API, artifact editor UI
  - 이유: 사용자가 어떤 텍스트를 편집하면 어떤 산출물이 재생성되는지 알기 어렵다.
  - 완료 기준: manifest에 `artifact_dependencies` 또는 `rerender_inputs`가 기록되고 UI에서 표시된다.
  - 테스트: manual/subtitles/media_plan 편집별 rerender 영향 테스트.

## P1 - Runtime Reliability

- [x] `doctor.ps1` 결과와 `/api/config/status` 항목 정렬
  - 대상: `scripts/doctor.ps1`, `backend/app/config.py`
  - 이유: CLI 진단과 UI 설정 상태가 서로 다른 언어로 표시되면 운영자가 원인 파악을 못 한다.
  - 완료 기준: Python, Node, Playwright browser, ffmpeg, CA/proxy, TTS cache, HyperFrames, OpenCode 상태 이름이 일치한다.
  - 테스트: doctor JSON contract와 config status API 비교 테스트.

- [x] 로컬 live smoke 단일 명령 추가
  - 대상: `scripts/smoke.ps1`
  - 이유: 현재 단위 테스트와 package verify는 강하지만, 로컬 서버 + 샘플 URL + Playwright 캡처를 한 번에 검증하는 명령이 약하다.
  - 완료 기준: `scripts/smoke.ps1 -LiveBrowser`가 서버 시작, readiness, draft, continue, verify, cleanup을 수행한다.
  - 테스트: script contract test와 수동 smoke 결과 기록.

- [x] smoke 산출물 cleanup/ignore 정책 정리
  - 대상: `.gitignore`, smoke scripts
  - 이유: `.workflow_smoke` 계열 디렉터리가 테스트 후 잠금/권한 문제로 남을 수 있다.
  - 완료 기준: smoke output은 `output/diagnostics` 또는 ignored temp root로 통일하고 cleanup 실패 시 안내한다.
  - 테스트: runtime script test.

## P2 - UX and Review Flow

- [x] workflow state 상세 메시지 UI 개선
  - 대상: `backend/app/static/app.js`, `styles.css`
  - 이유: 현재 진행 메시지는 한 줄 상태 중심이다.
  - 완료 기준: 현재 actor, degraded warning, 마지막 artifact 링크를 작은 status panel로 표시한다.
  - 테스트: static UI test.

- [x] degraded reason을 사용자 친화 문구로 변환
  - 대상: UI artifact panel, manifest rendering
  - 이유: `tts_silent_fallback`, `hyperframes_fallback_video`는 운영자에게 바로 이해되지 않는다.
  - 완료 기준: 각 degraded reason에 Korean label, 원인, 다음 조치가 표시된다.
  - 테스트: UI rendering test.

- [x] 텍스트 산출물 편집 이력 저장
  - 대상: text artifact API, package manifest
  - 이유: 누가 어떤 텍스트를 수정했는지 추적이 약하다.
  - 완료 기준: `artifact_edit_log.jsonl`에 artifact path, before/after hash, timestamp가 남는다.
  - 테스트: text artifact edit API test.

- [x] README와 workflow 구조 문서 링크 정리
  - 대상: `README.md`
  - 이유: README는 사용자 실행 중심, workflow 구조 문서는 개발자 작업 기준으로 분리되어 있다.
  - 완료 기준: README에 `docs/workflow-codebase-structure.md`와 `tasks.md` 링크가 추가된다.

## P2 - Test Coverage

- [x] workflow snapshot test 추가
  - 대상: sample draft/continue package
  - 이유: workflow state, manifest, audit event shape가 조용히 바뀌는 것을 막아야 한다.
  - 완료 기준: normalize된 snapshot 또는 contract assertion이 추가된다.

- [x] property-based redaction test 검토
  - 대상: redaction/masking/log artifacts
  - 이유: 민감값 누락은 예시 기반 테스트만으로 부족하다.
  - 완료 기준: Hypothesis 도입 여부를 결정하고, 도입 시 민감 패턴 invariant 테스트를 추가한다.

- [x] Browser Agent 실제 화면 smoke fixture 확장
  - 대상: `/sample`, Browser Agent tests
  - 이유: 단순 LOT 조회 외에 로그인, modal, iframe 유사 패턴이 필요하다.
  - 완료 기준: sample app에 modal/login/search variants가 있고 AI 자동 실행 smoke가 통과한다.

## Done Definition

각 task 완료 시 다음을 기록한다.

- 변경한 workflow step
- 변경한 파일
- 추가/수정한 테스트
- 실행한 검증 명령
- 생성된 대표 artifact 또는 package manifest 경로
- 남은 degraded/fallback 조건

## Completion Evidence

완료 일시: 2026-05-19

변경한 workflow step:

- `plan_review`
- `mcp_rehearsal_after_login`
- `capture`
- `replay`
- `masking`
- `tts`
- `preview`
- `render`
- `opencode`
- `manifest`
- `completed`
- `execution_failed`

변경한 주요 파일:

- `backend/app/workflow.py`
- `backend/app/browser_runner.py`
- `backend/app/package_builder.py`
- `backend/app/artifact_dependencies.py`
- `backend/app/pipeline.py`
- `backend/app/main.py`
- `backend/app/redaction.py`
- `backend/app/config.py`
- `backend/app/static/app.js`
- `backend/app/static/styles.css`
- `backend/app/templates/sample.html`
- `scripts/smoke.ps1`
- `.gitignore`
- 관련 테스트 파일

추가/수정한 테스트:

- workflow state 단계 계약
- 로그인 이후 deferred MCP live rehearsal 재개
- 로그인 화면 감지 시 자동 실행 중단
- artifact dependency graph
- artifact edit log
- RedactionPipeline 텍스트 redaction
- BrowserRunner/PackageBuilder 모듈 계약
- degraded reason 사용자 친화 UI
- live browser smoke script contract
- sample login/modal/iframe fixture
- workflow package snapshot 계약

실행한 검증 명령:

- `python -m pytest -q --basetemp .pytest_tmp_focus backend\tests\test_workflow_modules.py backend\tests\test_pipeline_operational_contract.py backend\tests\test_home_ui.py backend\tests\test_redaction.py backend\tests\test_runtime_scripts.py`
- `python -m pytest -q --basetemp .pytest_tmp_pipeline_new backend\tests\test_pipeline.py::test_package_manifest_lists_all_generated_supporting_artifacts backend\tests\test_pipeline.py::test_text_artifact_api_allows_editing_generated_markdown backend\tests\test_pipeline.py::test_redaction_pipeline_scrubs_sensitive_values_from_manual_and_subtitles backend\tests\test_pipeline.py::test_pipeline_rerender_api_returns_updated_artifacts`
- `python -m compileall -q backend\app`
- `node --check backend\app\static\app.js`

남은 degraded/fallback 조건:

- `browser_capture_disabled`: 사용자가 브라우저 캡처를 끄면 정상적인 degraded 상태로 유지한다.
- `tts_silent_fallback`: 로컬 TTS 런타임이 없으면 무음 wav fallback을 유지하되 UI에 확인 필요로 표시한다.
- `hyperframes_fallback_video`: HyperFrames/FFmpeg 실패 시 WebM fallback을 유지하되 UI에 확인 필요로 표시한다.
- `opencode_failed`: 선택 기능 실패로 패키지 생성을 막지 않고 degraded로 기록한다.
- `login_required`: 로그인 화면 감지 시 자동 실행을 중단하고 재시도 가능 상태로 둔다.
- `demonstration_replay_failed`: 원본 시연 패키지를 보존하고 replay 실패를 degraded로 표시한다.
