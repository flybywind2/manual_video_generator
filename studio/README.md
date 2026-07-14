# Manual Video Studio

사용자 프롬프트를 승인 가능한 브라우저 조작 계획으로 바꾸고, 실제 브라우저 실행을 녹화한 뒤 한국어 내레이션·캡션·강조 효과를 합성해 매뉴얼 MP4를 만드는 Windows 로컬 웹서비스입니다. 서비스와 모든 sidecar는 `127.0.0.1`에만 바인딩됩니다.

## 지원 실행 방법

지원되는 시작 진입점은 `scripts/start.ps1` 하나입니다. PowerShell에서 이 디렉터리(`studio`)로 이동한 뒤 다음 명령을 실행하세요.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

이 명령은 고정 버전을 검사·준비하고 Supertonic sidecar를 숨김 창으로 시작한 다음 Node.js 서비스를 `http://127.0.0.1:4317`에서 실행합니다. 종료는 같은 터미널에서 `Ctrl+C`를 누릅니다. 포트를 바꾸려면 `-Port 4318`처럼 지정할 수 있습니다.

설치나 프로세스 시작 없이 상태만 확인하려면 같은 진입점의 점검 모드를 사용합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start.ps1 -Check
```

예정 작업만 보려면 `-WhatIf`를 사용합니다. 과거 Python 백엔드나 별도 웹서버는 실행 경로에 포함되지 않습니다.

## 다섯 엔진

| 엔진 | 고정/요구 버전 | 역할 |
|---|---:|---|
| OpenCode | 설치된 로컬 CLI | 프롬프트 해석, 계획 생성, 실행 보고서 판정 |
| Playwright MCP | `0.0.78` | 허용된 origin과 정확히 승인된 호출만 수행하는 브라우저 조작·녹화 |
| Supertonic | `1.3.1` / Python `3.13.14` | 로컬 한국어 44.1 kHz 내레이션 합성 |
| HyperFrames | `0.7.57` | 캡션·챕터·하이라이트 타임라인 구성과 렌더링 |
| FFmpeg / FFprobe | 설치된 로컬 CLI | 녹화 정규화, 최종 MP4 검사, H.264/AAC 품질 게이트 |

Node.js는 22 이상이어야 합니다. 시작 스크립트는 `@playwright/mcp`와 `hyperframes`를 lockfile 그대로 준비하며, 누락된 OpenCode·Python·FFmpeg는 Windows 패키지 도구를 통해 준비를 시도합니다. 설치 뒤 PATH가 바뀌면 터미널을 다시 열고 시작 명령을 한 번 더 실행하세요.

## 사용 흐름

1. 화면에서 대상 URL과 “어떤 과정을 설명할지”를 입력합니다.
2. 로그인 방식을 고르고 작업을 만듭니다.
3. OpenCode가 제안한 정확한 Playwright MCP 호출 목록을 검토·수정한 뒤 승인합니다.
4. 실행 승인을 누르면 브라우저 조작과 녹화가 시작됩니다. 계획과 실제 호출이 다르면 자동으로 중단됩니다.
5. Supertonic 내레이션과 HyperFrames 미리보기를 확인하고 캡션 또는 내레이션을 수정합니다.
6. 미리보기를 승인하면 FFmpeg/FFprobe 품질 게이트를 통과한 `final.mp4`만 완료 파일로 제공합니다.

각 승인 화면에 표시된 digest는 현재 계획 또는 미리보기에 결합됩니다. 다른 탭이나 이전 화면의 오래된 승인 값은 거부됩니다.

## 로그인과 DPAPI

### 수동 로그인

`직접 로그인`을 선택하면 제어 브라우저가 로그인 화면을 엽니다. 사용자가 브라우저에서 직접 로그인하고 Studio의 `로그인 완료`를 눌러야 다음 단계로 진행합니다. 아이디와 비밀번호는 OpenCode 프롬프트, 작업 이벤트, 영상 산출물에 포함되지 않습니다.

### 자동 로그인

`저장된 로그인`은 미리 등록한 credential ID만 작업에 기록합니다. 원문 자격 증명은 Windows 현재 사용자 범위 DPAPI로 암호화되어 `data/credentials` 아래에 저장되고, 인증 순간에만 브라우저 런타임으로 전달됩니다. 다른 Windows 사용자나 다른 PC에서는 복호화할 수 없습니다.

등록은 실행 중인 loopback API의 `PUT /api/credentials/{credential-id}`가 담당합니다. 응답은 `204`이며 입력 값을 되돌려 주지 않습니다. PowerShell에서는 `Get-Credential`로 값을 대화형 입력해 JSON을 메모리에서 만든 뒤 요청하고, 사용한 변수를 즉시 제거하세요. credential ID에는 영문자·숫자·`_`·`-`만 사용합니다. 자격 증명을 명령행 인자, 환경 변수, 소스 파일 또는 작업 프롬프트에 넣지 마세요.

## 데이터와 모델 다운로드

- 작업 이벤트와 산출물: `data/jobs/<job-id>/`
- DPAPI 암호문: `data/credentials/`
- Supertonic 모델 캐시: `data/cache/supertonic-3/`
- 격리 Python 환경과 일시 런타임: `.runtime/supertonic/`
- Playwright 브라우저 프로필: `data/browser-profile/`

첫 실행 시 Supertonic 모델 다운로드가 발생합니다. 공식 Python SDK 안내는 현재 모델 다운로드를 약 400 MB로 설명하지만, 실제 용량은 모델·패키지 버전에 따라 달라질 수 있으므로 충분한 여유 공간을 확보하세요. 이 서비스는 `SUPERTONIC_CACHE_DIR`을 위의 프로젝트 로컬 캐시로 고정합니다. 다운로드에는 네트워크가 필요하지만 합성은 준비 완료 후 loopback에서 로컬로 처리됩니다.

## 실패와 재시도

브라우저 실행, 내레이션, 합성, 렌더링은 단계별로 실패 상태와 안전한 오류 코드만 기록합니다. 재시도 가능한 실패에서는 이미 검증된 녹화·장면별 WAV 같은 선행 산출물을 유지하고 실패한 단계부터 재시도합니다. 내레이션 일부만 실패하면 실패 장면만 다시 합성할 수 있습니다. 계획 digest 또는 미리보기 digest가 바뀌면 하위 산출물을 폐기하고 다시 승인을 받아야 합니다. 반복 실패 전에 대상 사이트의 화면 변경, 로그인 만료, Supertonic health, 디스크 여유 공간을 확인하세요.

작업을 취소하면 현재 브라우저·OpenCode·Supertonic·렌더 프로세스에 중단 신호를 보내고 더 이상 다음 장면을 시작하지 않습니다. 비밀 값은 상태 응답이나 로그에 출력되지 않습니다.

## 검증과 라이브 스모크

`scripts/verify.mjs`는 전체 테스트와 doctor를 먼저 통과시킨 뒤 선택된 `final.mp4`를 검사합니다. FFprobe 계약은 MP4/H.264/yuv420p/1920×1080/30 fps/AAC/44.1 또는 48 kHz와 영상·음성 길이를 확인합니다. FFmpeg 분석은 무음, 거의 전 구간의 정지/검정 placeholder를 거부하고, 결합된 media plan에 유효한 캡션이 없으면 실패합니다.

실제 API 전체 흐름 스모크는 의도하지 않은 브라우저 조작을 막기 위해 기본적으로 건너뜁니다. 실행하려면 서비스가 켜진 별도 터미널에서 `MANUAL_STUDIO_LIVE_SMOKE=1`을 설정한 뒤 `node scripts/smoke-live.mjs`를 실행합니다. 수동 로그인은 터미널 안내 후 사용자가 완료하고, 자동 로그인은 `MANUAL_STUDIO_SMOKE_AUTH_MODE=automatic`과 기존 credential ID가 추가로 필요합니다. 스모크는 계획 승인, 실행, 미리보기 승인, 최종 렌더 이벤트까지 실제 API를 통과합니다.

## 생성물 고지와 라이선스

최종 영상의 내레이션은 AI로 합성된 음성입니다. 배포 대상과 조직 정책에 맞게 “AI 합성 음성 사용” 사실을 영상 설명 또는 함께 제공하는 문서에 명확히 고지하고, 실제 사람이 말한 것으로 오인시키는 사용을 피하세요. 사용자에게 대상 사이트를 조작·녹화할 권한이 있는지 확인해야 합니다.

Supertonic 프로젝트의 샘플 코드는 MIT License이며, 함께 제공되는 모델은 **OpenRAIL-M License**입니다. 배포·상업적 이용 전에 모델 저장소의 전체 라이선스와 사용 제한을 직접 검토해야 합니다.

- [Supertonic 공식 저장소와 라이선스](https://github.com/supertone-inc/supertonic)
- [Supertonic Python SDK 공식 안내](https://github.com/supertone-inc/supertonic-py)

OpenCode, Playwright MCP, HyperFrames, FFmpeg에도 각각의 라이선스가 적용됩니다. 완성 영상의 콘텐츠 권리와 대상 서비스 약관 준수 책임은 사용자에게 있습니다.
