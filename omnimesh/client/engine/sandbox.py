import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path


@dataclass
class ExecResult:
    passed: bool
    output: str


def run_tests(code: str, test_code: str, timeout: float = 10.0) -> ExecResult:
    """Run `code` followed by `test_code` as a single script.

    Exit code 0 counts as passing. Anything else (assertion failure,
    exception, timeout) counts as failing, with stderr/timeout message
    as the output to feed back to the model.
    """
    with tempfile.TemporaryDirectory() as tmp:
        script = Path(tmp) / "attempt.py"
        script.write_text(code + "\n\n" + test_code)

        try:
            proc = subprocess.run(
                ["python3", str(script)],
                capture_output=True,
                text=True,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired:
            return ExecResult(passed=False, output=f"timed out after {timeout}s")

        if proc.returncode == 0:
            return ExecResult(passed=True, output=proc.stdout)
        return ExecResult(passed=False, output=proc.stderr or proc.stdout)
