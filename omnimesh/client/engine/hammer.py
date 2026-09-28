import re
from dataclasses import dataclass
from typing import Callable

from client import LlamaClient
from sandbox import run_tests

CODE_FENCE = re.compile(r"```(?:python)?\n(.*?)```", re.DOTALL)
RESPOND = "Respond with a single ```python code block, no explanation."

BASE_TEMPERATURE = 0.2
TEMPERATURE_STEP = 0.4
MAX_TEMPERATURE = 1.2


@dataclass
class CodeResult:
    code: str
    passed: bool
    passes_used: int


def extract_code(response: str) -> str:
    match = CODE_FENCE.search(response)
    return match.group(1) if match else response


def extract_failing_assertion(test_output: str) -> str | None:
    for line in test_output.splitlines():
        stripped = line.strip()
        if stripped.startswith("assert "):
            return stripped
    return None


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
    (pass number, temperature, repeat flag, prompt, response, code,
    test output, passed) so callers can persist iteration data for tuning.
    """
    client = client or LlamaClient()
    base = (
        f"{task}\n\nYour code must pass these tests:\n```python\n{test_code}\n```\n"
        "Before writing code, check how it behaves on edge cases such as empty "
        "input, a single element, and boundary values."
    )
    prompt = f"{base}\n\n{RESPOND}"
    temperature = BASE_TEMPERATURE
    seen: set[str] = set()

    code = ""
    for i in range(1, passes + 1):
        # Each pass is a single fresh message: small models copy a failed
        # answer verbatim when it sits in the history as an assistant turn.
        response = client.chat([{"role": "user", "content": prompt}], temperature=temperature)
        code = extract_code(response)

        result = run_tests(code, test_code)

        if verbose:
            print(f"--- pass {i} ---")
            print(code)
            print(f"[{'PASS' if result.passed else 'FAIL'}] {result.output.strip()}")

        if on_pass:
            on_pass(
                {
                    "pass": i,
                    "temperature": temperature,
                    "repeat": code in seen,
                    "prompt": prompt,
                    "response": response,
                    "code": code,
                    "test_output": result.output,
                    "passed": result.passed,
                }
            )

        if result.passed:
            return CodeResult(code=code, passed=True, passes_used=i)

        stuck = code in seen
        if stuck:
            temperature = min(temperature + TEMPERATURE_STEP, MAX_TEMPERATURE)
        seen.add(code)

        prompt = (
            f"{base}\n\nThis attempt is wrong:\n```python\n{code}\n```\n"
            f"It failed with:\n{result.output}\n"
        )
        assertion = extract_failing_assertion(result.output)
        if stuck and assertion:
            prompt += (
                f"You have already tried this exact code and it still fails on "
                f"`{assertion}`. Trace through that specific input by hand, step "
                f"by step, before writing new code. Do not repeat the same "
                f"approach.\n"
            )
        prompt += f"Write a corrected version that handles this case. {RESPOND}"

    return CodeResult(code=code, passed=False, passes_used=passes)


if __name__ == "__main__":
    task = "Write a Python function `add(a, b)` that returns the sum of two numbers."
    test_code = "assert add(2, 3) == 5\nassert add(-1, 1) == 0\nprint('ok')"

    result = hammer_code(task, test_code)
    print(f"passed={result.passed} passes_used={result.passes_used}")
    print(result.code)
