from __future__ import annotations

import json
from pathlib import Path
import sys


ROOT_DIR = Path(__file__).resolve().parents[1]
if str(ROOT_DIR) not in sys.path:
    sys.path.insert(0, str(ROOT_DIR))

from core.database import (
    Event,
    _compose_searchable_text,
    _decode_json_list,
    _encode_json_list,
    _sync_event_fts,
    get_connection,
    init_db,
    list_events_batch,
)
from core.keywords import extract_keyphrases
from core.semantic import embed_text
from core.vector_store import is_available as chroma_available, reset_collection, upsert_events


DB_PATH = Path.home() / "AppData" / "Local" / "memact" / "memact.db"


def _row_event(row) -> Event:
    return Event(
        id=int(row["id"]),
        occurred_at=row["occurred_at"],
        application=row["application"],
        window_title=row["window_title"],
        url=row["url"],
        interaction_type=row["interaction_type"],
        content_text=row["content_text"],
        exe_path=row["exe_path"],
        tab_titles_json=row["tab_titles_json"],
        tab_urls_json=row["tab_urls_json"],
        full_text=row["full_text"],
        keyphrases_json=row["keyphrases_json"],
        searchable_text=row["searchable_text"],
        embedding_json=row["embedding_json"],
        source=row["source"],
    )


def _embedding_dim(value: str | None) -> int:
    if not value:
        return 0
    try:
        parsed = json.loads(value)
    except Exception:
        return 0
    if not isinstance(parsed, list):
        return 0
    return len(parsed)


def _repair_rows() -> tuple[int, int]:
    updated_rows = 0
    total_rows = 0
    target_dim = len(embed_text("memact embedding probe"))

    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                id,
                occurred_at,
                application,
                window_title,
                url,
                interaction_type,
                content_text,
                exe_path,
                tab_titles_json,
                tab_urls_json,
                full_text,
                keyphrases_json,
                searchable_text,
                embedding_json,
                source
            FROM events
            ORDER BY id ASC
            """
        ).fetchall()

        for row in rows:
            total_rows += 1
            full_text = str(row["full_text"] or "").strip() or None
            existing_keyphrases = _decode_json_list(row["keyphrases_json"])
            keyphrases = existing_keyphrases or (extract_keyphrases(full_text) if full_text else [])
            searchable_text = _compose_searchable_text(
                application=row["application"],
                window_title=row["window_title"],
                url=row["url"],
                content_text=row["content_text"],
                full_text=full_text,
                keyphrases=keyphrases,
                tab_titles=_decode_json_list(row["tab_titles_json"]),
                tab_urls=_decode_json_list(row["tab_urls_json"]),
            )
            embedding_json = json.dumps(embed_text(searchable_text), ensure_ascii=True)
            keyphrases_json = _encode_json_list(keyphrases)

            needs_update = (
                keyphrases_json != row["keyphrases_json"]
                or searchable_text != row["searchable_text"]
                or _embedding_dim(row["embedding_json"]) != target_dim
                or embedding_json != row["embedding_json"]
            )
            if not needs_update:
                continue

            connection.execute(
                """
                UPDATE events
                SET keyphrases_json = ?,
                    searchable_text = ?,
                    embedding_json = ?
                WHERE id = ?
                """,
                (
                    keyphrases_json,
                    searchable_text,
                    embedding_json,
                    int(row["id"]),
                ),
            )
            _sync_event_fts(connection, int(row["id"]))
            updated_rows += 1

        connection.commit()

    return updated_rows, total_rows


def _rebuild_chroma() -> int:
    if not chroma_available():
        return 0
    reset_collection()
    total = 0
    offset = 0
    batch_size = 500
    while True:
        batch = list_events_batch(offset=offset, limit=batch_size)
        if not batch:
            break
        upsert_events(batch)
        total += len(batch)
        offset += len(batch)
    return total


def main() -> int:
    init_db()
    print(f"Repairing local knowledge store at {DB_PATH}")
    updated_rows, total_rows = _repair_rows()
    print(f"Updated {updated_rows} of {total_rows} events.")
    chroma_rows = _rebuild_chroma()
    if chroma_rows:
        print(f"Rebuilt Chroma index with {chroma_rows} events.")
    else:
        print("Skipped Chroma rebuild because ChromaDB is unavailable.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
