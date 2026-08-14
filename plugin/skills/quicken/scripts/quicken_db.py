#!/usr/bin/env python3
"""Locate and inspect a Quicken for Mac database without reading financial rows."""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import re
import sqlite3
import sys
from typing import Any


IDENTIFIER = re.compile(r"[A-Za-z0-9_]+\Z")


class ProbeError(Exception):
    """A user-actionable database discovery or validation error."""

    def __init__(self, message: str, *, candidates: list[Path] | None = None):
        super().__init__(message)
        self.candidates = candidates or []


def normalize_database_path(value: str | Path) -> Path:
    path = Path(value).expanduser()
    if path.suffix.lower() == ".quicken":
        path = path / "data"
    return path.resolve()


def discover_candidates() -> list[Path]:
    documents = Path.home() / "Documents"
    if not documents.is_dir():
        return []

    candidates: list[Path] = []
    for bundle in documents.glob("*.quicken"):
        data = bundle / "data"
        if data.is_file():
            candidates.append(data.resolve())
    return sorted(candidates, key=lambda item: item.stat().st_mtime, reverse=True)


def resolve_database(explicit: str | None) -> Path:
    if explicit:
        return normalize_database_path(explicit)

    configured = os.environ.get("QUICKEN_DB_PATH")
    if configured:
        return normalize_database_path(configured)

    candidates = discover_candidates()
    if not candidates:
        raise ProbeError(
            "No Quicken database was found. Pass --db or set QUICKEN_DB_PATH."
        )
    if len(candidates) > 1:
        raise ProbeError(
            "Multiple Quicken databases were found; choose one explicitly with --db.",
            candidates=candidates,
        )
    return candidates[0]


def candidate_record(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": str(path),
        "modified_at": datetime.fromtimestamp(
            stat.st_mtime, tz=timezone.utc
        ).isoformat(),
        "size_bytes": stat.st_size,
    }


def open_readonly(path: Path) -> sqlite3.Connection:
    if not path.exists():
        raise ProbeError(f"Database does not exist: {path}")
    if not path.is_file():
        raise ProbeError(f"Database path is not a regular file: {path}")

    try:
        return sqlite3.connect(f"{path.as_uri()}?mode=ro", uri=True)
    except sqlite3.Error as error:
        raise ProbeError(f"SQLite could not open the database read-only: {error}") from error


def entity_id(connection: sqlite3.Connection, name: str) -> int | None:
    row = connection.execute(
        "SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = ?", (name,)
    ).fetchone()
    return None if row is None else int(row[0])


def verify_quicken(connection: sqlite3.Connection) -> None:
    row = connection.execute(
        "SELECT 1 FROM sqlite_master "
        "WHERE type = 'table' AND name = 'ZACCOUNT' LIMIT 1"
    ).fetchone()
    if row is None:
        raise ProbeError(
            "ZACCOUNT is unavailable. The file may be encrypted; open the intended "
            "Quicken file, wait a few seconds, and retry."
        )


def probe(path: Path) -> dict[str, Any]:
    with open_readonly(path) as connection:
        verify_quicken(connection)
        category_tag = entity_id(connection, "CategoryTag")
        metadata = connection.execute(
            "SELECT Z_VERSION FROM Z_METADATA LIMIT 1"
        ).fetchone()

    result = candidate_record(path)
    result.update(
        {
            "ready": True,
            "category_tag_entity_id": category_tag,
            "metadata_version": None if metadata is None else metadata[0],
        }
    )
    return result


def quote_identifier(identifier: str) -> str:
    if IDENTIFIER.fullmatch(identifier) is None:
        raise ProbeError(f"Unsafe SQLite identifier discovered: {identifier!r}")
    return f'"{identifier}"'


def discover_user_tag_schema(path: Path) -> dict[str, Any]:
    with open_readonly(path) as connection:
        verify_quicken(connection)
        entry_entity = entity_id(connection, "CashFlowTransactionEntry")
        tag_entity = entity_id(connection, "UserTag")
        if entry_entity is None or tag_entity is None:
            raise ProbeError(
                "CashFlowTransactionEntry or UserTag is missing from Z_PRIMARYKEY."
            )

        rows = connection.execute(
            "SELECT name FROM sqlite_master "
            "WHERE type = 'table' AND name GLOB 'Z_*USERTAGS*' ORDER BY name"
        ).fetchall()

        matches: list[dict[str, Any]] = []
        entry_prefix = f"Z_{entry_entity}CASHFLOWTRANSACTIONENTRIES"
        tag_prefix = f"Z_{tag_entity}USERTAGS"
        for (table_name,) in rows:
            quoted_table = quote_identifier(str(table_name))
            columns = [
                str(row[1])
                for row in connection.execute(
                    f"PRAGMA table_info({quoted_table})"
                ).fetchall()
            ]
            for column_name in columns:
                quote_identifier(column_name)
            entry_columns = [name for name in columns if name.startswith(entry_prefix)]
            tag_columns = [name for name in columns if name.startswith(tag_prefix)]
            if len(entry_columns) > 1 or len(tag_columns) > 1:
                raise ProbeError(
                    "Ambiguous user-tag join columns were found in "
                    f"{table_name}; inspect that table explicitly."
                )
            if entry_columns and tag_columns:
                matches.append(
                    {
                        "table": table_name,
                        "entry_column": entry_columns[0],
                        "user_tag_column": tag_columns[0],
                    }
                )

        if not matches:
            raise ProbeError(
                "No unambiguous user-tag join table was found in the selected database."
            )
        if len(matches) > 1:
            raise ProbeError(
                "Multiple possible user-tag join tables were found; inspect them "
                "explicitly before querying tags."
            )

    return {
        "database": str(path),
        "entry_entity_id": entry_entity,
        "user_tag_entity_id": tag_entity,
        "matches": matches,
    }


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser(
        description="Inspect Quicken schema metadata using a read-only SQLite connection."
    )
    subparsers = result.add_subparsers(dest="command", required=True)

    probe_parser = subparsers.add_parser(
        "probe", help="Resolve and verify one unlocked Quicken database."
    )
    probe_parser.add_argument("--db", help="Path to a .quicken bundle or data file.")

    subparsers.add_parser(
        "candidates", help="List Quicken databases found directly under ~/Documents."
    )

    tag_parser = subparsers.add_parser(
        "user-tag-schema", help="Discover the physical user-tag join identifiers."
    )
    tag_parser.add_argument("--db", help="Path to a .quicken bundle or data file.")
    return result


def emit(payload: dict[str, Any] | list[dict[str, Any]]) -> None:
    print(json.dumps(payload, indent=2, sort_keys=True))


def main() -> int:
    args = parser().parse_args()
    try:
        if args.command == "candidates":
            emit([candidate_record(path) for path in discover_candidates()])
            return 0

        path = resolve_database(args.db)
        if args.command == "probe":
            emit(probe(path))
        else:
            emit(discover_user_tag_schema(path))
        return 0
    except (ProbeError, OSError, sqlite3.Error) as error:
        payload: dict[str, Any] = {"ready": False, "error": str(error)}
        if isinstance(error, ProbeError) and error.candidates:
            payload["candidates"] = [
                candidate_record(path) for path in error.candidates
            ]
        emit(payload)
        return 2


if __name__ == "__main__":
    sys.exit(main())
