# Manual Video Agent

로컬 PC에서 사내 시스템 사용 시나리오를 샘플 브라우저 캡처, 마스킹, 내레이션, HTML/WebM/Markdown/PDF 패키지로 생성하는 MVP입니다.

## `.env` 설정

`D:\Python\appendix\appendix.md`의 내부 API 예시값은 `.env`로 관리합니다.

1. `.env.example`을 `.env`로 복사합니다.
2. `MANUAL_AGENT_*` 값들을 사내 발급값으로 채웁니다.
3. 앱을 재시작합니다.
4. 홈 화면의 `.env 설정 상태` 패널 또는 `/api/config/status`에서 구성 여부만 확인합니다.

비밀값은 UI/API 응답에 표시하지 않습니다. `.env`는 `.gitignore`에 포함되어 커밋되지 않습니다.

주요 값:

- `MANUAL_AGENT_OPENAI_API_KEY`
- `MANUAL_AGENT_DEP_TICKET`
- `MANUAL_AGENT_SEND_SYSTEM_NAME`
- `MANUAL_AGENT_USER_ID`
- `MANUAL_AGENT_USER_TYPE`
- `MANUAL_AGENT_LLM_BASE_URL`
- `MANUAL_AGENT_LLM_MODEL`
- `MANUAL_AGENT_VLM_BASE_URL`
- `MANUAL_AGENT_VLM_MODEL`
- `MANUAL_AGENT_RAG_RETRIEVE_URL`
- `MANUAL_AGENT_RAG_API_KEY`
- `MANUAL_AGENT_RAG_INDEX_NAME`
- `MANUAL_AGENT_RERANKER_URL`
- `MANUAL_AGENT_RERANKER_MODEL`

## 실행

```powershell
python -m uvicorn backend.app.main:app --host 127.0.0.1 --port 8000
```

열기:

```text
http://127.0.0.1:8000
```
