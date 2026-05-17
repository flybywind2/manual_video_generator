# Internal System Manual Video Agent Design

date: 2026-05-17
status: approved-design
scope: MVP design

## Goal

사용자가 사내 시스템 사용 시나리오를 입력하면 로컬 PC에서 브라우저 리허설, 본 실행 캡처, 민감정보 마스킹, 내레이션 생성, 영상/문서 산출물 생성을 자동화하는 에이전트를 만든다.

MVP의 첫 데모 성공 기준은 운영계가 아니라 샘플 사내 웹앱에서 end-to-end 산출물을 생성하는 것이다.

## Inputs

사용자는 한 번에 하나의 시스템/URL에 대해 다음 정보를 입력한다.

- 요청문
- 대상 URL
- 계정 역할
- 완료 조건
- 운영계 실행에 필요한 입력값

시스템 카탈로그나 대상 시스템 목록은 MVP에서 관리하지 않는다. 생성된 영상의 배포, 보관, 승인 관리는 별도 관리자 시스템이 담당한다.

## Architecture

MVP는 개인 PC에서 실행되는 로컬 FastAPI 웹앱이다. 사용자는 localhost 마법사 UI에서 입력과 검수를 수행하고, 백엔드는 LLM/RAG, playwright-mcp, 직접 Playwright Runner, 마스킹, TTS, HyperFrames 렌더링을 오케스트레이션한다.

역할 분리는 다음과 같다.

- FastAPI: 로컬 앱, 작업 상태, 산출물 패키지 관리
- Web UI: 단계형 마법사와 검수 화면
- Internal LLM/RAG: 시나리오, 액션 JSON, 자막/콜아웃, 위험 액션 초안 생성
- playwright-mcp: 리허설과 화면 탐색
- Direct Playwright Runner: 승인된 JSON 계획의 본 실행과 단계별 캡처
- Masking Engine: 기본 민감정보 자동 블러
- TTS Narration Engine: 한국어 내레이션 오디오 생성
- HyperFrames: HTML 미리보기, MP4, Markdown, PDF 렌더링

## Wizard Flow

마법사 UI는 다음 순서로 진행한다.

1. 요청 입력
2. 계획 검수
3. MCP 리허설
4. 단계, 자막, 콜아웃, 내레이션 문구 검수
5. HTML 미리보기
6. MP4, Markdown, PDF 렌더링
7. 작업 패키지 확인 및 삭제

UI는 `D:\Python\appendix\AI Center DESIGN.md`의 AI Center 스타일을 따르되, 운영 도구답게 조용한 정보 구조와 단계형 흐름을 우선한다.

## Action Plan

확정 실행 계획은 구조화된 JSON으로 저장한다. MVP 액션 타입은 다음으로 시작한다.

- navigate
- click
- fill
- select
- wait_for
- assert_visible
- capture_step
- danger_approval

JSON 계획은 사람이 검수할 수 있는 단계 설명, 실행 selector 후보, 입력값 참조, 위험 액션 여부, 자막/콜아웃/내레이션 문구를 함께 가진다.

## Data Flow

1. 사용자가 요청문, URL, 역할, 완료 조건, 입력값을 입력한다.
2. Scenario Planner가 사내 LLM/RAG를 호출해 단계 목록, 필요한 입력값 체크, 자막/콜아웃 초안, 내레이션 초안, 위험 액션 후보, 구조화 액션 JSON 초안을 생성한다.
3. 사용자가 단계, 입력값, 자막/콜아웃, 내레이션 문구, 위험 액션 표시를 검수한다.
4. playwright-mcp가 리허설과 화면 탐색을 수행한다.
5. 리허설 실패 시 1-2회 대체 경로를 시도하고 결과를 사용자에게 보여준다.
6. 리허설 통과 후 사용자가 확정하면 계획 JSON이 고정된다.
7. Direct Playwright Runner가 확정 JSON을 본 실행한다.
8. 위험 액션 직전에는 승인 정지를 건다.
9. 각 단계에서 스크린샷 또는 짧은 클립을 생성한다.
10. Masking Engine이 기본 자동 마스킹을 적용한다.
11. TTS Narration Engine이 확정된 내레이션 문구를 문장 단위 wav로 생성한다.
12. HyperFrames가 마스킹된 캡처, 자막/콜아웃, 내레이션 오디오를 HTML 타임라인으로 조립한다.
13. 사용자가 HTML 미리보기를 승인하면 MP4, Markdown, PDF를 생성한다.
14. 로컬 작업 패키지는 사용자가 직접 삭제할 때까지 보관한다.

## TTS Design

MVP는 자막/콜아웃만이 아니라 한국어 TTS 내레이션도 지원한다.

기본 엔진은 MeloTTS Korean으로 둔다. 이유는 한국어 지원이 명시되어 있고, 경량 로컬 실행에 적합하며, 6GB VRAM 환경에서도 문장 단위 생성으로 현실적인 운영이 가능하기 때문이다.

확장 후보는 다음과 같다.

- XTTS-v2: 한국어와 voice cloning을 지원한다. 사내 지정 음성 또는 샘플 음성 기반 내레이션이 필요할 때 옵션으로 둔다. 라이선스와 사내 사용 정책 확인이 필요하다.
- GPT-SoVITS: 특정 내레이터 음색 재현이 중요할 때 후보로 둔다. MVP에는 운영 복잡도가 높다.
- Kokoro: 매우 경량이지만 공식 voice 목록에서 한국어 지원이 명확하지 않아 한국어 MVP 기본값으로 두지 않는다.

TTS 운영 규칙은 다음과 같다.

- 긴 문단을 한 번에 생성하지 않고 문장 또는 챕터 단위로 나눈다.
- 각 단계의 내레이션 wav를 생성한 뒤 HyperFrames 타임라인에 배치한다.
- MP4 렌더링 전 내레이션 미리듣기 단계를 제공한다.
- MES, LOT, SFC, 사내 약어, 숫자/단위는 발음 사전으로 보정한다.
- Playwright 캡처, 마스킹, HyperFrames 렌더와 GPU 경쟁이 생기지 않도록 TTS는 별도 큐에서 순차 실행한다.

## Safety

운영계 실제 계정을 전제로 안전장치를 둔다.

- 비밀번호, OTP, SSO 토큰은 앱이 직접 받지 않는다.
- 사용자가 브라우저에서 직접 로그인하고, 앱은 로그인 이후 세션만 사용한다.
- 본 실행 전에 반드시 playwright-mcp 리허설을 수행한다.
- 본 실행은 리허설 통과와 사용자 승인 없이는 시작하지 않는다.
- 저장, 등록, 제출, 삭제, 결재, 발송, 승인, 확정, 업로드는 위험 액션 후보로 표시한다.
- 위험 액션은 고정 키워드, LLM 분류, 사용자 최종 검수를 함께 사용한다.
- 본 실행 중 위험 액션 직전에는 승인 정지를 건다.
- 본 실행에서 selector 불일치, 예상 화면 미도달, 경고 팝업, 네트워크 실패, 권한 오류가 발생하면 즉시 멈춘다.
- 본 실행 중 자동 복구는 하지 않고 현재 화면, 실패 액션, 실패 원인, 가능한 다음 후보를 보여준다.

## Masking

MVP는 기본 자동 마스킹만 지원한다.

마스킹 대상은 다음과 같다.

- 이름
- 사번
- 이메일
- 전화번호
- 금액
- 주민/계좌류 패턴
- 사용자가 제공한 입력값
- 민감해 보이는 입력 필드 값

마스킹 전/후 경로와 탐지 근거를 로그로 남긴다. 작업 패키지에는 민감 자료 포함 가능성을 표시하고, 작업 단위 삭제 기능을 제공한다.

## Outputs

작업 패키지는 다음을 포함한다.

- 최종 MP4
- HTML 미리보기
- Markdown 매뉴얼
- PDF 매뉴얼
- 시나리오 입력
- 확정 액션 JSON
- 승인 로그
- 마스킹 로그
- TTS 내레이션 오디오
- HyperFrames HTML/에셋

Markdown/PDF는 영상에서 자동 파생되는 보조 산출물이다. 별도 문서 편집기는 MVP에 포함하지 않는다.

## Demo Criteria

첫 데모는 샘플 사내 웹앱에서 다음을 통과해야 한다.

1. 요청문, 샘플 URL, 역할, 완료 조건, 입력값 입력
2. 단계 목록, 자막/콜아웃, 내레이션, 위험 액션, 액션 JSON 초안 생성
3. playwright-mcp 리허설 통과
4. 단계, 자막/콜아웃, 내레이션, 위험 액션 사용자 승인
5. Direct Playwright Runner 본 실행
6. 단계별 캡처 생성
7. 기본 자동 마스킹 적용
8. 내레이션 wav 생성
9. HyperFrames HTML 미리보기 생성
10. MP4, Markdown, PDF 생성
11. 작업 패키지 저장
12. 작업 단위 삭제 동작

## Test Scope

MVP 자동 테스트는 다음을 포함한다.

- Action JSON schema validation
- 위험 액션 분류
- 입력값 누락 검출
- 기본 마스킹 패턴
- 내레이션 문장 분할과 발음 사전 적용
- 샘플 앱 E2E
- HyperFrames HTML 생성
- MP4, Markdown, PDF 산출물 존재 확인
- 작업 패키지 삭제

## References

- `D:\Python\appendix\appendix.md`
- `D:\Python\appendix\AI Center DESIGN.md`
- https://github.com/microsoft/playwright-mcp
- https://github.com/heygen-com/hyperframes
- https://github.com/myshell-ai/MeloTTS
- https://coqui-tts.readthedocs.io/en/latest/models/xtts.html
- https://github.com/RVC-Boss/GPT-SoVITS
- https://huggingface.co/hexgrad/Kokoro-82M
