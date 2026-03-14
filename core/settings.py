from __future__ import annotations

import json
from pathlib import Path


APP_DIR = Path.home() / "AppData" / "Local" / "Memact"
SETTINGS_PATH = APP_DIR / "settings.json"


def load_settings() -> dict:
    if not SETTINGS_PATH.exists():
        return {}
    try:
        return json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_settings(settings: dict) -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_PATH.write_text(
        json.dumps(settings, indent=2, sort_keys=True),
        encoding="utf-8",
    )

