# Docker 없는 OpenCode-only 사내 배포

이 문서는 Codex와 Docker를 사용할 수 없는 Windows 사내 PC에서 Manual Video Agent를 실행하는 기준입니다.

## 런타임 계약

- Python: 정확히 `3.13.14`
- Node.js: `22` 이상
- Agent: OpenCode CLI와 회사 OpenCode 기본 모델
- Browser: Microsoft Edge + 전용 AD SSO profile
- Browser tool: `@playwright/mcp`, backend-owned loopback CDP 연결
- TTS: `supertonic==1.3.1`, preset `M1`, language `ko`
- Render: HyperFrames + FFmpeg/ffprobe
- Bind: FastAPI/CDP 모두 loopback

내부 LLM/VLM API, RAG, reranker, browser-agent, extension bridge, 직접 시연 모드는 배포 필수요소가 아닙니다. OpenCode 실행에는 `--model`을 전달하지 않습니다.

## 권장 설치 경로

OneDrive, 한글 사용자명, 긴 경로 영향을 줄이기 위해 다음처럼 짧은 ASCII 경로를 사용합니다.

```text
C:\ManualVideoAgent\
  app\
  config\corp-root-ca.pem
  runtime\python\
  runtime\node\
  runtime\ffmpeg\bin\
  runtime\supertonic3\
  runtime\npm-cache\
  runtime\browser-profile\
  output\
```

시스템 PATH나 registry를 영구 수정하지 않습니다. `scripts/bootstrap.ps1`과 `scripts/start.ps1`이 현재 process에만 경로를 적용합니다.

## 온라인 build PC 준비

### Python wheelhouse

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install --upgrade pip
python -m pip download -d runtime\wheels -e ".[dev]"
```

Python runtime 자체를 동봉하려면 회사 승인된 exact `3.13.14` 배포본을 `runtime\python`에 staging합니다.

### Node package

```powershell
npm ci
npm cache verify
```

배포 bundle에는 `package.json`, `package-lock.json`, `node_modules`, npm cache를 함께 넣습니다. 사내 PC에서는 registry 조회 없이 다음이 성공해야 합니다.

```powershell
npx --offline @playwright/mcp --help
npx --offline hyperframes --help
```

### OpenCode

회사 표준 OpenCode 설치본과 provider 설정을 준비합니다.

```powershell
opencode --version
opencode run --format json "JSON으로 ok만 응답"
```

앱은 다음 명령만 조립합니다.

```text
opencode run --format json [--agent <configured-agent>] <prompt>
```

### Supertonic model

```powershell
$env:SUPERTONIC_CACHE_DIR = "C:\ManualVideoAgent\runtime\supertonic3"
@'
from supertonic import TTS
tts = TTS(model_dir=r"C:\ManualVideoAgent\runtime\supertonic3", auto_download=True)
tts.get_voice_style(voice_name="M1")
print("ready")
'@ | python -
```

`onnx` 모델 4개, `tts.json`, `unicode_indexer.json`, `voice_styles\M1.json`이 모두 있어야 합니다.

### FFmpeg와 Edge

- `runtime\ffmpeg\bin`에 `ffmpeg.exe`, `ffprobe.exe`를 함께 둡니다.
- 회사 표준 Edge를 사용하면 browser binary를 bundle에 넣지 않습니다.
- portable Edge만 허용되는 환경에서는 `.env`의 `MANUAL_AGENT_PLAYWRIGHT_EXECUTABLE_PATH`에 절대경로를 지정합니다.

## 사내 PC 설치

1. bundle을 `C:\ManualVideoAgent\app`에 풉니다.
2. `.env.example`을 OneDrive 밖의 `.env`로 복사합니다.
3. `MANUAL_AGENT_USER_DATA_DIR`와 `SUPERTONIC_CACHE_DIR`를 절대경로로 설정합니다.
4. 필요한 경우 `config\corp-root-ca.pem`을 넣습니다.
5. doctor를 실행하고 `FAIL` 항목을 모두 해결합니다.
6. smoke test 후 서버를 시작합니다.

```powershell
Set-Location C:\ManualVideoAgent\app
.\scripts\doctor.ps1
.\scripts\smoke.ps1
.\scripts\start.ps1 -Port 8000
```

## 필수 `.env`

```env
MANUAL_AGENT_ENABLE_OPENCODE=true
MANUAL_AGENT_OPENCODE_COMMAND=opencode run --format json
MANUAL_AGENT_OPENCODE_AGENT=
MANUAL_AGENT_OPENCODE_TIMEOUT_SECONDS=900

MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND=npx --offline @playwright/mcp
MANUAL_AGENT_BROWSER_CHANNEL=msedge
MANUAL_AGENT_BROWSER_RUNNER=launch
MANUAL_AGENT_USER_DATA_DIR=C:\ManualVideoAgent\runtime\browser-profile

MANUAL_AGENT_TTS_PROVIDER=supertonic
MANUAL_AGENT_SUPERTONIC_VOICE=M1
MANUAL_AGENT_SUPERTONIC_LANG=ko
MANUAL_AGENT_SUPERTONIC_AUTO_DOWNLOAD=false
SUPERTONIC_CACHE_DIR=C:\ManualVideoAgent\runtime\supertonic3

MANUAL_AGENT_VIDEO_RENDERER=hyperframes
MANUAL_AGENT_HYPERFRAMES_COMMAND=npx --offline hyperframes render
MANUAL_AGENT_STRICT_MODE=true
MANUAL_AGENT_ENABLE_TERMINAL_LOGS=true
```

`MANUAL_AGENT_OPENCODE_MODEL`은 사용하지 않습니다. 기존 환경에 남아 있어도 실행 명령에 반영되지 않습니다.

## AD SSO

기본값은 backend-owned Edge launch입니다. 앱은 profile lock을 잡고 Edge를 연 뒤 동적으로 할당한 loopback CDP 주소를 작업 전용 Playwright MCP에 전달합니다.

최초 1회 회사 로그인이나 정책 확인이 필요하면 앱이 연 Edge에서 완료합니다. 이후 동일한 `MANUAL_AGENT_USER_DATA_DIR`을 재사용합니다. 개인이 평소 사용하는 Edge profile을 직접 지정하지 마십시오. profile 충돌과 데이터 오염을 막기 위해 이 앱 전용 경로를 사용합니다.

이미 별도 절차로 CDP Edge를 띄운 환경만 다음을 사용합니다.

```env
MANUAL_AGENT_BROWSER_RUNNER=cdp_attach
MANUAL_AGENT_CDP_ENDPOINT=http://127.0.0.1:9222
```

CDP endpoint는 loopback 주소만 허용됩니다.

## 장애 분류

| 코드/단계 | 의미 | 우선 확인 |
|---|---|---|
| `browser_executable_missing` | Edge 실행 파일 탐색 실패 | Edge 설치 또는 executable path |
| `profile_locked` | 다른 작업이 profile 사용 중 | 남은 Edge process와 lock 소유자 |
| `cdp_start_timeout` | Edge가 CDP 준비 전 종료/차단 | EDR, AppLocker, profile 권한 |
| `opencode_disabled` | 필수 OpenCode 비활성화 | `.env` enable/command |
| `opencode_timeout` | OpenCode 탐색 시간 초과 | 기본 모델, MCP 연결, target 응답 |
| `opencode_malformed_output` | JSON event/trace 계약 불일치 | events, browser metadata |
| `trace_validation` | off-origin, 위험 action, selector 근거 부족 | execution trace |
| `supertonic_*` | 모델/style/합성/WAV 실패 | model cache, M1 file, ONNX Runtime |
| `trace_replay` | 화면이 discovery와 달라짐 | before/after capture, selector trace |
| `render` | HyperFrames/FFmpeg 실패 | video_render, composition, ffprobe |

실패 시 `support_log.md`의 stage와 error를 먼저 전달하고, 필요할 때만 `doctor.ps1 -Collect` 진단 zip을 사용합니다.

## 보안 및 라이선스 확인

- OpenCode provider/model의 사내 데이터 처리 정책
- Playwright MCP Apache-2.0
- HyperFrames Apache-2.0
- Supertonic Python SDK MIT와 model OpenRAIL-M 조건
- FFmpeg build의 LGPL/GPL 및 포함 codec 조건
- Edge 자동화와 회사 EDR/AppLocker 정책
- output 영상·스크린샷·audit log 보존 및 반출 정책

password, OTP, token, cookie, authorization header를 요청 입력값이나 OpenCode prompt에 넣지 않습니다. OpenCode는 Playwright MCP 외 tool을 사용할 수 없고 산출물 디렉터리를 수정할 수 없습니다.

## Rollback

앱을 Windows service나 system PATH에 설치하지 않으므로 rollback은 디렉터리 교체로 끝나야 합니다.

1. 실행 중인 `start.ps1` process를 종료합니다.
2. `output`과 browser profile은 보존합니다.
3. `app` 디렉터리를 이전 hash가 검증된 bundle로 교체합니다.
4. `.env`를 유지하고 `doctor.ps1`, `smoke.ps1`을 다시 실행합니다.
