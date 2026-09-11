"""Keep the vendor adapter out of the lightweight package import path."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


def test_adapters_package_does_not_eagerly_import_gpt_researcher() -> None:
    package_root = Path(__file__).resolve().parents[1]
    result = subprocess.run(
        [
            sys.executable,
            "-c",
            (
                "import sys; import ai_engine.adapters; "
                "print('ai_engine.adapters.gpt_researcher' in sys.modules)"
            ),
        ],
        cwd=package_root,
        env={**os.environ, "PYTHONPATH": str(package_root)},
        capture_output=True,
        check=True,
        text=True,
    )

    assert result.stdout.strip() == "False"
