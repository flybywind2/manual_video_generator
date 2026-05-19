from __future__ import annotations

from typing import Any, Callable

from backend.app.adapters.planner import post_json


HttpPost = Callable[[str, dict[str, str], dict[str, Any], float], dict[str, Any]]


class ExtensionBridgeClient:
    """Thin local bridge for a browser extension or native host.

    The bridge intentionally mirrors the browser-agent turn contract:
    observe the active tab, act on a normalized action, then verify the result.
    """

    def __init__(
        self,
        *,
        endpoint: str,
        token: str = "",
        timeout_seconds: float = 30.0,
        http_post: HttpPost | None = None,
    ) -> None:
        self.endpoint = endpoint.rstrip("/")
        self.token = token
        self.timeout_seconds = timeout_seconds
        self.http_post = post_json if http_post is None else http_post

    def observe(self) -> dict[str, Any]:
        response = self._post("observe", {})
        return dict(response.get("observation") or response)

    def act(self, action: dict[str, Any]) -> dict[str, Any]:
        response = self._post("act", {"action": action})
        return dict(response.get("result") or response)

    def verify(self, action: dict[str, Any], result: dict[str, Any]) -> dict[str, Any]:
        response = self._post("verify", {"action": action, "result": result})
        return dict(response.get("verification") or response)

    def _post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        headers = {"Content-Type": "application/json", "Accept": "application/json"}
        if self.token:
            headers["Authorization"] = f"Bearer {self.token}"
        return self.http_post(f"{self.endpoint}/{path}", headers, payload, self.timeout_seconds)
