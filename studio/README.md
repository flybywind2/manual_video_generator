# Manual Video Studio

사용자 프롬프트를 승인 가능한 브라우저 조작 계획으로 바꾸고, 실제 브라우저 실행을 녹화한 뒤 한국어 내레이션·캡션·강조 효과를 합성해 매뉴얼 MP4를 만드는 Windows 로컬 웹서비스입니다. 서비스와 모든 sidecar는 `127.0.0.1`에만 바인딩됩니다.

## 지원 실행 방법

지원되는 시작 진입점은 `scripts/start.ps1` 하나입니다. PowerShell에서 이 디렉터리(`studio`)로 이동한 뒤 다음 명령을 실행하세요.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

이 명령은 요구 버전을 검사·준비하고 Supertonic sidecar를 숨김 창으로 시작한 다음 Node.js 서비스를 `http://127.0.0.1:4317`에서 실행합니다. 종료는 같은 터미널에서 `Ctrl+C`를 누릅니다. 포트를 바꾸려면 `-Port 4318`처럼 지정할 수 있습니다.

설치나 프로세스 시작 없이 상태만 확인하려면 같은 진입점의 점검 모드를 사용합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Check
```

예정 작업만 보려면 `-WhatIf`를 사용합니다. 과거 Python 백엔드나 별도 웹서버는 실행 경로에 포함되지 않습니다.

## 다섯 엔진

| 엔진 | 고정/요구 버전 | 역할 |
|---|---:|---|
| OpenCode | `>=1.17.19` | 프롬프트 해석, 계획 생성, 실행 보고서 판정 |
| Playwright MCP | `0.0.78` | 허용된 origin과 정확히 승인된 호출만 수행하는 브라우저 조작·녹화 |
| Supertonic | `1.3.1` / Python `3.13.14` | 로컬 한국어 44.1 kHz 내레이션 합성 |
| HyperFrames | `0.7.57` | 캡션·챕터·하이라이트 타임라인 구성과 렌더링 |
| FFmpeg / FFprobe | `8.1.2` | 녹화 정규화, 최종 MP4 검사, H.264/AAC 품질 게이트 |

Node.js는 22 이상이어야 합니다. 시작 스크립트는 모든 엔진의 실제 버전을 확인하고, `@playwright/mcp`와 `hyperframes`를 lockfile 그대로 준비합니다. OpenCode는 호환되는 네이티브 `opencode.exe`를 재사용합니다. 명시적으로 지정된 실행 파일, 프로젝트 런타임, PATH의 모든 네이티브 실행 파일, 전역 npm 패키지가 선언한 네이티브 실행 파일을 순서대로 검증하며, 버전이 `1.17.19` 이상인 첫 후보를 선택합니다. 이미 설치된 호환 후보가 없을 때만 정확한 프로젝트 로컬 폴백 `1.18.2`를 `.runtime/opencode`에 준비합니다. `opencode.cmd`와 `opencode.ps1` 같은 command shim은 패키지 위치를 찾기 위한 단서로만 확인하고 실행하지 않습니다.

Python이 누락되거나 버전이 다르면 Windows 패키지 도구를 통해 준비를 시도한 뒤 다시 검증합니다. FFmpeg는 winget 없이 공식 Gyan 8.1.2 essentials ZIP을 Gyan 직접 경로에서 우선 내려받고 GitHub 미러를 보조 경로로 사용합니다. Windows BITS와 일반 웹 요청을 순서대로 시도하며, SHA-256을 검증한 뒤 `.runtime/ffmpeg`에 프로젝트 로컬 폴백으로 준비합니다. 이미 PATH에 정확한 8.1.2가 있으면 다운로드하지 않고 재사용합니다. Python 설치 뒤 PATH가 바뀌면 터미널을 다시 열고 시작 명령을 한 번 더 실행하세요.

### 회사 PC에서 OpenCode 진단과 시작

회사 PC에서 pull한 뒤 PowerShell로 `studio` 디렉터리에 들어가 다음 순서로 확인하세요.

```powershell
git pull --ff-only
where.exe opencode.exe
where.exe opencode.cmd
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Check
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

두 `where.exe` 명령은 네이티브 후보와 npm shim 배치 여부를 읽기 전용으로 조회할 뿐입니다. 발견된 command shim은 위치만 확인하고 실행하지 않습니다. 실행 파일 검증은 Studio의 제한 시간·출력 크기·버전 규칙을 모두 적용하는 `scripts/start.ps1 -Check` 하나만 사용하세요. `-Check` 결과의 `checks.opencode.actual`은 Studio가 실제 선택한 버전을 보여 줍니다. PATH의 첫 후보가 오래된 `1.4.1`이어도 뒤에 있는 호환 후보를 계속 검사합니다. 첫 실행 전 호환 후보가 전혀 없으면 `-Check`는 설치 없이 불일치를 보고할 수 있으며, 일반 시작 명령이 프로젝트 폴백을 준비합니다.

회사 프록시나 보안망이 두 FFmpeg 자동 다운로드를 모두 403으로 차단하면, 조직에서 허용한 브라우저 다운로드 방식으로 [공식 Gyan FFmpeg 8.1.2 essentials ZIP](https://www.gyan.dev/ffmpeg/builds/packages/ffmpeg-8.1.2-essentials_build.zip)을 저장한 뒤 아래처럼 절대 경로를 지정하세요. Studio가 고정 SHA-256과 내부 실행 파일 버전을 다시 검증하므로 다른 ZIP은 허용되지 않습니다.

```powershell
$env:MANUAL_STUDIO_FFMPEG_ARCHIVE_PATH = "$HOME\Downloads\ffmpeg-8.1.2-essentials_build.zip"
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
Remove-Item Env:MANUAL_STUDIO_FFMPEG_ARCHIVE_PATH
```

## 사용 흐름

1. 화면에서 대상 URL, “어떤 과정을 설명할지”, 필요한 인증·리소스 origin 허용 목록을 입력합니다.
2. 로그인 방식을 고르고 작업을 만듭니다.
3. OpenCode가 제안한 정확한 Playwright MCP 호출 목록을 검토·수정한 뒤 승인합니다.
4. 실행 승인을 누르면 브라우저 조작과 녹화가 시작됩니다. 계획과 실제 호출이 다르면 자동으로 중단됩니다.
5. Supertonic 내레이션과 HyperFrames 미리보기를 확인하고 캡션 또는 내레이션을 수정합니다.
6. 미리보기를 승인하면 FFmpeg/FFprobe 품질 게이트를 통과한 `final.mp4`만 완료 파일로 제공합니다.

각 승인 화면에 표시된 digest는 현재 계획 또는 미리보기에 결합됩니다. 인증·리소스 origin 허용 목록도 계획에 포함되어 함께 고정되며, 다른 탭이나 이전 화면의 오래된 승인 값은 거부됩니다.

클릭 강조는 사이트별 좌표를 하드코딩하지 않습니다. 승인된 각 `browser_click` 직전에 coordinator가 같은 Playwright locator의 실제 viewport 사각형을 수집하고, 측정된 클릭 시작 시각과 결합합니다. HyperFrames는 이 신뢰된 좌표에 900ms 보라-파랑 테두리와 중심 ripple을 후처리하므로 클릭 뒤 페이지가 이동해도 강조가 영상에 남고, 한 단계의 여러 클릭도 각각 표시됩니다. 대상은 화면의 `target URL`, 사용자 프롬프트, 완료 조건으로 정해지므로 로컬 fixture나 특정 포털에 종속되지 않습니다.

## 로그인과 DPAPI

### 수동 로그인

`직접 로그인`을 선택하면 제어 브라우저가 로그인 화면을 엽니다. 사용자가 브라우저에서 직접 로그인하고 Studio의 `로그인 완료`를 눌러야 다음 단계로 진행합니다. 아이디와 비밀번호는 OpenCode 프롬프트, 작업 이벤트, 영상 산출물에 포함되지 않습니다.

### 자동 로그인

`저장된 로그인`은 미리 등록한 credential ID만 작업에 기록합니다. 원문 자격 증명은 Windows 현재 사용자 범위 DPAPI로 암호화되어 `data/credentials` 아래에 저장되고, 인증 순간에만 브라우저 런타임으로 전달됩니다. 다른 Windows 사용자나 다른 PC에서는 복호화할 수 없습니다. 각 저장 항목은 하나의 정규화된 HTTP(S) 로그인 origin에 결합되며, 작업의 로그인 origin과 정확히 일치하지 않으면 브라우저를 시작하지 않습니다.

자동 로그인에서는 대상 URL을 로그인 후 도착할 화면으로 지정하세요. 로그인 폼 URL과 대상 URL이 같으면 안전한 자동 인증 성공을 확인할 수 없으므로 수동 로그인을 사용하세요.

등록은 실행 중인 loopback API의 `PUT /api/credentials/{credential-id}`가 담당하며, JSON 본문은 `origin`, `username`, `password`를 포함해야 합니다. 응답은 `204`이며 입력 값을 되돌려 주지 않습니다. origin 결합 정보가 없던 이전 v1 저장 파일은 자동 변환하지 않고 안전하게 거부하므로, 이 버전의 화면 또는 API에서 올바른 로그인 origin으로 다시 저장해야 합니다. PowerShell에서는 `Get-Credential`로 값을 대화형 입력해 JSON을 메모리에서 만든 뒤 요청하고, 사용한 변수를 즉시 제거하세요. credential ID에는 영문자·숫자·`_`·`-`만 사용합니다. 자격 증명을 명령행 인자, 환경 변수, 소스 파일 또는 작업 프롬프트에 넣지 마세요.

## 데이터와 모델 다운로드

- 작업 이벤트와 산출물: `data/jobs/<job-id>/`
- DPAPI 암호문: `data/credentials/`
- Supertonic 모델 캐시: `data/cache/supertonic-3/`
- 격리 Python 환경과 일시 런타임: `.runtime/supertonic/`
- 프로젝트 로컬 FFmpeg/FFprobe 폴백: `.runtime/ffmpeg/`
- 수동 로그인 Playwright 브라우저 프로필: `data/browser-profile/`
- 자동 로그인 일회용 프로필: `.runtime/browser/<job-id>/profile/` (작업 종료 시 폐기)

첫 실행 시 Supertonic 모델 다운로드가 발생합니다. 공식 Python SDK 안내는 현재 모델 다운로드를 약 400 MB로 설명하지만, 실제 용량은 모델·패키지 버전에 따라 달라질 수 있으므로 충분한 여유 공간을 확보하세요. 정확한 FFmpeg 8.1.2가 PC에 없으면 약 109 MB의 프로젝트 로컬 ZIP도 한 번 다운로드합니다. 이 서비스는 `SUPERTONIC_CACHE_DIR`을 위의 프로젝트 로컬 캐시로 고정합니다. 다운로드에는 네트워크가 필요하지만 합성과 영상 처리는 준비 완료 후 loopback에서 로컬로 처리됩니다.

## 실패와 재시도

브라우저 실행, 내레이션, 합성, 렌더링은 단계별로 실패 상태와 안전한 오류 코드만 기록합니다. 페이지 불일치가 발생한 자동 로그인 작업은 현재 mismatch 이벤트와 계획 digest를 다시 승인한 뒤 새 인증 세션에서 정확한 호출 전체를 재실행합니다. 렌더 실패는 계획·미리보기 digest가 모두 일치할 때 기존 녹화·음성·구성을 그대로 검증하고 렌더 단계만 다시 실행합니다. 계획 digest 또는 미리보기 digest가 바뀌면 재승인이 거부됩니다. 수동 로그인 작업의 페이지 불일치 재실행은 새 사용자 로그인이 필요하다는 안전한 오류로 중단됩니다. 반복 실패 전에 대상 사이트의 화면 변경, 로그인 만료, Supertonic health, 디스크 여유 공간을 확인하세요.

작업을 취소하면 현재 브라우저·OpenCode·Supertonic·렌더 프로세스에 중단 신호를 보내고 더 이상 다음 장면을 시작하지 않습니다. 비밀 값은 상태 응답이나 로그에 출력되지 않습니다.

## 검증과 라이브 스모크

`scripts/verify.mjs`는 전체 테스트와 doctor를 먼저 통과시킨 뒤 선택된 `final.mp4`를 검사합니다. FFprobe 계약은 MP4/H.264/yuv420p/1920×1080/30 fps/AAC/44.1 또는 48 kHz와 영상·음성 길이를 확인합니다. FFmpeg 분석은 무음이나 단일 연속 정지·검정 구간이 거의 전 구간을 차지하는 placeholder를 거부하고, 결합된 media plan에 유효한 캡션이 없으면 실패합니다. 여러 실제 장면 사이의 의도된 정적 설명 구간은 합산해 placeholder로 오인하지 않습니다.

클릭 강조 검증은 media plan `1.1`의 각 `scenes[].highlights[]`에 절대 `startMs`, 900ms `durationMs`, locator에서 수집한 `x/y/width/height`가 있는지 확인합니다. 실제 렌더 회귀 테스트는 각 cue 전·중·후의 target ROI 픽셀을 비교해 강조가 cue 동안에만 나타나는지 검증합니다.

검증할 작업을 명시하려면 다음처럼 최종 영상과 그 영상에 결합된 media plan을 함께 전달합니다. 인자를 생략하면 가장 최근 `final.mp4`를 선택합니다. `npm run verify -- --artifact ... --plan ...`도 같은 검증기를 실행합니다.

```powershell
node scripts/verify.mjs --artifact "data/jobs/<job-id>/artifacts/final.mp4" --plan "data/jobs/<job-id>/artifacts/media-plan.json"
```

실제 API 전체 흐름 스모크는 의도하지 않은 브라우저 조작을 막기 위해 기본적으로 건너뜁니다. 실행하려면 서비스가 켜진 별도 터미널에서 `MANUAL_STUDIO_LIVE_SMOKE=1`을 설정한 뒤 `node scripts/smoke-live.mjs`를 실행합니다. 수동 로그인은 터미널 안내 후 사용자가 완료하고, 자동 로그인은 `MANUAL_STUDIO_SMOKE_AUTH_MODE=automatic`과 기존 credential ID가 추가로 필요합니다. 스모크는 계획 승인, 실행, 미리보기 승인, 최종 렌더 이벤트까지 실제 API를 통과합니다.

스모크 입력은 아래 환경 변수로만 덮어씁니다. 값을 지정하지 않으면 로컬 fixture와 기본 프롬프트를 사용합니다.

| 환경 변수 | 의미 |
|---|---|
| `MANUAL_STUDIO_BASE_URL` | Studio loopback 주소. 기본값은 `http://127.0.0.1:4317` |
| `MANUAL_STUDIO_SMOKE_TIMEOUT_MS` | 각 review gate의 제한 시간. 10초~1시간 |
| `MANUAL_STUDIO_SMOKE_TARGET_URL` | 실제로 조작할 HTTP(S) 대상 URL |
| `MANUAL_STUDIO_SMOKE_PROMPT` | OpenCode가 계획할 사용자 요청 |
| `MANUAL_STUDIO_SMOKE_COMPLETION_CONDITION` | 마지막 화면에서 확인할 명시적 완료 조건 |
| `MANUAL_STUDIO_SMOKE_AUTH_MODE` | `manual` 또는 `automatic` |
| `MANUAL_STUDIO_SMOKE_CREDENTIAL_ID` | 자동 로그인일 때 사용할 origin-bound credential ID |

스모크가 timeout, API 오류 또는 `Ctrl+C`로 중단되면 이미 생성한 작업에 취소를 최선 노력으로 요청한 뒤 원래 오류를 반환합니다.

실제 OpenCode 설치본에 대한 계약 테스트는 명시적으로 opt-in합니다. 두 변수에는 command shim이 아니라 각각 해당 버전의 네이티브 `opencode.exe` 절대 경로를 넣으세요. 변수가 없으면 관련 실버전 테스트만 건너뜁니다.

```powershell
$env:MANUAL_STUDIO_TEST_OPENCODE_1_17_19_PATH = "C:\path\to\opencode-1.17.19.exe"
$env:MANUAL_STUDIO_TEST_OPENCODE_1_18_2_PATH = "C:\path\to\opencode-1.18.2.exe"
node --test test/adapters/opencode-config.test.js test/adapters/opencode-server.test.js
Remove-Item Env:MANUAL_STUDIO_TEST_OPENCODE_1_17_19_PATH, Env:MANUAL_STUDIO_TEST_OPENCODE_1_18_2_PATH
```

## 생성물 고지와 라이선스

최종 영상의 내레이션은 AI로 합성된 음성입니다. 배포 대상과 조직 정책에 맞게 “AI 합성 음성 사용” 사실을 영상 설명 또는 함께 제공하는 문서에 명확히 고지하고, 실제 사람이 말한 것으로 오인시키는 사용을 피하세요. 사용자에게 대상 사이트를 조작·녹화할 권한이 있는지 확인해야 합니다.

Supertonic 프로젝트의 샘플 코드는 MIT License이며, 함께 제공되는 모델은 **OpenRAIL-M License**입니다. 배포·상업적 이용 전에 모델 저장소의 전체 라이선스와 사용 제한을 직접 검토해야 합니다.

- [Supertonic 공식 저장소와 라이선스](https://github.com/supertone-inc/supertonic)
- [Supertonic Python SDK 공식 안내](https://github.com/supertone-inc/supertonic-py)

OpenCode, Playwright MCP, HyperFrames, FFmpeg에도 각각의 라이선스가 적용됩니다. 완성 영상의 콘텐츠 권리와 대상 서비스 약관 준수 책임은 사용자에게 있습니다.
