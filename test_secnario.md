# 사내 Qwen3.5 파이프라인 검증 시나리오

이 문서는 사내 PC에서 Docker 없이 `qwen3.5` OpenAI-compatible LLM을 붙여 확인할 3개 검증만 정리한다.

검증 목표:

1. Python `3.13.14` 런타임에서 전체 테스트가 통과하는지 확인
2. Qwen3.5 + Playwright MCP live + HyperFrames/FFmpeg + TTS 실제 의존성으로 샘플 e2e 영상 생성
3. 실제 사내 시스템 로그인/직접 시연 모드로 영상 1개 생성

## 공통 준비

PowerShell에서 repo root로 이동한다.

```powershell
cd "C:\Users\xiro1\OneDrive\Documents\New project 5"
```

Python `3.13.14` 가상환경을 만든다.

```powershell
py -3.13 -m venv .venv
.\.venv\Scripts\Activate.ps1
python --version
```

기대값:

```text
Python 3.13.14
```

패키지와 Playwright Chromium을 설치한다.

```powershell
python -m pip install --upgrade pip
python -m pip install -e ".[dev]"
python -m playwright install chromium
```

Node, MCP, FFmpeg, HyperFrames, TTS CLI/라이브러리 확인:

```powershell
node -v
npx -v
npx @playwright/mcp@latest --help
ffmpeg -version
npx --yes hyperframes render --help
python -c "import playwright; print('playwright ok')"
```

Supertonic preset voice를 쓸 경우:

```powershell
python -m pip install supertonic
python -c "from supertonic import TTS; tts=TTS(auto_download=False); style=tts.get_voice_style(voice_name='M1'); wav,duration=tts.synthesize('안녕하세요. 사내 시스템 사용 방법을 안내합니다.', voice_style=style, lang='ko'); tts.save_audio(wav, 'supertonic_smoke.wav'); print(duration)"
```

## Qwen3.5 환경 파일

repo root에 `.env.qwen35.internal`을 만든다. 실제 URL, 티켓, 사용자 ID는 사내 값으로 교체한다.

```env
MANUAL_AGENT_LLM_PROVIDER=internal
MANUAL_AGENT_LLM_BASE_URL=http://api.net:8000/v1
MANUAL_AGENT_LLM_MODEL=qwen3.5
MANUAL_AGENT_OPENAI_API_KEY=replace-with-api-key
MANUAL_AGENT_DEP_TICKET=credential:TICKET-
MANUAL_AGENT_SEND_SYSTEM_NAME=manual-video-agent
MANUAL_AGENT_USER_ID=replace-with-ad-id
MANUAL_AGENT_USER_TYPE=AD_ID

MANUAL_AGENT_ENABLE_INPUT_EXTRACTOR=true
MANUAL_AGENT_ENABLE_INTERNAL_PLANNER=true
MANUAL_AGENT_ENABLE_BROWSER_AGENT=true
MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS=10
MANUAL_AGENT_LLM_TIMEOUT_SECONDS=600
MANUAL_AGENT_REQUEST_TIMEOUT_SECONDS=60

MANUAL_AGENT_PLAYWRIGHT_MCP_MODE=live
MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND=npx @playwright/mcp@latest --headless
MANUAL_AGENT_PLAYWRIGHT_EXECUTABLE_PATH=

MANUAL_AGENT_VIDEO_RENDERER=hyperframes
MANUAL_AGENT_HYPERFRAMES_COMMAND=npx --yes hyperframes render
MANUAL_AGENT_ENABLE_HYPERFRAMES_SKILLS=false

MANUAL_AGENT_TTS_PROVIDER=supertonic
MANUAL_AGENT_SUPERTONIC_VOICE=M1
MANUAL_AGENT_SUPERTONIC_LANG=ko
MANUAL_AGENT_SUPERTONIC_AUTO_DOWNLOAD=false

MANUAL_AGENT_LOGIN_MODE=none
MANUAL_AGENT_LOGIN_USERNAME_SELECTOR=
MANUAL_AGENT_LOGIN_PASSWORD_SELECTOR=
MANUAL_AGENT_LOGIN_SUBMIT_SELECTOR=
MANUAL_AGENT_LOGIN_SUCCESS_SELECTOR=
MANUAL_AGENT_LOGIN_USERNAME=
MANUAL_AGENT_LOGIN_PASSWORD=

MANUAL_AGENT_OUTPUT_DIR=output
MANUAL_AGENT_ENABLE_TERMINAL_LOGS=true
MANUAL_AGENT_DEMONSTRATION_TIMEOUT_SECONDS=900
```

현재 PowerShell 세션에 적용한다.

```powershell
$env:MANUAL_AGENT_ENV_FILE=".env.qwen35.internal"
```

## 1. Python 3.13.14 전체 테스트

목적: 배포 대상 Python 버전에서 코드/테스트가 깨지지 않는지 확인한다. 이 단계는 외부 LLM/MCP/TTS 호출 검증이 아니라 런타임 호환성 검증이다.

다른 Python에서 수행한 소스 테스트는 개발 참고 결과일 뿐이다. 회사 합격 판정은 정확히 Python 3.13.14에서 `doctor`, 전체 pytest, compile, bundle, smoke를 실행한 결과만 인정한다.

테스트가 실서비스 호출에 끌려가지 않도록 안전한 테스트 env를 별도로 만든다.

```powershell
@"
MANUAL_AGENT_ENABLE_INTERNAL_PLANNER=false
MANUAL_AGENT_ENABLE_BROWSER_AGENT=false
MANUAL_AGENT_PLAYWRIGHT_MCP_MODE=manifest
MANUAL_AGENT_TTS_PROVIDER=fake-melotts-compatible
MANUAL_AGENT_VIDEO_RENDERER=playwright-webm
MANUAL_AGENT_ENABLE_TERMINAL_LOGS=false
"@ | Set-Content -Encoding UTF8 .env.test-safe
```

실행:

```powershell
$env:MANUAL_AGENT_ENV_FILE=".env.test-safe"
python -m pytest -q --basetemp .pytest_tmp
python -m compileall backend\app
.\scripts\doctor.ps1
.\scripts\build_bundle.ps1 -SkipDownloads
.\scripts\smoke.ps1 -SkipTests
```

합격 기준:

- pytest가 모두 통과한다.
- `compileall`이 exit code 0으로 끝난다.
- Python 버전이 반드시 `3.13.14`다.
- `doctor.ps1`의 Python 항목이 `PASS`이고, 번들 `versions.json`의 요구/실제 버전이 모두 `3.13.14`다.
- `smoke.ps1`이 정확한 런타임 검증 후 exit code 0으로 끝난다.

완료 후 Qwen3.5 env로 되돌린다.

```powershell
$env:MANUAL_AGENT_ENV_FILE=".env.qwen35.internal"
```

## 2. Qwen3.5 + MCP live + HyperFrames + TTS 샘플 e2e

목적: 실제 의존성을 켠 상태에서 샘플 시스템을 대상으로 계획, MCP live 리허설, Playwright 캡처, TTS, HyperFrames 렌더, 패키지 검증까지 확인한다.

실행:

```powershell
$env:MANUAL_AGENT_ENV_FILE=".env.qwen35.internal"

@'
from pathlib import Path
import json
from backend.app.pipeline import PipelineInput, run_pipeline
from tools.verify_package import verify_manifest

base = Path.cwd() / "output" / "qwen35-sample-e2e"
base.mkdir(parents=True, exist_ok=True)
target_url = (Path.cwd() / "backend" / "app" / "templates" / "sample.html").resolve().as_uri()

result = run_pipeline(
    PipelineInput(
        request_text="MES에서 LOT-001을 조회하고 상세 화면을 확인하는 사용법 영상을 만들어줘",
        target_url=target_url,
        role="작업자",
        completion_condition="상세 화면이 보이면 완료",
        input_values={"LOT": "LOT-001", "라인": "A3"},
        execution_mode="ai",
        login_mode="none",
    ),
    base_dir=base,
    capture_browser=True,
)

errors = verify_manifest(result.artifacts.package_manifest)
manifest = json.loads(result.artifacts.package_manifest.read_text(encoding="utf-8"))
capture_log = json.loads(result.artifacts.capture_action_log.read_text(encoding="utf-8"))
render_meta = json.loads(result.artifacts.video_render_metadata.read_text(encoding="utf-8"))
tts_meta = json.loads(result.artifacts.tts_metadata.read_text(encoding="utf-8"))

summary = {
    "job_id": result.job_id,
    "package_dir": str(result.package_dir),
    "manifest": str(result.artifacts.package_manifest),
    "video": str(result.artifacts.video),
    "video_exists": result.artifacts.video.exists(),
    "capture_status": capture_log.get("status"),
    "capture_failed_entries": [e for e in capture_log.get("entries", []) if e.get("status") == "failed"],
    "render_status": render_meta.get("status"),
    "render_used_fallback": render_meta.get("used_fallback"),
    "tts_provider": tts_meta.get("requested_provider"),
    "degradations": manifest.get("degradations", []),
    "verify_errors": errors,
}
print(json.dumps(summary, ensure_ascii=False, indent=2))

if errors:
    raise SystemExit(1)
if any(e.get("status") == "failed" for e in capture_log.get("entries", [])):
    raise SystemExit(2)
if any(d.get("actor") in {"capture", "rehearsal", "render", "tts"} for d in manifest.get("degradations", [])):
    raise SystemExit(3)
'@ | python -
```

합격 기준:

- `verify_errors`가 빈 배열이다.
- `capture_failed_entries`가 빈 배열이다.
- `degradations`에 `capture`, `rehearsal`, `render`, `tts`가 없어야 한다.
- HyperFrames가 정상 동작하면 `manual_video_agent_usage.mp4`가 생성된다.
- Supertonic이 정상 동작하면 `tts_metadata.json`에 `requested_provider=supertonic`이 기록되고 silent fallback이 없어야 한다.

실패 시 먼저 확인할 파일:

- `output\qwen35-sample-e2e\jobs\<job_id>\planner_trace.json`
- `output\qwen35-sample-e2e\jobs\<job_id>\llm_responses.jsonl`
- `output\qwen35-sample-e2e\jobs\<job_id>\playwright_mcp_calls.json`
- `output\qwen35-sample-e2e\jobs\<job_id>\playwright_mcp_execution.json`
- `output\qwen35-sample-e2e\jobs\<job_id>\capture_action_log.json`
- `output\qwen35-sample-e2e\jobs\<job_id>\video_render.json`
- `output\qwen35-sample-e2e\jobs\<job_id>\tts\tts_metadata.json`

## 3. 실제 사내 시스템 로그인/직접 시연 모드

목적: 운영 대상과 유사한 사내 URL에서 사용자가 직접 로그인/조작하고, 그 시연을 기반으로 영상 패키지가 생성되는지 확인한다.

주의:

- 운영계 비밀번호, OTP, SSO 토큰은 요청문이나 UI 입력값에 넣지 않는다.
- 로그인은 브라우저에서 직접 수행한다.
- 영상에 민감정보가 보일 수 있으므로 생성 후 `masking_log.json`, 최종 영상, `manual.md`를 반드시 확인한다.

서버 실행:

```powershell
$env:MANUAL_AGENT_ENV_FILE=".env.qwen35.internal"
python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

별도 PowerShell 창에서 draft를 만든다. `TARGET_URL`은 실제 사내 시스템 URL로 교체한다.

```powershell
$env:TARGET_URL="https://internal.example.local/chatbot"

$draft = Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8000/api/pipeline/draft?capture_browser=true" `
  -ContentType "application/json" `
  -Body (@{
    request_text = "사내 chatbot 서비스에 접속해서 st.form과 st.input의 입력 차이점을 질문하고 답변을 확인하는 사용법 영상을 만들어줘"
    target_url = $env:TARGET_URL
    role = "사용자"
    completion_condition = "챗봇 답변이 화면에 보이면 완료"
    execution_mode = "demonstration"
    login_mode = "manual"
    input_values = @{
      "프롬프트" = "st.form과 st.input의 입력 차이점을 설명해줘"
    }
  } | ConvertTo-Json -Depth 6)

$draft | ConvertTo-Json -Depth 6
```

계획 검수 후 continue를 실행한다.

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri "http://127.0.0.1:8000/api/pipeline/continue/$($draft.job_id)?capture_browser=true"
```

브라우저가 열리면 다음 순서로 직접 수행한다.

1. 사내 로그인 화면이 보이면 직접 로그인한다.
2. 로그인 완료 후 화면이 넘어가면 시스템 사용 절차를 직접 시연한다.
3. 챗봇 입력창에 `st.form과 st.input의 입력 차이점을 설명해줘`를 입력한다.
4. 전송 버튼 또는 Enter로 질문을 보낸다.
5. 답변이 보이면 화면 오른쪽 아래 `시연 완료` 버튼을 누른다.
6. 파이프라인이 마스킹, TTS, HyperFrames 렌더, 패키지 생성을 끝낼 때까지 기다린다.

패키지 검증:

```powershell
$manifest = Get-ChildItem -Path "output\jobs" -Recurse -Filter package_manifest.json |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1

python tools\verify_package.py $manifest.FullName
Get-Content $manifest.FullName
```

합격 기준:

- `verify_package.py`가 `Package verified`를 출력한다.
- `package_manifest.json`의 `status`가 `completed`다.
- `artifacts.video` 파일이 존재한다.
- `capture_action_log.json`에 `type=demonstration`, `status=ok`, `event_count > 0`이 기록된다.
- 최종 영상에 마우스 포인터, 클릭 강조, 입력창 강조가 보인다.
- `llm_responses.jsonl`에 Qwen3.5 planner/input extractor 응답이 기록된다.
- 비밀번호, OTP, API key, dep ticket 원문이 `manual.md`, `planner_trace.json`, `llm_responses.jsonl`, `package_manifest.json`, `audit_log.jsonl`에 없어야 한다.

실패 시 판단 기준:

| 증상 | 먼저 볼 파일 | 판단 |
|---|---|---|
| Qwen3.5 호출 실패 | `llm_responses.jsonl`, `planner_trace.json` | base URL, headers, `Accept`, timeout 확인 |
| MCP live 실패 | `playwright_mcp_execution.json` | Node/npx, MCP command, tool error 확인 |
| 브라우저 조작 실패 | `capture_action_log.json` | 직접 시연이면 `event_count`, AI 실행이면 failed action 확인 |
| HyperFrames fallback | `video_render.json` | FFmpeg, HyperFrames command, mp4 output 확인 |
| TTS fallback | `tts\tts_metadata.json` | Supertonic 설치, preset voice, model cache 확인 |
| 민감정보 노출 | `masking_log.json`, `manual.md`, `audit_log.jsonl` | 운영 전 마스킹 규칙 보강 필요 |
