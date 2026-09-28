import requests


class LlamaClient:
    """Thin wrapper around the llama.cpp server's OpenAI-compatible API."""

    def __init__(self, base_url: str = "http://localhost:8080", timeout: float = 300.0):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout

    def chat(self, messages: list[dict], **params) -> str:
        resp = requests.post(
            f"{self.base_url}/v1/chat/completions",
            json={"messages": messages, **params},
            timeout=self.timeout,
        )
        resp.raise_for_status()
        return resp.json()["choices"][0]["message"]["content"]

    def health(self) -> bool:
        try:
            resp = requests.get(f"{self.base_url}/health", timeout=5)
            return resp.ok
        except requests.RequestException:
            return False
