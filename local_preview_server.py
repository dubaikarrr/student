#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
from collections import Counter
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
REPORTS_DIR = ROOT / "reports"


def load_rows() -> list[dict[str, object]]:
    json_path = REPORTS_DIR / "spom_available_seats.json"
    if not json_path.exists():
        return []
    return json.loads(json_path.read_text(encoding="utf-8"))


def load_generated_at() -> str | None:
    latest_path = REPORTS_DIR / "spom_latest_run.txt"
    if not latest_path.exists():
        return None
    value = latest_path.read_text(encoding="utf-8").strip()
    return value or None


class Handler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        parsed = urlparse(self.path)

        if parsed.path == "/" or parsed.path == "/index.html":
            return self.serve_file(PUBLIC_DIR / "index.html", "text/html; charset=utf-8")

        if parsed.path == "/data/latest.json":
            return self.serve_file(PUBLIC_DIR / "data" / "latest.json", "application/json; charset=utf-8")

        if parsed.path == "/data/summary.json":
            return self.serve_file(PUBLIC_DIR / "data" / "summary.json", "application/json; charset=utf-8")

        if parsed.path == "/api/health":
            return self.send_json({"ok": True, "service": "spom-seat-checker-local"})

        if parsed.path == "/api/latest":
            return self.handle_latest(parsed.query)

        if parsed.path == "/api/summary":
            return self.handle_summary()

        self.send_error(HTTPStatus.NOT_FOUND, "Not found")

    def handle_latest(self, query: str) -> None:
        params = parse_qs(query)
        state = (params.get("state") or [""])[0].strip()
        city = (params.get("city") or [""])[0].strip()
        rows = load_rows()

        if state:
            rows = [row for row in rows if row.get("state") == state]
        if city:
            rows = [row for row in rows if row.get("city") == city]

        self.send_json(
            {
                "generatedAt": load_generated_at(),
                "total": len(rows),
                "rows": rows,
                "filters": {"state": state, "city": city},
            }
        )

    def handle_summary(self) -> None:
        rows = load_rows()
        states = Counter(row["state"] for row in rows)
        cities = Counter((row["state"], row["city"]) for row in rows)

        state_rows = [
            {"state": state, "available_count": count}
            for state, count in sorted(states.items())
        ]
        city_rows = [
            {"state": state, "city": city, "available_count": count}
            for (state, city), count in sorted(cities.items())
        ]

        self.send_json(
            {
                "generatedAt": load_generated_at(),
                "states": state_rows,
                "cities": city_rows,
            }
        )

    def serve_file(self, path: Path, content_type: str) -> None:
        if not path.exists():
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return

        payload = path.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_json(self, data: object) -> None:
        payload = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(payload)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, format: str, *args) -> None:
        return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a local preview server for the SPOM dashboard.")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"SPOM preview server running on http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
