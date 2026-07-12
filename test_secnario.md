# OpenCode-only 인수 테스트 시나리오

이 문서는 회사 격리 환경에서 결과를 짧게 기록하고 재현하기 위한 실행 순서입니다. 상세 원본은 각 job의 `support_log.md`, `workflow_state.json`, `opencode_browser_metadata.json`, `trace_replay_log.json`에 남습니다.

## 공통 준비

Python `3.13.14` 가상환경을 사용합니다.

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
npm ci
Copy-Item .env.example .env
```

`.env`에서 다음을 확인합니다.

```env
MANUAL_AGENT_ENABLE_OPENCODE=true
MANUAL_AGENT_OPENCODE_COMMAND=opencode run --format json
MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND=npx --offline @playwright/mcp
MANUAL_AGENT_BROWSER_CHANNEL=msedge
MANUAL_AGENT_BROWSER_RUNNER=launch
MANUAL_AGENT_USER_DATA_DIR=C:\ManualVideoAgent\runtime\browser-profile
MANUAL_AGENT_SUPERTONIC_VOICE=M1
MANUAL_AGENT_SUPERTONIC_LANG=ko
MANUAL_AGENT_SUPERTONIC_AUTO_DOWNLOAD=false
SUPERTONIC_CACHE_DIR=C:\ManualVideoAgent\models\supertonic-3
MANUAL_AGENT_VIDEO_RENDERER=hyperframes
MANUAL_AGENT_HYPERFRAMES_COMMAND=npx --offline hyperframes render
MANUAL_AGENT_STRICT_MODE=true
MANUAL_AGENT_ENABLE_TERMINAL_LOGS=true
```

사전 점검:

```powershell
.\scripts\doctor.ps1
opencode run --format json "JSON으로 ok만 응답"
npx --offline @playwright/mcp --help
npx --offline hyperframes --help
```

## 1. QSike 공개 사이트 E2E

fixture: `test_scenarios/qsike_service_manual.json`

요청문:

```text
QSike Tech Notes 서비스를 소개한다. 첫 화면에 쿠키와 광고 데이터 선택 안내가 보이면 필수만 허용을 선택해 닫고, AI 인프라·반도체·데이터센터·AX 주제 영역을 설명한다. 최근 기술 노트 목록에서 가장 최신 글 하나를 열어 제목, 발행일, 태그, 본문을 읽는 방법을 보여준다.
```

입력:

- 대상 URL: `https://qsike.com/`
- 역할: `방문자`
- 완료 조건: `최근 기술 노트 상세 화면에서 글 제목, 발행일, 태그와 본문이 보이면 완료`
- 입력값: 없음

합격 기준:

1. Edge가 열리고 QSike 첫 화면이 표시된다.
2. 쿠키 선택 안내가 있으면 `필수만 허용`을 눌러 실제 화면을 가리지 않는다.
3. OpenCode trace가 홈 소개, 주제 영역, 최근 기술 노트, 글 상세의 4단계 이상을 포함한다.
4. 상세 URL이 `https://qsike.com/posts/` 아래이며 `발행`과 본문 근거가 기록된다.
5. replay before/after 화면과 selector trace가 생성된다.
6. Supertonic metadata의 provider/voice/language가 `supertonic/M1/ko`이다.
7. 영상에 video/audio stream과 자막이 있고 길이가 20초 이상이다.
8. 시작·중간·끝 frame이 흰 화면이 아니며 pointer 또는 highlight가 보인다.
9. 음성·자막 문장이 두 번 반복되지 않는다.
10. manifest의 `pipeline`은 `opencode-only`, status는 `completed`이다.

실행 예:

```powershell
.\scripts\start.ps1 -Port 8000
```

홈의 `QSike 예시`를 누른 뒤 요청을 확인하고 실행합니다.

## 2. 회사 AD SSO profile 재사용

대상은 read-only 조회가 가능한 사내 시스템으로 정합니다. 개인 기본 Edge profile이 아니라 앱 전용 `MANUAL_AGENT_USER_DATA_DIR`을 사용합니다.

검증 순서:

1. 첫 실행에서 앱이 연 Edge에 회사 인증이 필요하면 직접 완료한다.
2. 작업을 실패/취소하고 같은 profile로 다시 실행한다.
3. 두 번째 실행에서 SAML/ADFS 경유 후 로그인 입력 화면에 멈추지 않는지 확인한다.
4. OpenCode discovery와 deterministic replay가 같은 인증 세션을 쓰는지 URL과 화면으로 확인한다.
5. `opencode_events.jsonl`, trace, audit log에 ID, password, token, cookie가 없는지 검색한다.

합격 기준:

- `browser_session` actor가 성공한다.
- discovery와 replay 모두 인증 후 홈 화면을 사용한다.
- profile lock 때문에 동시 두 작업은 명확한 `profile_locked` 오류로 거부된다.
- 앱이 시작한 Edge만 종료되고 개인 Edge는 종료되지 않는다.

## 3. 필수 단계 fail-fast

회사 PC에서 하나씩 의도적으로 실패시켜 오류 위치가 숨겨지지 않는지 확인합니다.

| 조건 | 기대 결과 |
|---|---|
| `MANUAL_AGENT_ENABLE_OPENCODE=false` | `opencode_disabled`, 작업 failed |
| 잘못된 OpenCode command | `opencode_invocation_failed` 또는 nonzero, 작업 failed |
| MCP package 제거 | OpenCode/MCP 단계 failed, replay 미실행 |
| Supertonic model 일부 제거 | `supertonic_model_load_failed`, 영상 미생성 |
| `M1.json` 제거 | `supertonic_style_failed`, 영상 미생성 |
| HyperFrames command 실패 | render failed, fallback 완료 금지 |
| selector가 discovery 후 변경 | replay divergence failed, before/after 보존 |

합격 기준:

- `workflow_state.json`의 status가 `failed`이고 current step이 `execution_failed`이다.
- `details.degraded`가 `false`이다.
- `support_log.md`에 stage와 한 줄 error가 있다.
- 실패 단계 이후 산출물을 정상 완료로 표시하지 않는다.

## 회사에서 전달할 짧은 결과

복사·붙여넣기가 불가능하면 다음 7개 값만 타이핑해서 전달합니다.

```text
job_id:
status:
stage:
error_code:
error 첫 120자:
opencode returncode:
마지막 성공 action_id:
```

값 위치:

- `job_id`, `status`, `stage`, `error`: `support_log.md`
- `error_code`, `returncode`: `opencode_browser_metadata.json`
- 마지막 action: `trace_replay_log.json`

추가 파일 반출이 허용되면 `.\scripts\doctor.ps1 -Collect`로 redacted 진단 zip을 만듭니다.
