# Extension Bridge 사용 매뉴얼

Extension bridge는 사용자가 이미 로그인한 Chrome/Edge 탭 안에서 브라우저 확장 또는 로컬 native host가 DOM 관찰과 동작 실행을 담당하고, Manual Video Agent가 다음 행동을 결정하는 구조입니다. Playwright launch, persistent profile, CDP attach가 사내 SSO/보안정책 때문에 불안정할 때의 대안입니다.

## 핵심 계약

모든 턴은 Stagehand 스타일의 `observe → act → verify` 순서로 실행됩니다.

```text
Manual Video Agent
  -> POST /observe
  <- 현재 탭의 DOM/필드/클릭 후보
  -> LLM이 다음 안전 행동 결정
  -> POST /act
  <- 실행 결과
  -> POST /verify
  <- 검증 결과
```

생성 패키지에는 `browser_agent_trace.json`이 남고, 각 턴은 `observation`, `action`, `result`, `verification`을 포함합니다.

## .env 설정

```env
MANUAL_AGENT_BROWSER_RUNNER=extension_bridge
MANUAL_AGENT_EXTENSION_BRIDGE_ENDPOINT=http://127.0.0.1:8765
MANUAL_AGENT_EXTENSION_BRIDGE_TOKEN=
MANUAL_AGENT_ENABLE_BROWSER_AGENT=true
```

토큰을 사용하는 경우 extension/native host는 다음 헤더를 검사해야 합니다.

```http
Authorization: Bearer <MANUAL_AGENT_EXTENSION_BRIDGE_TOKEN>
```

## Endpoint 계약

### POST /observe

요청:

```json
{}
```

응답:

```json
{
  "status": "ok",
  "observation": {
    "url": "https://internal.example.local/app",
    "title": "사내 시스템",
    "headings": ["업무 조회"],
    "fields": [
      {"label": "검색어", "name": "keyword", "placeholder": "검색어", "type": "text", "value": ""}
    ],
    "clickables": [
      {"text": "조회", "role": "button", "href": ""}
    ],
    "body_text": "현재 화면의 주요 텍스트"
  }
}
```

### POST /act

요청:

```json
{
  "action": {
    "type": "fill_by_label",
    "label": "검색어",
    "value": "LOT-001",
    "reason": "검색어를 입력합니다."
  }
}
```

응답:

```json
{
  "status": "ok",
  "result": {
    "status": "ok",
    "method": "extension.fill"
  }
}
```

지원 action type은 현재 `fill_by_label`, `click_by_text`, `press_key`, `wait`, `capture_step`, `finish`입니다.

### POST /verify

요청:

```json
{
  "action": {"type": "fill_by_label", "label": "검색어", "value": "LOT-001"},
  "result": {"status": "ok", "method": "extension.fill"}
}
```

응답:

```json
{
  "status": "ok",
  "verification": {
    "status": "ok",
    "reason": "field_value_observed"
  }
}
```

## 구현 가이드

- 확장은 현재 활성 탭의 DOM만 관찰해야 합니다.
- 비밀번호, OTP, SSO 토큰, 쿠키 원문은 observation에 포함하지 않습니다.
- `body_text`는 길이를 제한하고 민감정보를 마스킹합니다.
- `act`는 위험 동작을 직접 실행하기 전에 자체 allowlist를 한 번 더 확인합니다.
- `verify`는 action 이후 DOM 상태가 기대와 맞는지 확인합니다.
- remote debugging port를 열 필요가 없다는 점이 CDP attach와의 가장 큰 차이입니다.

## 제한

- extension bridge 자체는 화면 WebM 녹화를 제공하지 않습니다. 현재 파이프라인은 영상 산출물을 degraded placeholder로 표시하고, `browser_agent_trace.json`, `capture_action_log.json`, 문서/자막 산출물을 남깁니다.
- 실제 영상까지 extension 방식으로 만들려면 확장 쪽에서 `getDisplayMedia` 또는 별도 데스크톱 캡처 모듈을 추가해야 합니다.
- 사내 배포 전에는 확장 권한, 토큰 보관, native host 설치 경로, 로그 보존 정책 검토가 필요합니다.
