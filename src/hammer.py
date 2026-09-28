import re
from dataclasses import dataclass
from typing import Callable

from client import LlamaClient
from sandbox import run_tests

CODE_FENCE = re.compile(r"```(?:python)?\n(.*?)```", re.DOTALL)


@dataclass
class CodeResult:
    code: str
    passed: bool
    passes_used: int


def extract_code(response: str) -> str:
    match = CODE_FENCE.search(response)
    return match.group(1) if match else response


def hammer_code(
    task: str,
    test_code: str,
    passes: int = 5,
    client: LlamaClient | None = None,
    verbose: bool = False,
    on_pass: Callable[[dict], None] | None = None,
) -> CodeResult:
    """Generate code for `task`, verifying against `test_code` each pass.

    Stops as soon as the tests pass. If they never pass, returns the
    last attempt after `passes` rounds (CPU-budget ceiling).

    `on_pass`, if given, is called after every pass with a record
    (pass number, prompt messages, response, code, test output,
    passed) so callers can persist iteration data for tuning.
    """
    client = client or LlamaClient()
    messages = [
        {
            "role": "user",
            "content": f"{task}\n\nRespond with a single ```python code block, no explanation.",
        }
    ]

    code = ""
    for i in range(1, passes + 1):
        prompt = messages[-1]["content"]
        response = client.chat(messages)
        code = extract_code(response)
        messages.append({"role": "assistant", "content": response})

        result = run_tests(code, test_code)

        if verbose:
            print(f"--- pass {i} ---")
            print(code)
            print(f"[{'PASS' if result.passed else 'FAIL'}] {result.output.strip()}")

        if on_pass:
            on_pass(
                {
                    "pass": i,
                    "prompt": prompt,
                    "response": response,
                    "code": code,
                    "test_output": result.output,
                    "passed": result.passed,
                }
            )

        if result.passed:
            return CodeResult(code=code, passed=True, passes_used=i)

        messages.append(
            {
                "role": "user",
                "content": f"Your code failed:\n{result.output}\nFix it. Respond with a single ```python code block, no explanation.",
            }
        )

    return CodeResult(code=code, passed=False, passes_used=passes)


if __name__ == "__main__":
    task = "Write a Python function `add(a, b)` that returns the sum of two numbers."
    test_code = "assert add(2, 3) == 5\nassert add(-1, 1) == 0\nprint('ok')"

    result = hammer_code(task, test_code)
    print(f"passed={result.passed} passes_used={result.passes_used}")
    print(result.code)
