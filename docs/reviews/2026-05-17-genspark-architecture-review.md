# Genspark Architecture Review Follow-up

date: 2026-05-17
status: accepted-for-mvp-hardening
source: Genspark AI Chat architecture review

## Review Summary

Genspark의 핵심 지적은 현재 구조가 어댑터별 수평 분해에는 충분하지만, 운영계 전환에서 중요한 계약, 게이트, 감사 계층이 명확하지 않다는 점이다.

MVP 방향은 유지하되 다음 순서로 반영한다.

1. 공통 실행 컨텍스트와 audit event를 1급 산출물로 둔다.
2. 위험 액션 분류와 승인 게이트를 로그가 아니라 코드 경계로 분리한다.
3. fallback을 숨기지 않고 `degradations`로 manifest와 UI에 노출한다.
4. RedactionPipeline은 다음 단계에서 DOM, 로그, 문서 텍스트까지 포함하는 단일 경계로 확장한다.

## P0 Items

### Approval Gate

기존 `approval_log.json`은 승인 결과 기록에 가까웠다. 운영 전환 전에는 위험 액션이 승인 게이트를 통과하지 않으면 실행될 수 없는 구조가 필요하다.

MVP 반영:

- `RiskPolicy`가 write-like keyword 기반 위험 액션을 분류한다.
- `ApprovalGate`가 strict mode에서 위험 액션을 차단한다.
- 샘플 MVP 실행은 `sample-mvp` mode로 자동 승인하되, 이 사실을 approval log와 audit log에 남긴다.

### Audit Log

어댑터별 JSON만으로는 장애 분석 시 run/step/actor를 cross-join하기 어렵다.

MVP 반영:

- `audit_log.jsonl`을 job package에 추가한다.
- 각 event는 `run_id`, `actor`, `step_id`, `status`, `input_hash`, `output_hash`, `degrade_reason`, `artifacts`를 가진다.
- planner, rehearsal, approval, capture, masking, tts, render, opencode, manifest 이벤트를 기록한다.

### Degraded State

자동 fallback은 운영에서 silent failure로 보일 수 있다.

MVP 반영:

- package manifest에 `degradations`를 추가한다.
- `tts_silent_fallback`, `hyperframes_fallback_video`, `browser_capture_disabled`, `planner_fallback`, `playwright_mcp_live_failed`를 표준 reason으로 사용한다.

## Deferred Items

- 단일 Pydantic `ActionPlan` schema와 schema version.
- DOM, URL, 로그, Markdown, HyperFrames HTML까지 통과하는 `RedactionPipeline`.
- OpenCode dry-run sandbox와 diff-only 반영.
- BrowserRunner 통합 인터페이스. 현재는 MCP rehearsal과 direct capture 구현을 분리 유지한다.
- `/artifacts` 접근 토큰화. 현재는 loopback local MVP 전제와 path traversal 방어까지만 구현한다.

## Next Two Weeks

1. `ActionPlan`, `RunContext`, `AuditEvent`, `AdapterResult` Pydantic 모델 도입.
2. `RiskPolicy` keyword-only에서 LLM classification optional mode로 확장.
3. RedactionPipeline을 추출하고 manual.md, planner_trace, MCP calls, HyperFrames HTML에 secret/PII negative test 추가.
4. HyperFrames, TTS, MCP, OpenCode 어댑터를 `prepare/execute/result(status, degrade_reason, artifacts)` 계약으로 정렬.
5. 샘플 시나리오 package manifest와 audit log의 golden regression test 추가.
