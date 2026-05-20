# CDP Attach 사용 매뉴얼

CDP attach는 Manual Video Agent가 새 Playwright 브라우저를 실행하지 않고, 사용자가 remote debugging 옵션으로 열어 둔 Chrome 또는 Edge에 붙어서 화면을 조작/캡처하는 방식입니다. 별도 CDP 패키지는 설치하지 않으며, 기존 Playwright Python 패키지의 `connect_over_cdp` 기능을 사용합니다.

## 언제 사용하나

- 회사 AD 기반 SSO가 일반 업무 브라우저에서는 자동으로 되지만 Playwright가 띄운 새 브라우저에서는 다시 로그인을 요구할 때
- persistent profile(`MANUAL_AGENT_LOGIN_MODE=sso_profile`)로도 SSO 쿠키/토큰 재사용이 불안정할 때
- 보안 확장, 프록시, 인증 플러그인이 자동화 브라우저에서 다르게 동작할 때
- 사용자가 먼저 브라우저를 열어 SSO 상태를 만든 뒤 agent가 그 세션을 이어서 사용해야 할 때

## 사전 조건

- Chrome 또는 Microsoft Edge가 설치되어 있어야 합니다.
- Python Playwright 패키지는 기존 프로젝트 의존성을 그대로 사용합니다.
- 사내 보안정책이 `--remote-debugging-port` 실행을 허용해야 합니다.
- CDP endpoint는 로컬 PC에서만 접근하도록 `127.0.0.1`을 사용합니다.

## 브라우저 실행

Edge 권장 예시:

```powershell
msedge.exe --remote-debugging-port=9222 --user-data-dir=C:\AppBundle\manualgen\edge-cdp-profile
```

Chrome 예시:

```powershell
chrome.exe --remote-debugging-port=9222 --user-data-dir=C:\AppBundle\manualgen\chrome-cdp-profile
```

처음 실행하면 이 전용 프로필에서 사내 SSO가 완료되도록 한 번 로그인합니다. 이후 같은 `--user-data-dir`를 재사용하면 SSO 상태가 유지될 수 있습니다.

## .env 설정

```env
MANUAL_AGENT_BROWSER_RUNNER=cdp_attach
MANUAL_AGENT_CDP_ENDPOINT=http://127.0.0.1:9222
```

기존 Playwright launch 방식으로 되돌리려면 다음처럼 설정합니다.

```env
MANUAL_AGENT_BROWSER_RUNNER=playwright
```

## 실행 순서

1. 위 명령으로 Edge 또는 Chrome을 remote debugging 모드로 실행합니다.
2. 열린 브라우저에서 대상 사내 시스템에 접속해 SSO 상태가 정상인지 확인합니다.
3. Manual Video Agent를 실행합니다.
4. UI에서 대상 URL과 시나리오를 입력하고 파이프라인을 실행합니다.
5. `.env 설정 상태`에서 `browser_runner=cdp_attach`, `cdp_endpoint_set=true`인지 확인합니다.

## 직접 시연과 재촬영 동작

`MANUAL_AGENT_BROWSER_RUNNER=cdp_attach`인 경우 직접 시연과 시연 기반 replay는 모두 이미 열린 CDP 브라우저 컨텍스트에 붙어서 실행합니다. 즉, 사용자가 CDP 브라우저에서 AD SSO를 완료했다면 replay 단계가 새 Playwright 브라우저를 열어 로그인 상태를 잃지 않습니다.

`MANUAL_AGENT_LOGIN_MODE=sso_profile`을 함께 쓰는 경우에도 직접 시연 모드는 SSO profile 설정을 유지합니다. 수동 로그인용 `로그인 완료` 게이트는 직접 시연에서는 사용하지 않고, 시연 제어는 별도 `시연 완료` 신호만 사용합니다.

## 주의사항

- 일반 업무용 기본 브라우저 프로필을 그대로 붙이지 말고, 가능하면 전용 `--user-data-dir`를 사용하세요.
- CDP attach는 이미 열린 브라우저 상태에 의존하므로 재현성이 Playwright launch보다 낮습니다.
- CDP로 기존 컨텍스트에 붙는 경우 Playwright의 내장 WebM 녹화가 제한될 수 있습니다. 이때 패키지는 스크린샷/로그를 유지하고 영상은 `cdp_attach_existing_context_no_video_recording` degraded 상태로 표시될 수 있습니다.
- remote debugging port를 `0.0.0.0`이나 외부 IP에 열지 마세요.
- 회사 정책이 CDP 포트를 차단하면 `sso_profile` 또는 `manual` 로그인 모드를 사용해야 합니다.

## 문제 해결

CDP 연결 실패:

```powershell
curl http://127.0.0.1:9222/json/version
```

응답이 없으면 브라우저가 remote debugging 옵션으로 실행되지 않았거나 포트가 차단된 상태입니다.

SSO가 다시 뜨는 경우:

- 같은 `--user-data-dir`를 재사용하고 있는지 확인합니다.
- 대상 시스템 도메인이 사내 SSO 허용 정책에 포함되어 있는지 확인합니다.
- 사내 보안 확장이 전용 프로필에 설치/활성화되어야 하는지 확인합니다.

녹화 영상이 degraded인 경우:

- CDP attach의 기존 브라우저 컨텍스트에서는 내장 video recording이 제한될 수 있습니다.
- 최종 패키지의 `capture_action_log.json`, `final_frame.png`, `manual.md`, `subtitles.srt`를 함께 확인합니다.
