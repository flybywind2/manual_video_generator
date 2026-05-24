# Manual Video Agent

사내 시스템 사용 시나리오를 입력하면 로컬 PC에서 사용 매뉴얼 영상과 문서 패키지를 생성하는 MVP입니다.

현재 목표는 운영계 시스템을 바로 자동 조작하는 것이 아니라, 샘플 사내 시스템 화면을 대상으로 전체 제작 흐름을 검증하는 것입니다. 내부 LLM/RAG/VLM/Reranker, `playwright-mcp`, Supertonic/MeloTTS, HyperFrames는 `.env`로 켜고 끌 수 있는 어댑터 경계까지 포함합니다.

## 무엇을 만드는 시스템인가

관리자가 "MES에서 LOT 조회 방법 영상 만들기" 같은 시나리오를 입력하면 다음 산출물을 만듭니다.

- 브라우저 화면 녹화 영상
- HTML preview
- Markdown 매뉴얼
- PDF 매뉴얼 placeholder
- 실행 action plan JSON
- 승인/리허설/마스킹 로그
- TTS 오디오
- 산출물 manifest

완성된 영상은 이 시스템 안에서 장기 보관하지 않습니다. 생성된 패키지를 관리자가 확인한 뒤 별도 저장소나 게시 시스템에서 관리하는 구조입니다.

## 현재 구현 상태

| 영역 | 상태 | 설명 |
|---|---|---|
| 로컬 웹앱 | 구현 | FastAPI, Jinja template, vanilla JS 기반 |
| 홈 화면 UI | 구현 | `D:\Python\appendix\AI Center DESIGN.md`의 AI Center inspired 디자인 적용 |
| 샘플 사내 시스템 | 구현 | `/sample`에서 테스트용 MES LOT 조회 화면 제공 |
| 파이프라인 API | 구현 | `/api/pipeline/run`으로 산출물 생성 |
| Action plan | 구현 | 기본은 입력값 라벨/버튼 텍스트 기반 semantic action planner, 옵션으로 내부 LLM planner 호출 |
| 브라우저 캡처 | 구현 | Playwright action plan 기반 범용 캡처 및 WebM 녹화 |
| 실행 방식 선택 | 구현 | UI에서 직접 시연 또는 AI 자동 실행 선택 |
| 로그인 처리 | 구현 | 로그인 없음, 사용자가 직접 로그인, `.env` ID/password 자동 입력 지원 |
| 마스킹 | 구현 | 기본 이미지 마스킹과 로그 생성 |
| `.env` 설정 | 구현 | `D:\Python\appendix\appendix.md` 기반 내부 API 설정 로드 |
| 설정 상태 UI/API | 구현 | key 원문 없이 구성 여부만 표시 |
| `playwright-mcp` | 어댑터 구현 | manifest 생성 또는 live stdio JSON-RPC 실행 |
| 내부 LLM/RAG/Reranker | 어댑터 구현 | `.env`로 켜면 RAG/Reranker context와 LLM JSON planner 호출 |
| VLM | 설정 준비 | `.env`와 상태 API만 준비, 화면 검수 호출은 다음 단계 |
| Supertonic 3 TTS | 어댑터 구현 | preset voice만 사용, OpenRAIL-M/AI 음성 고지를 metadata와 manual에 기록 |
| MeloTTS | 어댑터 구현 | 설치되어 있으면 한국어 wav 생성, 없으면 silent wav fallback |
| HyperFrames | 어댑터 구현 | skills 설치/확인, composition 생성, `.env`로 켜면 CLI 렌더 시도 후 실패 시 WebM fallback |
| OpenCode | 어댑터 구현 | 생성 패키지 디렉터리에서 `opencode run` 비대화형 agent pass 실행 |
| 감사/게이트 | 구현 | `AuditLog`, `RiskPolicy`, `ApprovalGate`, degraded reason을 package manifest에 기록 |
| PDF | placeholder | 정식 렌더러가 아닌 최소 PDF 생성 |
| MP4 | 옵션 | HyperFrames 렌더 성공 시 MP4, 기본은 WebM |

## 파이프라인

```mermaid
flowchart TB
    A["사용자 요청 입력<br/>시나리오, 대상 URL, 역할, 완료 조건, 입력값"] --> B["/api/pipeline/draft"]
    B --> C["요청 증강 + 입력값 추출<br/>scenario_brief, request.json, input_extraction.json"]
    C --> D{"Planner 선택"}
    D -->|기본| E["Deterministic planner<br/>semantic action plan 생성"]
    D -->|MANUAL_AGENT_ENABLE_INTERNAL_PLANNER=true| F["Internal LLM planner<br/>RAG/Reranker context 선택 사용"]
    E --> G["ActionPlan 확정<br/>action_plan.json"]
    F --> G
    G --> H{"로그인 필요 여부"}
    H -->|로그인 전 접근 가능| I["playwright-mcp 리허설<br/>manifest 또는 live stdio JSON-RPC"]
    H -->|로그인 필요| J["MCP live 리허설 지연<br/>deferred_until_login=true"]
    I --> K["ApprovalGate<br/>approval_log.json"]
    J --> K
    K --> L["계획 검수 대기<br/>workflow_state: plan_review"]
    L --> M["사용자 승인<br/>/api/pipeline/continue/{job_id}"]
    M --> N{"실행 방식"}
    N -->|직접 시연| O["사용자가 브라우저에서 조작<br/>시연 완료 버튼"]
    N -->|AI 자동 실행| P["Browser Agent + Playwright<br/>화면 분석, 클릭, 입력, 캡처"]
    O --> Q["시연 이벤트 분석<br/>음성 타이밍 기준 replay 녹화"]
    P --> R["capture_action_log.json<br/>WebM, screenshots, final frame"]
    Q --> R
    R --> S["Masking<br/>입력값/민감정보 블러, masking_log.json"]
    R --> T["Media plan + subtitles<br/>media_plan.json, subtitles.vtt"]
    T --> U["TTS<br/>Supertonic 또는 MeloTTS, fallback silent wav"]
    S --> V["Preview + Manual<br/>preview.html, manual.md, manual.pdf"]
    U --> W["HyperFrames render<br/>MP4 또는 WebM fallback"]
    V --> W
    W --> X["OpenCode optional pass<br/>opencode_prompt.md, opencode_agent.json"]
    X --> Y["Package manifest + audit log<br/>package_manifest.json, audit_log.jsonl"]
    Y --> Z["산출물 링크 표시<br/>영상은 관리자가 별도 저장소에서 관리"]
```

실행 중에는 백엔드가 `workflow_state.json`을 단계별로 갱신하고, UI는 이 파일을 폴링해 좌측 Workflow와 Pipeline 진행 상태를 갱신합니다.
내부적으로는 `backend/app/workflow_graph.py`의 `WORKFLOW_GRAPH`가 각 단계의 actor, label, next_steps를 정의합니다. `workflow_state.json`에는 현재 `workflow_node`와 전체 `workflow_graph` metadata가 포함되어 UI, 진단 로그, 향후 LangGraph 전환의 기준 계약으로 쓰입니다.

```mermaid
stateDiagram-v2
    [*] --> input: 요청 입력
    input --> planning: draft 생성
    planning --> plan_review: 계획 검수 대기
    plan_review --> capture: 사용자 승인
    capture --> replay: 직접 시연 replay 필요
    capture --> masking: 일반 캡처 완료
    replay --> masking
    masking --> tts
    tts --> preview
    preview --> render
    render --> opencode
    opencode --> manifest
    manifest --> completed
    capture --> execution_failed: 브라우저/로그인/캡처 실패
    replay --> execution_failed: replay 실패
    tts --> render: TTS degraded fallback
    render --> completed: HyperFrames fallback
    execution_failed --> plan_review: 재시도 가능
    completed --> rerender: 텍스트 산출물 편집 후 재렌더링
    rerender --> completed
```

현재 기본값은 안전한 로컬/fallback 모드입니다. `.env`에서 `MANUAL_AGENT_ENABLE_INTERNAL_PLANNER`, `MANUAL_AGENT_ENABLE_BROWSER_AGENT`, `MANUAL_AGENT_PLAYWRIGHT_MCP_MODE=live`, `MANUAL_AGENT_TTS_PROVIDER`, `MANUAL_AGENT_VIDEO_RENDERER`, `MANUAL_AGENT_ENABLE_HYPERFRAMES_SKILLS`, `MANUAL_AGENT_ENABLE_OPENCODE`, `MANUAL_AGENT_ENABLE_TERMINAL_LOGS` 등을 켜면 내부 LLM/RAG/Reranker, Playwright 기반 브라우저 판단 루프, Playwright MCP, MeloTTS, HyperFrames skills/render, OpenCode 어댑터, 터미널 실행 로그를 실제 실행합니다.

요청문이 짧거나 모호해도 `input_extraction.json`에는 `scenario_brief`가 함께 생성됩니다. 이 브리프는 `task_type`, `success_criteria`, `required_inputs`, `safe_click_intents`, `forbidden_click_intents`, `autonomy_guidance`를 포함하며 planner와 browser agent 프롬프트에 전달됩니다. 예를 들어 챗봇 요청은 질문 입력, 전송/Enter, 답변 대기 중심으로 증강하고 `Web Search`, 모델 선택, 도구 토글 같은 선택형 UI는 금지 의도로 유지합니다.

fallback 원인 분석이 필요하면 `.env`에서 `MANUAL_AGENT_STRICT_MODE=true`를 켭니다. strict mode는 입력값 추출, planner, 브라우저 캡처처럼 fallback을 자주 타는 단계에서 첫 예외를 그대로 발생시켜 문제 지점을 숨기지 않습니다. 일반 모드에서도 `package_manifest.json`의 `fallback_events`에는 강등된 actor, reason, 관련 artifact, 요약 details가 남습니다.

`MANUAL_AGENT_ENABLE_BROWSER_AGENT=true`인 경우 LLM이 설정되지 않았거나 일시적으로 실패해도 즉시 기존 action plan으로 내려가지 않고, 관찰된 필드/버튼/`scenario_brief`를 기준으로 로컬 자율 정책을 먼저 사용합니다. 이 로컬 정책은 입력값 매핑, 안전 클릭 의도, 금지 클릭 의도, 최근 실패 이력을 보고 `fill_by_label`, `click_by_text`, `press_key`, `capture_step`, `finish` 중 하나를 선택합니다.

개발 작업 기준 문서는 [Workflow-Based Codebase Structure](docs/workflow-codebase-structure.md)를 사용합니다. 다음 개선 작업은 [tasks.md](tasks.md)에 워크플로우 단계별로 정리합니다.

사내 PC에서 Codex를 사용할 수 없고 OpenCode만 허용되는 배포 기준은 [OpenCode Only 사내 배포 메모](docs/OPENCODE_ONLY_DEPLOYMENT.md)를 따릅니다.

## 환경 준비

이 프로젝트의 Python 표준 버전은 `3.10.19`입니다. Python 3.11 이상을 전제로 설치하지 않습니다.

### 1. Python 3.10.19 가상환경

Windows에서 Python Launcher가 설치되어 있으면 다음처럼 만듭니다.

```powershell
py -3.10 -m venv .venv
.\.venv\Scripts\Activate.ps1
python --version
```

`python --version`은 다음처럼 보여야 합니다.

```text
Python 3.10.19
```

필요 패키지를 설치합니다.

```powershell
python -m pip install --upgrade pip
python -m pip install fastapi "uvicorn[standard]" pydantic pillow playwright httpx pytest
python -m playwright install chromium
```

Playwright 공식 문서는 `pip install playwright` 후 `playwright install`로 브라우저 바이너리를 설치하는 흐름을 안내합니다. 이 프로젝트는 Chromium만 사용하므로 `python -m playwright install chromium`을 기본으로 둡니다.

사내망에서 Playwright 브라우저 다운로드가 막히면 사내 프록시 또는 사내 캐시 경로를 먼저 설정해야 합니다.

```powershell
$env:HTTPS_PROXY="http://proxy.example:8080"
python -m playwright install chromium
```

### 2. FFmpeg

MP4 변환, HyperFrames 렌더링, 오디오 mux 단계에는 `ffmpeg`가 필요합니다. 현재 MVP는 WebM을 직접 생성하므로 필수는 아니지만, HyperFrames 실연동 단계부터는 설치해야 합니다.

```powershell
winget install --id Gyan.FFmpeg -e
ffmpeg -version
```

### 3. Playwright MCP

백엔드 파이프라인은 기본 캡처에는 Python Playwright를 직접 사용합니다. `playwright-mcp`는 `live` 모드에서 action plan을 실제 브라우저 tool call로 검증하는 MCP 서버입니다. 기본 `manifest` 모드는 실제 리허설이 아니라 후보 MCP call manifest만 생성합니다.

Node.js와 `npx`가 필요합니다. 사내 운영 환경에서는 Codex CLI나 Codex MCP 설정을 사용하지 않습니다. 백엔드가 `.env`의 `MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND`를 직접 실행하므로 OpenCode만 설치된 PC에서도 이 단계는 동작할 수 있습니다.

```powershell
node -v
npx -v
```

Windows에서 `npx`가 인식되지 않으면 Node.js 설치 경로가 `PATH`에 들어갔는지 먼저 확인합니다.

앱에서 실제 MCP live session을 켜려면 `.env`를 다음처럼 설정합니다.

```env
MANUAL_AGENT_PLAYWRIGHT_MCP_MODE=live
MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND=npx @playwright/mcp@latest --headless
```

`live` 모드에서는 백엔드가 MCP 서버를 stdio JSON-RPC로 실행하고 `initialize`, `tools/list`, `tools/call`을 호출합니다. `navigate`, selector 기반 `fill/click`, semantic `fill_by_label/click_by_text`, `capture_step`을 MCP tool call로 실행하며, 실행 로그는 `playwright_mcp_execution.json`에 남습니다. 실패해도 파이프라인은 Python Playwright 캡처 또는 placeholder 캡처로 계속 진행합니다.

### 4. HyperFrames

HyperFrames는 HTML 기반 video composition을 preview/render하는 Node.js 계열 도구입니다. 현재 MVP는 HyperFrames를 직접 호출하지 않고 HTML preview와 Playwright WebM을 생성합니다. MP4 품질 렌더링으로 넘어갈 때 HyperFrames 어댑터를 연결합니다.

필요 조건:

- Node.js `22` 이상
- FFmpeg
- 사내망에서 npm registry 접근 또는 사내 npm mirror

설치/검증:

```powershell
node -v
ffmpeg -version
npx hyperframes init manual-video-renderer
cd manual-video-renderer
npx hyperframes preview
npx --yes hyperframes render
```

에이전트가 HyperFrames composition을 더 정확히 작성하게 하려면 HyperFrames skills를 설치합니다.

```powershell
npx skills add heygen-com/hyperframes
```

앱에서 skills 설치/확인 커맨드를 실행하게 하려면 다음 값을 켭니다.

```env
MANUAL_AGENT_ENABLE_HYPERFRAMES_SKILLS=true
MANUAL_AGENT_HYPERFRAMES_SKILLS_COMMAND=npx skills add heygen-com/hyperframes
MANUAL_AGENT_HYPERFRAMES_COMMAND=npx --yes hyperframes render
```

이 명령은 렌더링 전에 실행되고 결과는 `hyperframes_skills.json`에 저장됩니다. 사내망에서 npm 접근이 막혀 실패해도 composition 생성과 fallback 영상 생성은 계속됩니다.

사내 PC에서 Codex를 사용할 수 없는 경우에도 위 명령은 Codex 설정에 의존하지 않습니다. OpenCode 후처리는 별도 `MANUAL_AGENT_ENABLE_OPENCODE=true` 설정으로 실행합니다.

HyperFrames 저장소 자체를 clone해서 개발할 경우 Git LFS가 필요할 수 있습니다.

```powershell
winget install GitHub.GitLFS
git lfs install
```

### 5. Supertonic 3 / MeloTTS 한국어 TTS

권장 TTS는 `Supertone/supertonic-3`입니다. ONNX Runtime 기반 로컬 추론을 사용하고 한국어(`ko`)를 지원합니다. 이 시스템에서는 라이선스/음성권 리스크를 줄이기 위해 **preset voice만 사용**하며, custom voice cloning 또는 임직원 음성 복제는 지원하지 않습니다.

Supertonic 3 설정:

```env
MANUAL_AGENT_TTS_PROVIDER=supertonic
MANUAL_AGENT_SUPERTONIC_VOICE=M1
MANUAL_AGENT_SUPERTONIC_LANG=ko
MANUAL_AGENT_SUPERTONIC_AUTO_DOWNLOAD=false
```

설치/검증:

```powershell
python -m pip install supertonic
python -c "from supertonic import TTS; tts=TTS(auto_download=False); style=tts.get_voice_style(voice_name='M1'); wav,duration=tts.synthesize('안녕하세요. 사내 시스템 사용 방법을 안내합니다.', voice_style=style, lang='ko'); tts.save_audio(wav, 'kr.wav')"
```

사내망/폐쇄망에서는 첫 실행 다운로드를 막기 위해 `MANUAL_AGENT_SUPERTONIC_AUTO_DOWNLOAD=false`를 권장합니다. 모델 assets와 preset voice styles는 빌드 PC에서 미리 받아 번들 캐시(`HF_HOME` 또는 런타임 assets 경로)에 포함하세요.

라이선스/고지 정책:

- Model: `Supertone/supertonic-3`
- Model license: `BigScience Open RAIL-M License`
- Voice source: `preset voice` only
- Generated manuals include an AI voice disclosure when `MANUAL_AGENT_TTS_PROVIDER=supertonic`
- Generated `tts_metadata.json` includes the model license and preset-only voice policy

MeloTTS는 대체 어댑터로 남겨둡니다. 현재 MVP는 TTS 라이브러리가 없으면 silent wav placeholder를 생성합니다. MeloTTS로 실제 한국어 내레이션을 만들려면 MeloTTS 어댑터를 사용합니다.

권장 방식은 별도 TTS 가상환경을 두는 것입니다. 이 앱의 표준 Python은 `3.10.19`지만, MeloTTS 공식 문서는 Ubuntu 20.04/Python 3.9 개발·테스트 기준과 Windows Docker 사용 권장을 함께 안내합니다. Windows native 설치가 실패하면 WSL 또는 별도 Python 3.9 TTS 환경으로 분리하는 편이 안전합니다.

Python 3.10.19에서 먼저 시도할 수 있는 설치 흐름:

```powershell
git clone https://github.com/myshell-ai/MeloTTS.git third_party\MeloTTS
python -m pip install -e third_party\MeloTTS
python -m unidic download
```

한국어 음성 생성 smoke test:

```powershell
python -c "from melo.api import TTS; model=TTS(language='KR', device='cpu'); spk=model.hps.data.spk2id; model.tts_to_file('안녕하세요. 사내 시스템 사용 방법을 안내합니다.', spk['KR'], 'kr.wav', speed=1.0)"
```

VRAM 6GB 환경에서는 먼저 `device='cuda:0'`를 시도하고, OOM이 나면 `device='cpu'`로 운영합니다.

```powershell
python -c "import torch; print(torch.cuda.is_available())"
```

### 6. 설치 확인

```powershell
python -c "import fastapi, pydantic, PIL, playwright; print('python runtime ok')"
python -m playwright install --help
node -v
npx -v
ffmpeg -version
```

### 7. OpenCode

OpenCode는 생성된 산출물 패키지 디렉터리에서 비대화형 agent pass를 실행하는 선택 기능입니다. OpenCode CLI 문서의 `opencode run [message..]` 형태를 사용합니다.

설치/확인:

```powershell
npm install -g opencode-ai
opencode --help
opencode run --help
```

앱에서 OpenCode를 켜려면 `.env`를 다음처럼 설정합니다.

```env
MANUAL_AGENT_ENABLE_OPENCODE=true
MANUAL_AGENT_OPENCODE_COMMAND=opencode run --format json
MANUAL_AGENT_OPENCODE_AGENT=build
MANUAL_AGENT_OPENCODE_MODEL=
MANUAL_AGENT_OPENCODE_TIMEOUT_SECONDS=600
```

OpenCode 어댑터는 각 job 패키지에 `opencode_prompt.md`를 만들고, 그 prompt를 `opencode run` 마지막 인자로 넘깁니다. 기본 prompt는 `hyperframes/index.html`, `hyperframes/hyperframes_manifest.json`, `opencode_notes.md`만 편집 대상으로 제한합니다. 실행 결과는 `opencode_agent.json`에 저장됩니다.

## 실행 방법

```powershell
python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

브라우저에서 다음 주소를 엽니다.

```text
http://127.0.0.1:8000
```

샘플 사내 시스템 화면은 다음 주소입니다.

```text
http://127.0.0.1:8000/sample
```

## 사용 방법

1. 홈 화면에서 요청문, 대상 URL, 계정 역할, 완료 조건, 실행 방식, 입력값을 확인합니다. 입력값을 비워도 요청문에서 업무 입력값을 자동 추출합니다.
2. 로그인 창이 나오는 시스템이면 `로그인 방식`을 고릅니다.
3. 기본 대상 URL은 `/sample`입니다.
4. `파이프라인 실행`을 누릅니다.
5. 실행이 끝나면 홈 화면에 산출물 링크가 표시됩니다.
6. `preview.html`, WebM 영상, Markdown, PDF, JSON 로그를 확인합니다.
7. 최종 영상 파일은 관리자가 별도 보관합니다.

### 실행 방식

작업마다 홈 화면의 `실행 방식`에서 다음 둘 중 하나를 고릅니다.

- `직접 시연`: 승인 후 headed Playwright 브라우저가 열립니다. 사용자가 로그인, 입력, 클릭, 조회를 직접 수행한 뒤 화면 오른쪽 아래의 `시연 완료` 버튼을 누르면 녹화를 끝내고 마스킹, TTS, HyperFrames/영상 패키징을 진행합니다. 이 모드에서는 브라우저 에이전트가 action plan을 대신 클릭하지 않습니다.
- `AI 자동 실행`: 승인 후 내부 planner/browser agent 설정에 따라 AI가 화면을 관찰하고 안전한 입력, 클릭, 대기, 캡처 동작을 선택합니다. `MANUAL_AGENT_ENABLE_BROWSER_AGENT=true`와 LLM 설정이 있어야 LLM 기반 화면 판단 루프가 동작하며, 꺼져 있으면 확정된 action plan 기반 캡처로 fallback합니다.

사내 시스템 화면 구성이 자주 바뀌거나 요청문만으로 selector/버튼 의미를 안정적으로 맞추기 어려운 경우에는 `직접 시연`을 기본으로 사용합니다. 반복 가능한 샘플 화면이나 검수된 target에서는 `AI 자동 실행`을 사용할 수 있습니다.

Input Extractor는 먼저 요청문에서 `LOT-001`, `라인 A3`, `사용자ID U100` 같은 업무 입력값을 뽑아 `input_values`를 보강합니다. LLM이 설정되어 있으면 LLM JSON extractor를 사용하고, 없으면 로컬 규칙으로 fallback합니다. 사용자가 직접 입력한 `input_values`는 추출값보다 우선합니다. 비밀번호, OTP, token, API key, ticket류는 추출하지 않습니다.

기본 planner는 selector를 모르는 상태에서도 입력값 이름을 화면 label/placeholder/name과 맞춰 채우고, 요청문에 `조회`, `검색`, `상세` 같은 안전한 읽기 동작이 있으면 같은 텍스트의 버튼을 찾아 클릭합니다. 예를 들어 요청문 `LOT-001 조회 후 상세 화면 확인`은 Input Extractor가 `LOT=LOT-001`을 만들고, planner가 `LOT` 입력칸 채우기, `조회` 버튼 클릭, `상세 보기` 버튼 클릭으로 실행합니다. 저장, 제출, 삭제 같은 쓰기 동작은 기본 semantic planner의 자동 클릭 대상이 아니며, 운영 전에는 LLM action plan 검수나 Action JSON 편집 UI로 확정해야 합니다.

### 로그인 방식

로그인 방식은 작업마다 선택할 수 있습니다.

- `로그인 없음`: 기본값입니다. 로그인 페이지가 없는 샘플 또는 이미 접근 가능한 URL에 사용합니다.
- `직접 로그인`: Playwright가 headed 브라우저를 띄우고 사용자가 직접 로그인합니다. 로그인 브라우저 오른쪽 아래에 `로그인 완료` 버튼이 표시되며, 사용자가 이 버튼을 누르면 다음 단계로 넘어갑니다. `로그인 완료 selector`를 지정하면 selector가 보이거나 버튼을 누르는 것 중 먼저 만족된 신호를 사용합니다.
- `.env ID/password`: `.env`에 저장한 ID/password와 selector를 사용해 로그인 폼을 자동 입력합니다. 비밀번호 원문은 UI, `/api/config/status`, request artifact, audit log, capture action log에 기록하지 않습니다.

직접 로그인은 OTP, SSO, 사내 인증 앱처럼 자동 입력하면 안 되는 흐름에 사용합니다. ID/password 자동 입력은 테스트 계정이나 승인된 자동화 계정에서만 사용합니다.

수동 로그인 브라우저는 녹화하지 않습니다. 로그인 완료 신호를 받은 뒤 저장된 세션 상태만 녹화 브라우저로 넘겨 실제 매뉴얼 영상 캡처를 시작합니다.

## 산출물 구조

산출물은 기본적으로 `output/jobs/<job_id>/` 아래에 생성됩니다.

```text
output/jobs/<job_id>/
  preview.html
  manual_video_agent_usage.webm
  manual.md
  manual.pdf
  action_plan.json
  input_extraction.json
  llm_responses.jsonl
  approval_log.json
  audit_log.jsonl
  capture_action_log.json
  selector_trace.json
  support_log.md
  planner_trace.json
  rehearsal_log.json
  playwright_mcp_calls.json
  playwright_mcp_execution.json
  masking_log.json
  hyperframes_skills.json
  opencode_prompt.md
  opencode_agent.json
  video_render.json
  package_manifest.json
  captures/
  masked/
  tts/
    tts_metadata.json
  hyperframes/
    index.html
    hyperframes_manifest.json
```

`MANUAL_AGENT_OUTPUT_DIR`을 설정하면 기본 출력 경로를 바꿀 수 있습니다.

`package_manifest.json`은 기존 주요 산출물 목록인 `artifacts`와 함께 운영 검수용 `supporting_artifacts`를 제공합니다. `supporting_artifacts`에는 요청 원문, LLM 응답 preview 로그, audit log, planner trace, selector trace, rehearsal log, Playwright MCP call manifest, TTS metadata, HyperFrames composition, OpenCode prompt/result처럼 문제 재현과 관리자 검수에 필요한 파일 경로가 들어갑니다.

사내 테스트 중 실패하거나 기대와 다르게 동작하면 `support_log.md`를 우선 전달합니다. 이 파일은 사용자가 메모할 수 있는 항목, job id, 현재 workflow step, last_error, 요청 요약, degraded/fallback, 최근 audit, 첨부 권장 파일 목록을 한 파일로 정리합니다. 실패한 `continue` 실행에서도 `workflow_state.json`과 함께 자동 생성됩니다. 파일을 첨부하거나 복사할 수 없는 환경에서는 `support_log.md` 상단의 `타이핑용 요약` 섹션만 먼저 전달합니다. 이 섹션은 `short_code`, 짧은 job id, 상태, 단계, 원인/오류만 5~6줄로 정리합니다.

`degradations`에는 fallback이 일어난 사유를 1급 필드로 남깁니다. 예를 들어 MeloTTS 미설치로 silent wav를 만든 경우 `tts_silent_fallback`, HyperFrames 렌더 실패로 WebM fallback을 사용한 경우 `hyperframes_fallback_video`가 기록됩니다.

## `.env` 설정

내부 API 접속값은 `.env`로 관리합니다. 예시 파일은 [.env.example](.env.example)에 있습니다.

```powershell
Copy-Item .env.example .env
```

그 다음 `.env`에서 `MANUAL_AGENT_*` 값을 사내 발급값으로 채웁니다.

동일한 key가 `.env`와 프로세스 환경변수에 모두 있으면 프로세스 환경변수를 우선합니다. 배포/테스트에서 임시 출력 경로나 모델명을 바꿀 때 `.env`를 수정하지 않아도 됩니다.

주요 설정은 다음과 같습니다.

```text
MANUAL_AGENT_OPENAI_API_KEY
MANUAL_AGENT_DEP_TICKET
MANUAL_AGENT_SEND_SYSTEM_NAME
MANUAL_AGENT_USER_ID
MANUAL_AGENT_USER_TYPE
MANUAL_AGENT_LLM_PROVIDER
MANUAL_AGENT_LLM_BASE_URL
MANUAL_AGENT_LLM_MODEL
MANUAL_AGENT_ENABLE_INTERNAL_PLANNER
MANUAL_AGENT_ENABLE_INPUT_EXTRACTOR
MANUAL_AGENT_LLM_TIMEOUT_SECONDS
MANUAL_AGENT_REQUEST_TIMEOUT_SECONDS
MANUAL_AGENT_VLM_BASE_URL
MANUAL_AGENT_VLM_MODEL
MANUAL_AGENT_RAG_INSERT_URL
MANUAL_AGENT_RAG_RETRIEVE_URL
MANUAL_AGENT_RAG_DELETE_URL
MANUAL_AGENT_RAG_API_KEY
MANUAL_AGENT_RAG_INDEX_NAME
MANUAL_AGENT_RAG_PERMISSION_GROUPS
MANUAL_AGENT_ENABLE_RAG_CONTEXT
MANUAL_AGENT_RERANKER_URL
MANUAL_AGENT_RERANKER_MODEL
MANUAL_AGENT_ENABLE_RERANKER
MANUAL_AGENT_PLAYWRIGHT_MCP_MODE
MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND
MANUAL_AGENT_PLAYWRIGHT_EXECUTABLE_PATH
MANUAL_AGENT_BROWSER_RUNNER
MANUAL_AGENT_CDP_ENDPOINT
MANUAL_AGENT_EXTENSION_BRIDGE_ENDPOINT
MANUAL_AGENT_EXTENSION_BRIDGE_TOKEN
MANUAL_AGENT_ENABLE_BROWSER_AGENT
MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS
MANUAL_AGENT_LOGIN_MODE
MANUAL_AGENT_LOGIN_USERNAME_SELECTOR
MANUAL_AGENT_LOGIN_PASSWORD_SELECTOR
MANUAL_AGENT_LOGIN_SUBMIT_SELECTOR
MANUAL_AGENT_LOGIN_SUCCESS_SELECTOR
MANUAL_AGENT_LOGIN_USERNAME
MANUAL_AGENT_LOGIN_PASSWORD
MANUAL_AGENT_LOGIN_MANUAL_TIMEOUT_SECONDS
MANUAL_AGENT_LOGIN_CREDENTIALS_TIMEOUT_SECONDS
MANUAL_AGENT_BROWSER_CHANNEL
MANUAL_AGENT_USER_DATA_DIR
MANUAL_AGENT_BROWSER_USER_DATA_DIR
MANUAL_AGENT_AUTH_SERVER_ALLOWLIST
MANUAL_AGENT_AUTH_NEGOTIATE_DELEGATE_ALLOWLIST
MANUAL_AGENT_OUTPUT_DIR
MANUAL_AGENT_ENABLE_TERMINAL_LOGS
MANUAL_AGENT_DEMONSTRATION_TIMEOUT_SECONDS
MANUAL_AGENT_TTS_PROVIDER
MANUAL_AGENT_TTS_DEVICE
MANUAL_AGENT_TTS_LANGUAGE
MANUAL_AGENT_TTS_SPEAKER
MANUAL_AGENT_TTS_SPEED
MANUAL_AGENT_SUPERTONIC_VOICE
MANUAL_AGENT_SUPERTONIC_LANG
MANUAL_AGENT_SUPERTONIC_AUTO_DOWNLOAD
MANUAL_AGENT_VIDEO_RENDERER
MANUAL_AGENT_HYPERFRAMES_COMMAND
MANUAL_AGENT_ENABLE_HYPERFRAMES_SKILLS
MANUAL_AGENT_HYPERFRAMES_SKILLS_COMMAND
MANUAL_AGENT_ENABLE_OPENCODE
MANUAL_AGENT_OPENCODE_COMMAND
MANUAL_AGENT_OPENCODE_AGENT
MANUAL_AGENT_OPENCODE_MODEL
MANUAL_AGENT_OPENCODE_TIMEOUT_SECONDS
```

운영 어댑터를 켜는 예시:

```env
MANUAL_AGENT_ENABLE_INTERNAL_PLANNER=true
MANUAL_AGENT_ENABLE_INPUT_EXTRACTOR=true
MANUAL_AGENT_LLM_TIMEOUT_SECONDS=180
MANUAL_AGENT_ENABLE_RAG_CONTEXT=true
MANUAL_AGENT_ENABLE_RERANKER=true
MANUAL_AGENT_ENABLE_BROWSER_AGENT=true
MANUAL_AGENT_BROWSER_AGENT_MAX_STEPS=8
MANUAL_AGENT_DEMONSTRATION_TIMEOUT_SECONDS=600
MANUAL_AGENT_PLAYWRIGHT_MCP_MODE=live
MANUAL_AGENT_TTS_PROVIDER=supertonic
MANUAL_AGENT_SUPERTONIC_VOICE=M1
MANUAL_AGENT_SUPERTONIC_LANG=ko
MANUAL_AGENT_SUPERTONIC_AUTO_DOWNLOAD=false
MANUAL_AGENT_VIDEO_RENDERER=hyperframes
MANUAL_AGENT_ENABLE_HYPERFRAMES_SKILLS=true
MANUAL_AGENT_ENABLE_OPENCODE=true
```

MeloTTS를 사용할 때 VRAM 6GB에서 OOM이 나면 `MANUAL_AGENT_TTS_DEVICE=cpu`로 바꿉니다.

설정 변경 후 앱을 재시작합니다.

Ollama OpenAI-compatible endpoint를 내부 planner/browser agent LLM으로 사용할 때는 다음처럼 설정합니다. Ollama provider는 `base_url`과 `model`만으로 configured 상태가 되며, 사내 `x-dep-ticket`, `User-Id` 헤더를 보내지 않습니다.

```env
MANUAL_AGENT_LLM_PROVIDER=ollama
MANUAL_AGENT_LLM_BASE_URL=http://127.0.0.1:11434/v1
MANUAL_AGENT_LLM_MODEL=gemma4:31b-cloud
MANUAL_AGENT_ENABLE_INTERNAL_PLANNER=true
MANUAL_AGENT_ENABLE_BROWSER_AGENT=true
MANUAL_AGENT_LLM_TIMEOUT_SECONDS=300
MANUAL_AGENT_ENABLE_TERMINAL_LOGS=true
```

내부 LLM 추론이 오래 걸려 planner가 timeout fallback으로 빠지면 `MANUAL_AGENT_LLM_TIMEOUT_SECONDS=300`처럼 LLM 전용 timeout만 늘립니다. `MANUAL_AGENT_REQUEST_TIMEOUT_SECONDS`는 RAG, Reranker, MCP 같은 비-LLM 어댑터의 공통 timeout이므로 무작정 크게 올리지 않는 편이 좋습니다.

로그인 자동 입력 예시:

```env
MANUAL_AGENT_LOGIN_MODE=credentials
MANUAL_AGENT_LOGIN_USERNAME_SELECTOR=#username
MANUAL_AGENT_LOGIN_PASSWORD_SELECTOR=#password
MANUAL_AGENT_LOGIN_SUBMIT_SELECTOR=button[type="submit"]
MANUAL_AGENT_LOGIN_SUCCESS_SELECTOR=.main-dashboard
MANUAL_AGENT_LOGIN_USERNAME=test-user
MANUAL_AGENT_LOGIN_PASSWORD=replace-with-password
MANUAL_AGENT_LOGIN_CREDENTIALS_TIMEOUT_SECONDS=30
```

사용자 직접 로그인 예시:

```env
MANUAL_AGENT_LOGIN_MODE=manual
MANUAL_AGENT_LOGIN_SUCCESS_SELECTOR=.main-dashboard
MANUAL_AGENT_LOGIN_MANUAL_TIMEOUT_SECONDS=120
```

`MANUAL_AGENT_LOGIN_SUCCESS_SELECTOR`를 비워도 수동 로그인 브라우저의 `로그인 완료` 버튼으로 진행할 수 있습니다.

AD 기반 SSO를 사용하는 사내 PC에서는 내가 평소 쓰는 브라우저와 Playwright 브라우저의 프로필이 달라서 새 로그인처럼 보일 수 있습니다. 이때는 Playwright가 매번 임시 프로필을 만들지 않도록 전용 persistent profile을 사용합니다.

```env
MANUAL_AGENT_LOGIN_MODE=sso_profile
MANUAL_AGENT_BROWSER_CHANNEL=msedge
MANUAL_AGENT_USER_DATA_DIR=C:\AppBundle\manualgen\browser-profile
MANUAL_AGENT_AUTH_SERVER_ALLOWLIST=*.company.local
MANUAL_AGENT_AUTH_NEGOTIATE_DELEGATE_ALLOWLIST=*.company.local
```

처음 한 번은 이 전용 프로필 창에서 SSO가 완료되도록 열어 두고, 이후부터 같은 `MANUAL_AGENT_USER_DATA_DIR`을 재사용합니다. 기존 설정명 `MANUAL_AGENT_BROWSER_USER_DATA_DIR`도 별칭으로 지원하지만, 둘 다 설정되어 있으면 `MANUAL_AGENT_USER_DATA_DIR`이 우선입니다. 평소 개인/업무용 Edge 프로필 경로를 직접 지정하지 말고, 이 시스템 전용 짧은 ASCII 경로를 별도로 쓰는 것을 권장합니다.

직접 시연 모드에서도 `sso_profile`은 유지됩니다. 이 모드에서는 수동 로그인용 `로그인 완료` 버튼을 쓰지 않고, 사용자가 실제 업무 흐름을 끝낸 뒤 `시연 완료` 신호만 누르면 됩니다.

Playwright가 새 브라우저를 띄우는 방식이 사내 SSO/보안정책과 맞지 않으면 CDP attach 모드를 사용할 수 있습니다. 자세한 절차는 [docs/CDP_USAGE.md](docs/CDP_USAGE.md)를 참고하세요.

`MANUAL_AGENT_BROWSER_RUNNER=cdp_attach`로 실행하면 직접 시연과 시연 기반 replay가 모두 이미 열린 CDP 브라우저 컨텍스트를 사용합니다. 이 경우 로그인된 브라우저 상태를 잃지 않지만, 기존 CDP 컨텍스트에서는 Playwright 내장 WebM 녹화가 제한되어 영상 산출물이 degraded로 표시될 수 있습니다.

사내 정책상 CDP 포트를 열기 어렵거나, 사용자가 이미 로그인한 실제 브라우저 탭 안에서 agent를 동작시켜야 하면 extension bridge 모드를 사용할 수 있습니다. 이 모드는 LiteWebAgent 계열처럼 브라우저 확장/로컬 네이티브 호스트가 `observe → act → verify` API를 제공하고, Manual Video Agent는 그 계약에 따라 다음 행동을 결정합니다. 자세한 계약은 [docs/EXTENSION_BRIDGE.md](docs/EXTENSION_BRIDGE.md)를 참고하세요.

터미널에서 파이프라인 구성요소별 진행 상황을 보려면 다음을 켭니다.

```env
MANUAL_AGENT_ENABLE_TERMINAL_LOGS=true
```

켜면 `pipeline`, `environment`, `planner`, `rehearsal`, `approval`, `capture`, `masking`, `tts`, `render`, `opencode`, `manifest` 단계가 `[manual-agent] {...}` JSON 로그로 stderr에 출력됩니다. 또한 `actor="tool"` 로그로 `llm`, `rag`, `reranker`, `playwright-python`, `playwright-mcp`, `ffmpeg`, `node`, `npm`, `tts`, `hyperframes`, `opencode`의 사용/설정/가용 상태를 함께 남깁니다.

내부 LLM 호출이 실제로 응답을 받으면 `actor="llm_response"` 로그가 추가로 출력됩니다. 이 로그에는 `component`(`input_extractor`, `planner`, `browser_agent`), `model`, `content_preview`, `content_length`, `choice_count`가 들어갑니다. Planner와 input extractor 응답 preview는 생성 패키지의 `llm_responses.jsonl`에도 저장됩니다. 로그는 비밀값, 로그인 값, OTP/API key류를 원문으로 남기지 않고 redacted/boolean 상태만 기록합니다. 기본값은 `false`입니다.

설정 상태는 홈 화면의 `.env 설정 상태` 또는 다음 API에서 확인합니다.

```http
GET /api/config/status
```

비밀값 원문은 UI/API 응답에 표시하지 않습니다. `.env`는 `.gitignore`에 포함되어 커밋되지 않습니다.

## Docker 없는 사내 PC 배포

사내 PC마다 Python, Node, 프록시, 루트 CA, Defender/EDR 정책이 다르므로 운영 배포는 개발자 설치 절차와 분리합니다. 권장 방식은 온라인 빌드 PC에서 오프라인 번들 zip을 만들고, 대상 PC에서는 짧은 ASCII 경로에 압축을 푼 뒤 `bootstrap`과 `doctor`를 통과시키는 흐름입니다.

권장 설치 경로:

```powershell
C:\AppBundle\manualgen
```

OneDrive, 한글 사용자명 아래의 깊은 경로, 공백이 많은 경로는 피합니다. `output/`, `.env`, Playwright 브라우저 캐시, TTS 모델 캐시가 OneDrive로 동기화되면 파일 잠금과 비밀값 유출 위험이 생깁니다.

### 런타임 디렉터리 규칙

번들형 배포에서는 다음 경로를 repo/bundle 내부로 고정합니다.

```text
runtime/
  browsers/       # PLAYWRIGHT_BROWSERS_PATH
  hf-cache/       # HF_HOME
  npm-cache/      # NPM_CONFIG_CACHE
  ffmpeg/bin/     # ffmpeg.exe, ffprobe.exe
  node/           # portable Node.js
config/
  corp-root-ca.pem
output/
```

앱은 실행 시 `MANUAL_AGENT_BUNDLE_ROOT` 기준으로 `PLAYWRIGHT_BROWSERS_PATH`, `HF_HOME`, `NPM_CONFIG_CACHE`, `REQUESTS_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS` 같은 환경값을 기본 보정합니다. 기존 프로세스 환경변수가 있으면 그 값을 우선합니다.

### 운영자 실행 절차

```powershell
Set-Location C:\AppBundle\manualgen
.\scripts\bootstrap.ps1
.\scripts\doctor.ps1
.\scripts\smoke.ps1 -SkipTests
.\scripts\start.ps1
```

`doctor.ps1`는 Python 3.10, Node/npm/npx, FFmpeg, Playwright browser cache, 한글/긴 경로 위험, OneDrive 경로, 사내 CA, HF cache, 앱 설정 로딩을 PASS/WARN/FAIL로 점검합니다. 장애 분석용 자료가 필요하면 다음처럼 실행합니다.

```powershell
.\scripts\doctor.ps1 -Collect
```

진단 zip은 `output/diagnostics/` 아래에 생성되고, 비밀로 보이는 환경값은 redact됩니다.

### 오프라인 번들 생성

온라인 접근이 가능한 빌드 PC에서 다음 명령으로 번들 골격을 만들 수 있습니다.

```powershell
.\scripts\build_bundle.ps1
```

인터넷 접근이 불가능한 환경에서 스크립트 구조만 검증하려면 다운로드를 생략합니다.

```powershell
.\scripts\build_bundle.ps1 -SkipDownloads
```

실제 운영 번들은 Python wheels, Playwright Chromium, npm cache, FFmpeg, MeloTTS 모델 캐시, HyperFrames/OpenCode CLI, 사내 루트 CA를 포함해야 합니다. 생성된 `versions.json`은 포함 파일의 SHA256과 버전 식별 정보를 담으며, 설치 PC의 장애 분석 기준점으로 사용합니다.

### 패키지 검증

생성된 job package는 다음 도구로 검사합니다.

```powershell
python tools\verify_package.py output\jobs\<job_id>\package_manifest.json
```

검사 항목은 manifest 상태, 주요 artifact 존재 여부, `manual.md` 공백 여부, `audit_log.jsonl` JSONL 무결성, `degradations` 형식입니다.

## API

Health check:

```http
GET /api/health
```

설정 상태:

```http
GET /api/config/status
```

샘플 화면:

```http
GET /sample
```

파이프라인 실행:

```http
POST /api/pipeline/run
Content-Type: application/json
```

예시 요청:

```json
{
  "request_text": "MES에서 LOT 조회 방법 영상 만들기",
  "target_url": "http://127.0.0.1:8000/sample",
  "role": "작업자",
  "completion_condition": "상세 화면이 보이면 완료",
  "execution_mode": "demonstration",
  "input_values": {
    "LOT": "LOT-001",
    "라인": "A3"
  }
}
```

`execution_mode`는 `demonstration` 또는 `ai`입니다. 생략하면 백엔드 기본값은 `ai`지만, 홈 화면 기본 선택은 실제 사내 화면에서 사용자가 직접 절차를 보여줄 수 있도록 `직접 시연`입니다.

빠른 테스트에서 브라우저 캡처를 생략하려면 query parameter를 사용합니다.

```text
POST /api/pipeline/run?capture_browser=false
```

응답의 `artifacts`에는 바로 열 수 있는 주요 결과 URL이 들어가고, `supporting_artifacts`에는 `llm_responses`, `audit_log`, `planner_trace`, `rehearsal_log`, `playwright_mcp_calls`, `hyperframes_composition`, `opencode_prompt` 같은 검수용 URL이 함께 들어갑니다.
`input_extraction_url`에서는 요청문에서 추출된 입력값과 최종 적용된 입력값을 확인할 수 있습니다.

## 프로젝트 구조

```text
backend/
  app/
    adapters/
      mcp_client.py
      opencode.py
      planner.py
      rehearsal.py
      skills.py
      tts.py
      video.py
    audit.py
    config.py
    env_bootstrap.py
    main.py
    policies.py
    pipeline.py
    static/
      app.js
      styles.css
    templates/
      index.html
      sample.html
  tests/
    test_config.py
    test_env_bootstrap.py
    test_adapters.py
    test_home_ui.py
    test_pipeline.py
    test_policy.py
    test_verify_package.py
docs/
  plans/
    2026-05-17-internal-system-manual-video-agent-design.md
    2026-05-17-internal-system-manual-video-agent-implementation-plan.md
  reviews/
    2026-05-17-genspark-architecture-review.md
scripts/
  bootstrap.ps1
  build_bundle.ps1
  doctor.ps1
  smoke.ps1
  start.ps1
tools/
  verify_package.py
```

핵심 파일:

- [backend/app/main.py](backend/app/main.py): FastAPI route, static artifact serving
- [backend/app/pipeline.py](backend/app/pipeline.py): 산출물 생성 파이프라인
- [backend/app/audit.py](backend/app/audit.py): append-only audit log
- [backend/app/config.py](backend/app/config.py): `.env` 로딩과 safe config status
- [backend/app/env_bootstrap.py](backend/app/env_bootstrap.py): Docker 없는 번들 런타임 환경 보정
- [backend/app/policies.py](backend/app/policies.py): 위험 액션 분류와 승인 게이트
- [backend/app/adapters/planner.py](backend/app/adapters/planner.py): deterministic/internal LLM planner
- [backend/app/adapters/mcp_client.py](backend/app/adapters/mcp_client.py): MCP stdio JSON-RPC client
- [backend/app/adapters/opencode.py](backend/app/adapters/opencode.py): OpenCode CLI agent pass
- [backend/app/adapters/rehearsal.py](backend/app/adapters/rehearsal.py): Playwright MCP manifest/live rehearsal
- [backend/app/adapters/skills.py](backend/app/adapters/skills.py): HyperFrames skills command execution
- [backend/app/adapters/tts.py](backend/app/adapters/tts.py): Supertonic preset voice, MeloTTS, silent fallback
- [backend/app/adapters/video.py](backend/app/adapters/video.py): HyperFrames composition/render fallback
- [backend/app/templates/index.html](backend/app/templates/index.html): 홈 화면
- [backend/app/static/styles.css](backend/app/static/styles.css): AI Center inspired 스타일
- [scripts/doctor.ps1](scripts/doctor.ps1): 사내 PC preflight/진단 수집
- [tools/verify_package.py](tools/verify_package.py): 생성 패키지 manifest 검증

## 테스트

Windows/OneDrive 환경에서 pytest cache 또는 temp 권한 경고가 나면 `TMP`, `TEMP`를 `C:\tmp`로 지정합니다.

```powershell
$env:TMP='C:\tmp'
$env:TEMP='C:\tmp'
python -m pytest -q
```

`C:\tmp`에도 쓰기 권한이 없으면 워크스페이스 내부 임시 디렉터리를 직접 지정합니다.

```powershell
python -m pytest -q --basetemp .pytest_tmp
```

현재 기준 기대 결과:

```text
89 passed
```

## 보안 및 운영 주의사항

- OTP, SSO 토큰은 이 앱 입력값으로 받지 않습니다.
- ID/password 자동 입력이 필요한 경우 `.env`에만 저장하고 UI 작업 요청에는 넣지 않습니다.
- `.env` 원문은 커밋하지 않습니다.
- API key, dep ticket, RAG key는 UI/API에 노출하지 않습니다.
- 현재 MVP는 샘플 시스템 검증용입니다.
- 운영계 연결 전에는 위험 액션 승인, selector 검수, 마스킹 검수, 로그 보관 정책이 필요합니다.
- 자동 클릭/입력 대상은 반드시 테스트 환경에서 먼저 검증해야 합니다.

## 다음 구현 순서

1. VLM 기반 화면 검수 어댑터
2. Action JSON 검수 및 편집 UI
3. 시스템별 selector 학습/고정
4. HyperFrames 렌더 템플릿 고도화
5. MP4 변환 및 `ffmpeg` 검증
6. PDF 정식 렌더러
7. 실제 사내 시스템별 SSO/세션 처리 정책
8. 시스템별 마스킹 룰과 검수 UI
9. 운영계 위험 액션 승인 게이트

## 참고 자료

- `D:\Python\appendix\appendix.md`: 내부 OpenAI-compatible LLM/VLM, RAG, Reranker API 예시
- `D:\Python\appendix\AI Center DESIGN.md`: AI Center inspired 디자인 가이드
- [Playwright Python Library 설치 문서](https://playwright.dev/python/docs/library)
- [Microsoft Playwright MCP README](https://github.com/microsoft/playwright-mcp)
- [HyperFrames README](https://github.com/heygen-com/hyperframes)
- [MeloTTS 설치 문서](https://github.com/myshell-ai/MeloTTS/blob/main/docs/install.md)
- [OpenCode CLI 문서](https://opencode.ai/docs/cli/)
- [docs/plans/2026-05-17-internal-system-manual-video-agent-design.md](docs/plans/2026-05-17-internal-system-manual-video-agent-design.md)
- [docs/plans/2026-05-17-internal-system-manual-video-agent-implementation-plan.md](docs/plans/2026-05-17-internal-system-manual-video-agent-implementation-plan.md)
