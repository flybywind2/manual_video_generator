# Browser-Use Discovery Adapter

status: design note
scope: scenario discovery only

이 문서는 `browser-use`를 이 프로젝트에 붙일 때의 경계와 산출물 계약을 정리한다. 현재 파이프라인의 최종 실행, 촬영, 재현, 영상 생성은 Playwright/Playwright MCP/HyperFrames 흐름을 유지한다. `browser-use`는 사용자가 사내 시스템 화면을 처음 파악하거나 시나리오 초안을 만들 때 보조 탐색기로만 사용한다.

## Design Boundary

`browser-use`는 다음 책임만 가진다.

- 대상 URL을 탐색해 후보 업무 흐름을 찾는다.
- 클릭 가능한 메뉴, 입력 필드, 모달, 조회 결과 영역을 후보로 정리한다.
- 후보 selector, 후보 마스킹 대상, 화면 캡처, DOM 요약, 위험 경고를 수집한다.
- 수집 결과를 `DiscoveryManifest`로 저장한다.
- 기존 `scenario_generation` 또는 planner 입력으로 넘길 초안을 만든다.

`browser-use`는 다음 책임을 가지지 않는다.

- 최종 영상 촬영을 직접 수행하지 않는다.
- 운영계 write/submit 액션을 자동 확정하지 않는다.
- 사용자의 사내 ID/password/OTP/SSO 토큰을 직접 받지 않는다.
- 생성한 시나리오를 관리자 검토 없이 바로 활성화하지 않는다.

## Why Not Replace Playwright

이 프로젝트의 영상 생성은 동일 시나리오를 다시 실행하고, 녹화와 음성/자막 타이밍을 맞추고, 실패 시 로그를 재현해야 한다. 그래서 최종 실행 경로는 결정론적인 Playwright action plan과 package artifact 계약을 유지한다.

`browser-use`는 탐색에는 유용하지만, 최종 runner가 되면 다음 리스크가 커진다.

- 같은 요청문에서도 클릭 후보가 매번 달라질 수 있다.
- selector, 대기 조건, 모달 처리 결과가 영상 재렌더와 맞지 않을 수 있다.
- 사내 SSO/profile 재사용 경계가 Playwright와 따로 생길 수 있다.
- 관리자 승인 전 자동 실행 범위가 넓어질 수 있다.

## DiscoveryManifest Contract

권장 파일명:

```text
browser_use_discovery_manifest.json
```

권장 스키마:

```json
{
  "version": "1.0",
  "run_id": "job id",
  "target_url": "https://internal.example",
  "viewport": {
    "mode": "desktop",
    "width": 1365,
    "height": 768
  },
  "visited_urls": [],
  "candidate_actions": [
    {
      "intent": "open_search_modal",
      "action_type": "click",
      "selector": "button[aria-label='Search']",
      "visible_text": "검색",
      "confidence": 0.74,
      "risk": "read_only",
      "evidence": "screenshot path or DOM excerpt"
    }
  ],
  "candidate_inputs": [
    {
      "label": "질문 입력창",
      "selector": "textarea",
      "suggested_value_key": "question",
      "required": true
    }
  ],
  "candidate_masks": [
    {
      "selector": ".user-name",
      "reason": "possible personal name"
    }
  ],
  "screenshots": [],
  "dom_summaries": [],
  "warnings": []
}
```

## Proposed API

MVP 이후 도입한다면 다음 endpoint를 둔다.

```text
POST /api/generation/scenario-drafts/discover
```

입력:

- `target_url`
- `request_text`
- `viewport_mode`: `desktop` 또는 `mobile`
- `auth_profile`: 기존 Playwright profile/auth state 참조
- `max_steps`

출력:

- `browser_use_discovery_manifest.json`
- `scenario_draft.md`
- `candidate_action_plan.json`
- `approval_required=true`

## Auth And SSO

인증은 browser-use 전용으로 새로 만들지 않는다. 기존 Playwright 설정을 재사용한다.

- `MANUAL_AGENT_BROWSER_CHANNEL`
- `MANUAL_AGENT_USER_DATA_DIR`
- Playwright persistent profile
- 필요한 경우 CDP 연결 경로

사내 AD/SSO 환경에서는 browser-use가 별도 새 브라우저 세션을 만들면 로그인 화면으로 빠질 수 있다. 따라서 discovery adapter도 최종 capture와 같은 profile/auth 경계를 사용해야 한다.

## Mobile Use

모바일 관련 browser-use는 실제 모바일 앱 자동화가 아니라, 사내 웹 시스템의 모바일 viewport 또는 responsive UI 탐색으로 제한한다.

권장 viewport:

```json
{
  "mode": "mobile",
  "width": 390,
  "height": 844,
  "device_scale_factor": 2,
  "is_mobile": true
}
```

모바일 discovery가 수집해야 할 추가 항목:

- 햄버거 메뉴, 하단 탭, floating action button 후보
- 모바일에서만 보이는 모달/바텀시트 후보
- touch target이 작거나 겹치는 위험 요소
- 데스크톱 selector와 모바일 selector가 다른 항목

모바일 discovery 결과도 바로 실행하지 않고 `DiscoveryManifest`로만 넘긴다. 최종 영상 제작은 승인된 action plan을 Playwright runner가 다시 실행한다.

## Pipeline Placement

권장 위치:

```mermaid
flowchart LR
    A["사용자 요청"] --> B["Browser-Use Discovery optional"]
    B --> C["DiscoveryManifest"]
    C --> D["Scenario Draft"]
    D --> E["Admin Review"]
    E --> F["Planner / ActionPlan"]
    F --> G["Playwright MCP / Browser Agent"]
    G --> H["Capture / TTS / HyperFrames"]
```

`browser-use`는 `Draft 생성` 앞 또는 옆에 붙는다. `MCP 리허설`, `AI 자동 실행`, `직접 시연`, `Replay`, `Render`를 대체하지 않는다.

## Implementation Tasks

1. `BrowserUseDiscoveryAdapter` 인터페이스를 추가한다.
2. `DiscoveryManifest` pydantic 모델을 정의한다.
3. `POST /api/generation/scenario-drafts/discover`를 추가한다.
4. desktop/mobile viewport 옵션을 UI에 추가한다.
5. discovery 산출물을 artifact package에 포함한다.
6. discovery 결과는 항상 `approval_required=true`로 둔다.
7. 관리자 승인 후에만 `candidate_action_plan.json`을 실제 planner 입력으로 승격한다.

