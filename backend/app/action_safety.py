from __future__ import annotations

from typing import Any


_DISALLOWED_CLICK_PHRASES = {
    "web search",
    "search web",
    "search the web",
    "web browsing",
    "browse web",
    "browse the web",
    "internet search",
    "online search",
    "웹 검색",
    "웹검색",
    "인터넷 검색",
    "온라인 검색",
}

_TOGGLE_WORDS = {"toggle", "토글", "mode", "모드"}
_WEB_SEARCH_WORDS = {"web", "browser", "browse", "internet", "search", "웹", "브라우징", "인터넷", "검색"}


def is_disallowed_click_texts(texts: list[str]) -> bool:
    lowered = " ".join(text.strip().lower() for text in texts if text.strip())
    compact = lowered.replace(" ", "")
    if any(phrase in lowered or phrase.replace(" ", "") in compact for phrase in _DISALLOWED_CLICK_PHRASES):
        return True
    return any(word in lowered for word in _TOGGLE_WORDS) and any(word in lowered for word in _WEB_SEARCH_WORDS)


def click_text_candidates(action: dict[str, Any]) -> list[str]:
    raw = action.get("texts", action.get("text", action.get("label", "")))
    if isinstance(raw, list):
        return [str(item).strip() for item in raw if str(item).strip()]
    value = str(raw).strip()
    return [value] if value else []
