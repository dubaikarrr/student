#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
from urllib import parse, request


ROOT = Path(__file__).resolve().parent
PUBLIC_DATA_DIR = ROOT / "public" / "data"


def load_json(path: Path) -> object:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def main() -> int:
    token = os.getenv("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        print("Telegram secrets are not configured. Skipping Telegram alerts.")
        return 0

    changes = load_json(PUBLIC_DATA_DIR / "changes.json")
    if not isinstance(changes, dict):
      print("No Telegram alert payload found.")
      return 0

    new_cities = changes.get("newCities", [])
    if not isinstance(new_cities, list) or not new_cities:
        print("No new city changes detected. Skipping Telegram alerts.")
        return 0

    generated_at = str(changes.get("generatedAtDisplay", "latest scan"))
    lines = [
        "SPOM seat update",
        f"Latest scan: {generated_at}",
        f"New city changes: {len(new_cities)}",
        "",
    ]
    for item in new_cities[:12]:
        if isinstance(item, dict):
            lines.append(f"- {item.get('state', '')} / {item.get('city', '')}")
    if len(new_cities) > 12:
        lines.append(f"- and {len(new_cities) - 12} more")

    payload = parse.urlencode(
        {
            "chat_id": chat_id,
            "text": "\n".join(lines),
        }
    ).encode("utf-8")
    req = request.Request(
        f"https://api.telegram.org/bot{token}/sendMessage",
        data=payload,
        method="POST",
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with request.urlopen(req, timeout=30) as response:
        response.read()

    print("Telegram alert sent.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
