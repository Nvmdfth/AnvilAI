import json
import time
from pathlib import Path
from typing import Callable


def pass_logger(request_id: str, log_dir: str = "logs") -> Callable[[dict], None]:
    """Return a callback that appends one JSON line per hammer pass.

    Each record gets a timestamp and is written to
    `<log_dir>/<request_id>.jsonl` as it comes in, so a log is complete
    even if the request never finishes.
    """
    path = Path(log_dir)
    path.mkdir(parents=True, exist_ok=True)
    log_path = path / f"{request_id}.jsonl"

    def log(record: dict) -> None:
        entry = {"timestamp": time.time(), **record}
        with log_path.open("a") as f:
            f.write(json.dumps(entry) + "\n")

    return log
