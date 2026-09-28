#!/usr/bin/env python3
"""Standalone test: build a single-file HTML page with a generate/verify/
retry loop, then write it to a directory. Talks directly to llama-server;
does not touch hammer.py, api.py, or any container.

Usage:
    python3 scripts/build_website.py "<task>" <checks_file> <output_dir> [--passes N]

<checks_file> is a .py file of assert statements checked against a string
variable named `html` (the generated page), e.g.:

    assert '<h1>' in html
    assert 'Contact' in html

Run standalone, blocks until done, exits. No Claude Code involvement
required after it's kicked off.
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

from client import LlamaClient  # noqa: E402
from logging_utils import pass_logger  # noqa: E402

HTML_FENCE = re.compile(r"```(?:html)?\n(.*?)```", re.DOTALL)
RESPOND = "Respond with a single ```html code block for the complete page, no explanation."

BASE_TEMPERATURE = 0.2
TEMPERATURE_STEP = 0.4
MAX_TEMPERATURE = 1.2

VALIDATOR = '''
from html.parser import HTMLParser

VOID = {"area","base","br","col","embed","hr","img","input","link","meta","param","source","track","wbr"}

class _Checker(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if not self.stack or self.stack[-1] != tag:
            self.errors.append(f"mismatched closing tag </{tag}>")
        else:
            self.stack.pop()

def _validate(html):
    checker = _Checker()
    checker.feed(html)
    errors = list(checker.errors)
    if checker.stack:
        errors.append(f"unclosed tags: {checker.stack}")
    if errors:
        raise AssertionError("HTML validity errors: " + "; ".join(errors))
'''


def extract_html(response: str) -> str:
    match = HTML_FENCE.search(response)
    return match.group(1) if match else response


def verify(html: str, checks: str, timeout: float = 10.0) -> tuple[bool, str]:
    script = f"{VALIDATOR}\nhtml = {html!r}\n_validate(html)\n{checks}\nprint('ok')\n"
    with tempfile.TemporaryDirectory() as tmp:
        path = Path(tmp) / "check.py"
        path.write_text(script)
        try:
            proc = subprocess.run(
                ["python3", str(path)], capture_output=True, text=True, timeout=timeout
            )
        except subprocess.TimeoutExpired:
            return False, f"timed out after {timeout}s"
        if proc.returncode == 0:
            return True, proc.stdout
        return False, proc.stderr or proc.stdout


def build(task, checks, output_dir, passes, client, log):
    base = (
        f"{task}\n\nThe page must satisfy these checks (run against the HTML "
        f"as a string called `html`):\n```python\n{checks}\n```\n"
    )
    prompt = f"{base}\n{RESPOND}"
    temperature = BASE_TEMPERATURE
    seen: set[str] = set()
    html = ""

    for i in range(1, passes + 1):
        response = client.chat([{"role": "user", "content": prompt}], temperature=temperature)
        html = extract_html(response)
        passed, output = verify(html, checks)

        stuck = html in seen
        log(
            {
                "pass": i,
                "temperature": temperature,
                "repeat": stuck,
                "prompt": prompt,
                "response": response,
                "html": html,
                "check_output": output,
                "passed": passed,
            }
        )

        if passed:
            output_dir.mkdir(parents=True, exist_ok=True)
            (output_dir / "index.html").write_text(html)
            return True, i

        if stuck:
            temperature = min(temperature + TEMPERATURE_STEP, MAX_TEMPERATURE)
        seen.add(html)

        prompt = f"{base}\nThis attempt is wrong:\n```html\n{html}\n```\nIt failed with:\n{output}\n"
        if stuck:
            prompt += (
                "You have already tried this exact page and it still fails. "
                "Trace through the checks by hand before writing new HTML. "
                "Do not repeat the same approach.\n"
            )
        prompt += RESPOND

    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "index.html").write_text(html)
    return False, passes


def main():
    parser = argparse.ArgumentParser(description="Build a single-file website with the hammer loop.")
    parser.add_argument("task", help="Description of the page to build")
    parser.add_argument("checks_file", help="Path to a .py file of assert statements checked against `html`")
    parser.add_argument("output_dir", help="Directory to write index.html into")
    parser.add_argument("--passes", type=int, default=int(os.environ.get("HAMMER_PASSES", "5")))
    parser.add_argument("--base-url", default=os.environ.get("LLAMA_BASE_URL", "http://localhost:8080"))
    args = parser.parse_args()

    checks = Path(args.checks_file).read_text()
    client = LlamaClient(base_url=args.base_url, timeout=900.0)
    if not client.health():
        print(f"llama-server not reachable at {args.base_url}", file=sys.stderr)
        sys.exit(1)

    request_id = f"website-{uuid.uuid4().hex[:12]}"
    log = pass_logger(request_id, log_dir=os.environ.get("HAMMER_LOG_DIR", "logs"))

    t0 = time.time()
    output_dir = Path(args.output_dir)
    passed, passes_used = build(args.task, checks, output_dir, args.passes, client, log)
    elapsed = time.time() - t0

    print(f"passed={passed} passes_used={passes_used} time={elapsed:.1f}s -> {output_dir}/index.html")
    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
