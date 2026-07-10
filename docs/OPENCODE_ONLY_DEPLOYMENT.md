# OpenCode Only 사내 배포 메모

사내 PC에서 Codex CLI를 사용할 수 없고 OpenCode만 허용되는 경우의 운영 기준입니다.

## 결론

- Manual Video Agent 런타임은 Codex CLI를 필요로 하지 않습니다.
- 후처리 agent pass는 `opencode run`만 사용합니다.
- `playwright-mcp`는 Codex MCP 등록이 아니라 백엔드가 `.env`의 명령을 직접 stdio로 실행합니다.
- HyperFrames skills 설치/확인은 Codex 전용 플래그를 쓰지 않는 일반 명령으로 둡니다.

## 필수 설정

```env
MANUAL_AGENT_ENABLE_OPENCODE=true
MANUAL_AGENT_OPENCODE_COMMAND=opencode run --format json
MANUAL_AGENT_OPENCODE_AGENT=

MANUAL_AGENT_PLAYWRIGHT_MCP_MODE=manifest
MANUAL_AGENT_PLAYWRIGHT_MCP_COMMAND=npx @playwright/mcp@latest --headless

MANUAL_AGENT_ENABLE_HYPERFRAMES_SKILLS=false
MANUAL_AGENT_HYPERFRAMES_SKILLS_COMMAND=npx skills add heygen-com/hyperframes
```

OpenCode 실행에는 `--model`을 전달하지 않습니다. 회사 PC의 OpenCode 설정에 지정된 기본 모델을 그대로 사용하며, 기존 `MANUAL_AGENT_OPENCODE_MODEL` 값은 호환성을 위해 읽기만 하고 실행에서는 무시합니다.

## 내부 LLM과 OpenCode 역할 분리

내부 LLM은 다음 작업에 사용합니다.

- 입력값 추출
- action plan 생성
- 브라우저 관찰 기반 다음 행동 결정
- 로그인 화면 selector 추론

OpenCode는 생성된 패키지 디렉터리 안에서만 실행되는 선택 후처리입니다.

- `hyperframes/index.html`
- `hyperframes/hyperframes_manifest.json`
- `opencode_notes.md`

OpenCode가 action plan, 캡처 영상, audit log, manifest를 직접 바꾸면 안 됩니다. 이 제한은 `opencode_prompt.md`에 명시되어 있고, 실패해도 패키지 생성은 `degraded`로 계속됩니다.

## Chromex/Extension Bridge와의 관계

Chromex 같은 Chrome extension 계열 자동화는 `internal_llm`을 대체하는 것이 아니라 브라우저 관찰/실행 계층으로 붙이는 것이 안전합니다.

```text
Manual Video Agent
  -> internal_llm 또는 Ollama-compatible planner
  -> Extension Bridge observe/act/verify
  -> Package Builder
  -> OpenCode optional package pass
```

즉 사내 운영 표준은 `Codex 없음`, `OpenCode 후처리`, `내부 LLM 판단`, `Playwright/CDP/Extension Bridge 실행`입니다.

## 금지할 항목

- `codex mcp add ...`
- `~/.codex/config.toml` 배포 전제
- `--codex` 전용 skills 명령
- Codex 전용 skill 디렉터리를 사내 런타임 필수 구성요소로 취급

개발 PC에서 Codex를 사용해 구현하거나 테스트할 수는 있지만, 사내 배포 문서와 `.env.example`은 OpenCode only 기준을 따라야 합니다.
