#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import json
import re
import time
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from html import unescape
from http.cookiejar import CookieJar
from pathlib import Path
from typing import Iterable
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, Request, build_opener


BASE_URL = "https://spmt.icai.org/ICAI"
SLOT_PAGE_URL = f"{BASE_URL}/LoginAction_showSlotDetails.action"
INDIA_COUNTRY_PK = "1"
DEFAULT_TIMEOUT = 90
DEFAULT_RETRIES = 3
ROOT = Path(__file__).resolve().parent
CITY_COORDINATES_PATH = ROOT / "city_coordinates.json"
DEFAULT_USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/122.0.0.0 Safari/537.36"
)


@dataclass
class Option:
    key: str
    label: str


@dataclass
class AvailabilityRow:
    state: str
    city: str
    centre: str
    date: str
    capacity: int


@dataclass
class ScanCatalog:
    states: list[str]
    cities_by_state: dict[str, list[str]]


def load_focus_cities(path: Path) -> set[tuple[str, str]]:
    data = load_existing_json(path, [])
    if not isinstance(data, list):
        return set()

    focus: set[tuple[str, str]] = set()
    for item in data:
        if not isinstance(item, dict):
            continue
        state = str(item.get("state", "")).strip()
        city = str(item.get("city", "")).strip()
        if state and city:
            focus.add((state, city))
    return focus


def load_existing_json(path: Path, fallback: object) -> object:
    if not path.exists():
        return fallback
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return fallback


def load_city_coordinates() -> dict[str, dict[str, float]]:
    data = load_existing_json(CITY_COORDINATES_PATH, {})
    if not isinstance(data, dict):
        return {}
    result: dict[str, dict[str, float]] = {}
    for key, value in data.items():
        if not isinstance(key, str) or not isinstance(value, dict):
            continue
        lat = value.get("lat")
        lon = value.get("lon")
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            result[key] = {"lat": float(lat), "lon": float(lon)}
    return result


def row_to_payload(row: AvailabilityRow) -> dict[str, object]:
    return {
        "state": row.state,
        "city": row.city,
        "centre": row.centre,
        "date": row.date,
        "capacity": row.capacity,
    }


class SpomClient:
    def __init__(self, timeout: int = DEFAULT_TIMEOUT, retries: int = DEFAULT_RETRIES) -> None:
        self.timeout = timeout
        self.retries = retries
        self.cookie_jar = CookieJar()
        self.opener = build_opener(HTTPCookieProcessor(self.cookie_jar))
        self.base_headers = {
            "User-Agent": DEFAULT_USER_AGENT,
            "Accept": "*/*",
        }

    def bootstrap(self) -> str:
        return self._request_text(SLOT_PAGE_URL)

    def fetch_states(self) -> list[Option]:
        html = self.bootstrap()
        return self._extract_select_options(html, "cmbStateList")

    def fetch_cities(self, state_pk: str) -> list[Option]:
        payload = self._request_text(
            f"{BASE_URL}/LoginAction_getCityForTestCenters.action?{urlencode({'statePk': state_pk})}",
            ajax=True,
        )
        return self._parse_delimited_options(payload)

    def fetch_centres(self, city_pk: str) -> list[Option]:
        payload = self._request_text(
            f"{BASE_URL}/LoginAction_getTestCentreForCity.action?{urlencode({'selectedCity': city_pk})}",
            ajax=True,
        )
        return self._parse_delimited_options(payload)

    def fetch_centre_availability(self, centre_pk: str) -> list[tuple[str, int]]:
        payload = self._request_text(
            f"{BASE_URL}/LoginAction_getTestCenterAddress.action?{urlencode({'cmbTstCenter': centre_pk})}",
            ajax=True,
        ).strip()
        if not payload:
            return []

        pieces = payload.split("##")
        if len(pieces) < 2:
            return []

        date_blob = pieces[1]
        if "NoDatesAvlMsg" in date_blob:
            return []

        available: list[tuple[str, int]] = []
        for raw_item in date_blob.split(","):
            item = raw_item.strip()
            if not item or "&&" not in item:
                continue
            date_label, capacity_text = item.split("&&", 1)
            try:
                capacity = int(capacity_text)
            except ValueError:
                continue
            if capacity > 0:
                available.append((date_label.strip(), capacity))
        return available

    def _request_text(self, url: str, ajax: bool = False) -> str:
        headers = dict(self.base_headers)
        if ajax:
            headers.update(
                {
                    "X-Requested-With": "XMLHttpRequest",
                    "Referer": SLOT_PAGE_URL,
                    "Origin": "https://spmt.icai.org",
                }
            )

        last_error: Exception | None = None
        for attempt in range(1, self.retries + 1):
            request = Request(url, headers=headers)
            try:
                with self.opener.open(request, timeout=self.timeout) as response:
                    return response.read().decode("utf-8", errors="replace")
            except Exception as exc:
                last_error = exc
                if attempt == self.retries:
                    break
                # Back off slightly because the ICAI endpoint can be slow on shared CI runners.
                time.sleep(attempt * 2)
        assert last_error is not None
        raise last_error

    @staticmethod
    def _parse_delimited_options(payload: str) -> list[Option]:
        options: list[Option] = []
        text = payload.strip()
        if not text:
            return options

        for item in text.split("##"):
            if "$$" not in item:
                continue
            key, label = item.split("$$", 1)
            key = key.strip()
            label = label.strip()
            if key and label and key != "-1":
                options.append(Option(key=key, label=label))
        return options

    @staticmethod
    def _extract_select_options(html: str, select_id: str) -> list[Option]:
        select_match = re.search(
            rf'<select[^>]*id="{re.escape(select_id)}"[^>]*>(.*?)</select>',
            html,
            flags=re.IGNORECASE | re.DOTALL,
        )
        if not select_match:
            return []

        select_html = select_match.group(1)
        options: list[Option] = []
        for value, label in re.findall(
            r'<option\s+value="([^"]*)"(?:[^>]*)>(.*?)</option>',
            select_html,
            flags=re.IGNORECASE | re.DOTALL,
        ):
            clean_value = unescape(value).strip()
            clean_label = re.sub(r"\s+", " ", unescape(label)).strip()
            if clean_value and clean_value != "-1" and clean_label:
                options.append(Option(key=clean_value, label=clean_label))
        return options


def build_rows(
    client: SpomClient,
    state_filter: str | None = None,
    focus_cities: set[tuple[str, str]] | None = None,
) -> tuple[list[AvailabilityRow], ScanCatalog]:
    rows: list[AvailabilityRow] = []
    catalog_states: list[str] = []
    catalog_cities: dict[str, list[str]] = {}
    states = client.fetch_states()
    if state_filter:
        state_filter_norm = state_filter.casefold()
        states = [state for state in states if state.label.casefold() == state_filter_norm]
    elif focus_cities:
        focus_states = {state for state, _ in focus_cities}
        states = [state for state in states if state.label in focus_states]

    for state in states:
        cities = client.fetch_cities(state.key)
        if focus_cities:
            cities = [city for city in cities if (state.label, city.label) in focus_cities]
        if not cities:
            continue

        catalog_states.append(state.label)
        catalog_cities[state.label] = [city.label for city in cities]
        for city in cities:
            centres = client.fetch_centres(city.key)
            for centre in centres:
                availability = client.fetch_centre_availability(centre.key)
                for date_label, capacity in availability:
                    rows.append(
                        AvailabilityRow(
                            state=state.label,
                            city=city.label,
                            centre=centre.label,
                            date=date_label,
                            capacity=capacity,
                        )
                    )
    return rows, ScanCatalog(states=catalog_states, cities_by_state=catalog_cities)


def write_csv(rows: Iterable[AvailabilityRow], output_path: Path) -> None:
    with output_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        writer.writerow(["state", "city", "centre", "date", "capacity"])
        for row in rows:
            writer.writerow([row.state, row.city, row.centre, row.date, row.capacity])


def write_json(rows: Iterable[AvailabilityRow], output_path: Path) -> None:
    data = [
        {
            "state": row.state,
            "city": row.city,
            "centre": row.centre,
            "date": row.date,
            "capacity": row.capacity,
        }
        for row in rows
    ]
    output_path.write_text(json.dumps(data, indent=2), encoding="utf-8")


def write_markdown(rows: list[AvailabilityRow], output_path: Path, generated_at: str) -> None:
    grouped: dict[str, dict[str, list[AvailabilityRow]]] = defaultdict(lambda: defaultdict(list))
    for row in rows:
        grouped[row.state][row.city].append(row)

    lines = [
        "# SPOM Seat Availability Report",
        "",
        f"Generated at: {generated_at}",
        f"Available entries found: {len(rows)}",
        "",
    ]

    if not rows:
        lines.append("No available seats were found in the current scan.")
    else:
        for state in sorted(grouped):
            lines.append(f"## {state}")
            lines.append("")
            for city in sorted(grouped[state]):
                lines.append(f"### {city}")
                lines.append("")
                lines.append("| Centre | Date | Capacity |")
                lines.append("| --- | --- | ---: |")
                city_rows = sorted(grouped[state][city], key=lambda item: (item.centre, item.date))
                for row in city_rows:
                    lines.append(f"| {row.centre} | {row.date} | {row.capacity} |")
                lines.append("")

    output_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def write_public_data(
    rows: list[AvailabilityRow],
    catalog: ScanCatalog,
    output_dir: Path,
    generated_at: str,
    generated_at_iso: str,
    focus_cities: set[tuple[str, str]] | None = None,
) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)
    previous_latest = load_existing_json(output_dir / "latest.json", {"rows": []})
    previous_summary = load_existing_json(output_dir / "summary.json", {"states": [], "cities": []})
    city_coordinates = load_city_coordinates()
    previous_rows = previous_latest.get("rows", []) if isinstance(previous_latest, dict) else []
    previous_row_keys = {
        (
            str(item.get("state", "")),
            str(item.get("city", "")),
            str(item.get("centre", "")),
            str(item.get("date", "")),
            int(item.get("capacity", 0)),
        )
        for item in previous_rows
        if isinstance(item, dict)
    }

    current_rows_payload = [row_to_payload(row) for row in rows]
    if focus_cities:
        carried_rows = []
        for item in previous_rows:
            if not isinstance(item, dict):
                continue
            state = str(item.get("state", ""))
            city = str(item.get("city", ""))
            if (state, city) not in focus_cities:
                carried_rows.append(item)
        latest_rows_payload = carried_rows + current_rows_payload
    else:
        latest_rows_payload = current_rows_payload

    latest_payload = {
        "generatedAtIso": generated_at_iso,
        "generatedAt": generated_at,
        "generatedAtDisplay": generated_at,
        "total": len(latest_rows_payload),
        "rows": sorted(
            latest_rows_payload,
            key=lambda item: (
                str(item.get("state", "")),
                str(item.get("city", "")),
                str(item.get("centre", "")),
                str(item.get("date", "")),
            ),
        ),
    }

    state_counts: dict[str, int] = defaultdict(int)
    city_counts: dict[tuple[str, str], int] = defaultdict(int)
    for item in latest_payload["rows"]:
        state = str(item.get("state", ""))
        city = str(item.get("city", ""))
        state_counts[state] += 1
        city_counts[(state, city)] += 1

    previous_states = []
    previous_city_pairs: set[tuple[str, str]] = set()
    if isinstance(previous_summary, dict):
        for item in previous_summary.get("states", []):
            if isinstance(item, dict) and item.get("state"):
                previous_states.append(str(item["state"]))
        for item in previous_summary.get("cities", []):
            if isinstance(item, dict) and item.get("state") and item.get("city"):
                previous_city_pairs.add((str(item["state"]), str(item["city"])))

    merged_states = sorted(set(previous_states) | set(catalog.states))
    merged_city_pairs = sorted(
        previous_city_pairs
        | {(state, city) for state, cities in catalog.cities_by_state.items() for city in cities}
    )

    summary_payload = {
        "generatedAtIso": generated_at_iso,
        "generatedAt": generated_at,
        "generatedAtDisplay": generated_at,
        "states": [
            {"state": state, "available_count": state_counts.get(state, 0)}
            for state in merged_states
        ],
        "cities": [
            {
                "state": state,
                "city": city,
                "available_count": city_counts.get((state, city), 0),
                "lat": city_coordinates.get(f"{state}||{city}", {}).get("lat"),
                "lon": city_coordinates.get(f"{state}||{city}", {}).get("lon"),
            }
            for state, city in merged_city_pairs
        ],
    }

    new_rows = [
        row
        for row in current_rows_payload
        if (
            str(row.get("state", "")),
            str(row.get("city", "")),
            str(row.get("centre", "")),
            str(row.get("date", "")),
            int(row.get("capacity", 0)),
        )
        not in previous_row_keys
    ]
    new_city_set = sorted({(row["state"], row["city"]) for row in new_rows})
    changes_payload = {
        "generatedAtIso": generated_at_iso,
        "generatedAt": generated_at,
        "generatedAtDisplay": generated_at,
        "newEntries": len(new_rows),
        "newCities": [
            {"state": state, "city": city}
            for state, city in new_city_set
        ],
        "rows": new_rows,
    }

    existing_history = load_existing_json(output_dir / "history.json", {"items": []})
    history_items = existing_history.get("items", []) if isinstance(existing_history, dict) else []
    if not isinstance(history_items, list):
        history_items = []
    history_items.append(
        {
            "generatedAtIso": generated_at_iso,
            "generatedAtDisplay": generated_at,
            "total": len(rows),
        }
    )
    history_payload = {"items": history_items[-72:]}

    (output_dir / "latest.json").write_text(
        json.dumps(latest_payload, indent=2), encoding="utf-8"
    )
    (output_dir / "summary.json").write_text(
        json.dumps(summary_payload, indent=2), encoding="utf-8"
    )
    (output_dir / "changes.json").write_text(
        json.dumps(changes_payload, indent=2), encoding="utf-8"
    )
    (output_dir / "history.json").write_text(
        json.dumps(history_payload, indent=2), encoding="utf-8"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Scan ICAI SPOM centre availability and write a daily report."
    )
    parser.add_argument(
        "--output-dir",
        default="reports",
        help="Directory where report files will be written. Default: reports",
    )
    parser.add_argument(
        "--state",
        help="Optional exact state name filter, for example 'Maharashtra'.",
    )
    parser.add_argument(
        "--stdout",
        action="store_true",
        help="Also print a compact summary to stdout.",
    )
    parser.add_argument(
        "--public-data-dir",
        default="public/data",
        help="Directory for static JSON files consumed by the frontend. Default: public/data",
    )
    parser.add_argument(
        "--focus-cities-file",
        help="Optional JSON file with state/city pairs for a faster partial refresh.",
    )
    return parser.parse_args()


def print_summary(rows: list[AvailabilityRow]) -> None:
    if not rows:
        print("No available seats found.")
        return

    grouped: dict[tuple[str, str], int] = defaultdict(int)
    for row in rows:
        grouped[(row.state, row.city)] += 1

    print(f"Available entries found: {len(rows)}")
    for (state, city), count in sorted(grouped.items()):
        print(f"- {state} / {city}: {count}")


def main() -> int:
    args = parse_args()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    now = datetime.now(timezone.utc).astimezone()
    generated_at = now.strftime("%Y-%m-%d %H:%M:%S %Z")
    generated_at_iso = now.isoformat()

    client = SpomClient()
    focus_cities: set[tuple[str, str]] | None = None
    if args.focus_cities_file:
        focus_cities = load_focus_cities(Path(args.focus_cities_file).resolve())
    try:
        rows, catalog = build_rows(
            client=client,
            state_filter=args.state,
            focus_cities=focus_cities,
        )
    except Exception as exc:
        print(f"Scan failed: {exc}", file=sys.stderr)
        return 1

    csv_path = output_dir / "spom_available_seats.csv"
    json_path = output_dir / "spom_available_seats.json"
    md_path = output_dir / "spom_available_seats.md"
    public_data_dir = Path(args.public_data_dir).resolve()

    write_csv(rows, csv_path)
    write_json(rows, json_path)
    write_markdown(rows, md_path, generated_at)
    write_public_data(
        rows,
        catalog,
        public_data_dir,
        generated_at,
        generated_at_iso,
        focus_cities=focus_cities,
    )

    latest_path = output_dir / "spom_latest_run.txt"
    latest_path.write_text(generated_at + "\n", encoding="utf-8")

    if args.stdout:
        print_summary(rows)
        print(f"Markdown report: {md_path}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
