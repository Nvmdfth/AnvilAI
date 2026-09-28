import os
import re
import time
import uuid

from fastapi import FastAPI
from pydantic import BaseModel

from client import LlamaClient
from hammer import hammer_code
from logging_utils import pass_logger

TEST_FENCE = re.compile(r"```test\n(.*?)```", re.DOTALL)

LLAMA_BASE_URL = os.environ.get("LLAMA_BASE_URL", "http://localhost:8080")
DEFAULT_PASSES = int(os.environ.get("HAMMER_PASSES", "5"))
LOG_DIR = os.environ.get("HAMMER_LOG_DIR", "logs")

app = FastAPI(title="AnvilAI", description="OpenAI-compatible hammer_code wrapper")
client = LlamaClient(base_url=LLAMA_BASE_URL)


class ChatMessage(BaseModel):
    role: str
    content: str


class ChatCompletionRequest(BaseModel):
    model: str = "hammer"
    messages: list[ChatMessage]
    passes: int | None = None


def split_task_and_tests(content: str) -> tuple[str, str | None]:
    match = TEST_FENCE.search(content)
    if not match:
        return content, None
    test_code = match.group(1)
    task = (content[: match.start()] + content[match.end() :]).strip()
    return task, test_code


@app.get("/health")
def health():
    return {"ok": client.health()}


@app.post("/v1/chat/completions")
def chat_completions(req: ChatCompletionRequest):
    last_user = next(m for m in reversed(req.messages) if m.role == "user")
    task, test_code = split_task_and_tests(last_user.content)

    request_id = f"chatcmpl-{uuid.uuid4().hex[:24]}"

    if test_code is None:
        # No tests supplied: plain passthrough, single pass, no hammer loop.
        messages = [m.model_dump() for m in req.messages]
        content = client.chat(messages)
        passed, passes_used = None, 1
    else:
        on_pass = pass_logger(request_id, log_dir=LOG_DIR)
        result = hammer_code(
            task,
            test_code,
            passes=req.passes or DEFAULT_PASSES,
            client=client,
            on_pass=on_pass,
        )
        content = result.code
        passed, passes_used = result.passed, result.passes_used

    return {
        "id": request_id,
        "object": "chat.completion",
        "created": int(time.time()),
        "model": req.model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": content},
                "finish_reason": "stop",
            }
        ],
        "hammer": {"passed": passed, "passes_used": passes_used},
    }
