#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import sys
from collections import defaultdict
from pathlib import Path
from urllib import request


ROOT = Path(__file__).resolve().parent
PUBLIC_DATA_DIR = ROOT / "public" / "data"
DEFAULT_SUBSCRIBERS_PATH = ROOT / "subscribers.json"


def load_json(path: Path) -> object:
    if not path.exists():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def normalize_rows(payload: object) -> list[dict[str, object]]:
    if not isinstance(payload, dict):
        return []
    rows = payload.get("rows", [])
    if not isinstance(rows, list):
        return []
    return [row for row in rows if isinstance(row, dict)]


def row_key(row: dict[str, object]) -> tuple[str, str, str, str, int]:
    return (
        str(row.get("state", "")),
        str(row.get("city", "")),
        str(row.get("centre", "")),
        str(row.get("date", "")),
        int(row.get("capacity", 0)),
    )


def load_subscribers() -> list[dict[str, object]]:
    path_text = os.getenv("SUBSCRIBERS_FILE", "").strip()
    path = Path(path_text) if path_text else DEFAULT_SUBSCRIBERS_PATH
    data = load_json(path)
    if not isinstance(data, list):
        return []
    subscribers = []
    for item in data:
        if not isinstance(item, dict):
            continue
        email = str(item.get("email", "")).strip()
        if not email:
            continue
        subscribers.append(
            {
                "email": email,
                "states": [str(value) for value in item.get("states", []) if str(value).strip()],
                "cities": [str(value) for value in item.get("cities", []) if str(value).strip()],
            }
        )
    return subscribers


def matches_subscription(row: dict[str, object], subscriber: dict[str, object]) -> bool:
    states = subscriber.get("states", [])
    cities = subscriber.get("cities", [])

    if states and str(row.get("state")) not in states:
        return False
    if cities and str(row.get("city")) not in cities:
        return False
    return True


def build_email_html(email: str, generated_at: str, rows: list[dict[str, object]]) -> str:
    grouped: dict[tuple[str, str], list[dict[str, object]]] = defaultdict(list)
    for row in rows:
        grouped[(str(row["state"]), str(row["city"]))].append(row)

    parts = [
        "<h2>SPOM Seat Update</h2>",
        f"<p>New availability was detected in the latest scan at <strong>{generated_at}</strong>.</p>",
        "<ul>",
    ]

    for (state, city), items in sorted(grouped.items()):
        parts.append(f"<li><strong>{state} / {city}</strong><ul>")
        for item in items[:10]:
            parts.append(
                "<li>"
                f"{item['centre']} - {item['date']} - capacity {item['capacity']}"
                "</li>"
            )
        if len(items) > 10:
            parts.append(f"<li>...and {len(items) - 10} more entries</li>")
        parts.append("</ul></li>")

    parts.extend(
        [
            "</ul>",
            "<p>Open the site to view the full latest list.</p>",
            f"<p>Sent to {email}</p>",
        ]
    )
    return "".join(parts)


def send_resend_email(to_email: str, subject: str, html: str) -> None:
    api_key = os.getenv("RESEND_API_KEY", "").strip()
    from_email = os.getenv("RESEND_FROM_EMAIL", "").strip()
    if not api_key or not from_email:
        raise RuntimeError("RESEND_API_KEY and RESEND_FROM_EMAIL are required to send alerts.")

    payload = json.dumps(
        {
            "from": from_email,
            "to": [to_email],
            "subject": subject,
            "html": html,
        }
    ).encode("utf-8")

    req = request.Request(
        "https://api.resend.com/emails",
        data=payload,
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
    )
    with request.urlopen(req, timeout=30) as response:
        response.read()


def main() -> int:
    current_payload = load_json(PUBLIC_DATA_DIR / "latest.json")
    previous_payload = load_json(PUBLIC_DATA_DIR / "previous-latest.json")

    current_rows = normalize_rows(current_payload)
    previous_keys = {row_key(row) for row in normalize_rows(previous_payload)}
    new_rows = [row for row in current_rows if row_key(row) not in previous_keys]

    if not new_rows:
        print("No new availability rows detected.")
        return 0

    generated_at = str(current_payload.get("generatedAt", "latest scan"))
    subscribers = load_subscribers()
    if not subscribers:
        print("No subscribers found. Skipping alerts.")
        return 0

    sent = 0
    for subscriber in subscribers:
        matching_rows = [row for row in new_rows if matches_subscription(row, subscriber)]
        if not matching_rows:
            continue
        subject = f"SPOM update: {len(matching_rows)} new seat entries"
        html = build_email_html(subscriber["email"], generated_at, matching_rows)
        send_resend_email(str(subscriber["email"]), subject, html)
        sent += 1
        print(f"Sent alert to {subscriber['email']}")

    print(f"Alert run complete. New rows: {len(new_rows)}. Emails sent: {sent}.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
