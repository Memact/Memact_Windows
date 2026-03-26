from __future__ import annotations

import json
import sqlite3
import shutil
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

from core.content_intel import extract_content_profile, normalize_capture_text
from core.keywords import extract_keyphrases, keyphrases_to_text
from core.semantic import embed_text


APP_DIR = Path.home() / "AppData" / "Local" / "memact"
LEGACY_APP_DIR = Path.home() / "AppData" / "Local" / "Memact"
DB_PATH = APP_DIR / "memact.db"


@dataclass(slots=True)
class Event:
    id: int
    occurred_at: str
    application: str
    window_title: str
    url: str | None
    interaction_type: str
    content_text: str | None
    exe_path: str | None
    tab_titles_json: str | None
    tab_urls_json: str | None
    full_text: str | None
    keyphrases_json: str | None
    searchable_text: str
    embedding_json: str
    source: str

    @property
    def timestamp(self) -> str:
        return self.occurred_at

    @property
    def app_name(self) -> str:
        return self.application

    @property
    def context_title(self) -> str | None:
        return self.content_text

    @property
    def tab_titles(self) -> list[str]:
        return _decode_json_list(self.tab_titles_json)

    @property
    def tab_urls(self) -> list[str]:
        return _decode_json_list(self.tab_urls_json)

    @property
    def tabs(self) -> list[str]:
        return self.tab_titles

    @property
    def urls(self) -> list[str]:
        urls = self.tab_urls
        if urls:
            return urls
        return [self.url] if self.url else []

    @property
    def keyphrases(self) -> list[str]:
        return _decode_json_list(self.keyphrases_json)


Anchor = Event


def get_connection() -> sqlite3.Connection:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    legacy_db = LEGACY_APP_DIR / "memact.db"
    if not DB_PATH.exists() and legacy_db.exists():
        shutil.copy2(legacy_db, DB_PATH)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


def _decode_json_list(value: str | None) -> list[str]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    return [str(item).strip() for item in parsed if str(item).strip()]


def _encode_json_list(items: list[str] | None) -> str | None:
    if not items:
        return None
    cleaned = [str(item).strip() for item in items if str(item).strip()]
    if not cleaned:
        return None
    return json.dumps(cleaned, ensure_ascii=True)


def _decode_json_vector(value: str | None) -> list[float]:
    if not value:
        return []
    try:
        parsed = json.loads(value)
    except Exception:
        return []
    if not isinstance(parsed, list):
        return []
    vector: list[float] = []
    for item in parsed:
        try:
            vector.append(float(item))
        except Exception:
            continue
    return vector


def _domain_from_url(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme == "file":
        return "local file"
    if parsed.netloc:
        return parsed.netloc.removeprefix("www.").lower()
    return None


def _compose_searchable_text(
    *,
    application: str,
    window_title: str,
    url: str | None,
    content_text: str | None,
    full_text: str | None = None,
    keyphrases: list[str] | None = None,
    tab_titles: list[str] | None,
    tab_urls: list[str] | None,
) -> str:
    parts = [
        application or "",
        window_title or "",
        content_text or "",
        full_text or "",
        keyphrases_to_text(keyphrases or []),
        url or "",
        _domain_from_url(url) or "",
        " ".join(tab_titles or []),
        " ".join(tab_urls or []),
    ]
    return " ".join(part.strip() for part in parts if part and part.strip())


def _event_column_names(connection: sqlite3.Connection) -> set[str]:
    rows = connection.execute("PRAGMA table_info(events)").fetchall()
    return {str(row["name"]).strip().lower() for row in rows}


def _ensure_event_column(connection: sqlite3.Connection, definition: str) -> None:
    name = definition.split()[0].strip().lower()
    if name in _event_column_names(connection):
        return
    try:
        connection.execute(f"ALTER TABLE events ADD COLUMN IF NOT EXISTS {definition}")
        return
    except sqlite3.OperationalError:
        if name in _event_column_names(connection):
            return
    connection.execute(f"ALTER TABLE events ADD COLUMN {definition}")


def _sync_event_fts(connection: sqlite3.Connection, event_id: int) -> None:
    row = connection.execute(
        """
        SELECT
            id,
            searchable_text,
            application,
            window_title,
            COALESCE(url, '') AS url,
            COALESCE(content_text, '') AS content_text
        FROM events
        WHERE id = ?
        """,
        (event_id,),
    ).fetchone()
    connection.execute("DELETE FROM events_fts WHERE rowid = ?", (event_id,))
    if row is None:
        return
    connection.execute(
        """
        INSERT INTO events_fts(rowid, event_id, searchable_text, application, window_title, url, content_text)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            row["id"],
            row["id"],
            row["searchable_text"],
            row["application"],
            row["window_title"],
            row["url"],
            row["content_text"],
        ),
    )


def _events_exist(connection: sqlite3.Connection) -> bool:
    row = connection.execute("SELECT COUNT(*) AS count FROM events").fetchone()
    return bool(row and int(row["count"]) > 0)


def _anchors_table_exists(connection: sqlite3.Connection) -> bool:
    row = connection.execute(
        """
        SELECT name
        FROM sqlite_master
        WHERE type = 'table' AND name = 'anchors'
        """
    ).fetchone()
    return row is not None


def _backfill_from_anchors(connection: sqlite3.Connection) -> None:
    if _events_exist(connection) or not _anchors_table_exists(connection):
        return
    rows = connection.execute(
        """
        SELECT
            id,
            COALESCE(session_start, timestamp) AS occurred_at,
            app_name,
            COALESCE(context_title, window_title, '') AS content_text,
            window_title,
            url,
            exe_path,
            tab_snapshot,
            tab_urls
        FROM anchors
        ORDER BY COALESCE(session_start, timestamp) ASC, id ASC
        """
    ).fetchall()
    for row in rows:
        tab_titles = _decode_json_list(row["tab_snapshot"])
        tab_urls = _decode_json_list(row["tab_urls"])
        searchable_text = _compose_searchable_text(
            application=row["app_name"],
            window_title=row["window_title"],
            url=row["url"],
            content_text=row["content_text"],
            full_text=None,
            keyphrases=None,
            tab_titles=tab_titles,
            tab_urls=tab_urls,
        )
        embedding_json = json.dumps(embed_text(searchable_text), ensure_ascii=True)
        cursor = connection.execute(
            """
            INSERT INTO events (
                occurred_at,
                application,
                window_title,
                url,
                interaction_type,
                content_text,
                exe_path,
                tab_titles_json,
                tab_urls_json,
                searchable_text,
                embedding_json,
                source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                row["occurred_at"],
                row["app_name"],
                row["window_title"],
                row["url"],
                "legacy_import",
                row["content_text"],
                row["exe_path"],
                _encode_json_list(tab_titles),
                _encode_json_list(tab_urls),
                searchable_text,
                embedding_json,
                "legacy",
            ),
        )
        _sync_event_fts(connection, int(cursor.lastrowid))


def init_db() -> None:
    with get_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                occurred_at TEXT NOT NULL,
                application TEXT NOT NULL,
                window_title TEXT NOT NULL,
                url TEXT,
                interaction_type TEXT NOT NULL,
                content_text TEXT,
                exe_path TEXT,
                tab_titles_json TEXT,
                tab_urls_json TEXT,
                searchable_text TEXT NOT NULL,
                embedding_json TEXT NOT NULL,
                source TEXT NOT NULL DEFAULT 'monitor'
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_events_occurred_at
            ON events(occurred_at DESC)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_events_application
            ON events(application)
            """
        )
        _ensure_event_column(connection, "full_text TEXT")
        _ensure_event_column(connection, "keyphrases_json TEXT")
        connection.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS events_fts
            USING fts5(
                event_id UNINDEXED,
                searchable_text,
                application,
                window_title,
                url,
                content_text
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                label TEXT NOT NULL DEFAULT '',
                started_at TEXT NOT NULL,
                ended_at TEXT NOT NULL,
                event_count INTEGER NOT NULL DEFAULT 0,
                embedding_json TEXT NOT NULL DEFAULT '[]',
                keyphrases_json TEXT,
                recency_score REAL NOT NULL DEFAULT 0.0,
                dependency_score REAL NOT NULL DEFAULT 0.0,
                total_score REAL NOT NULL DEFAULT 0.0,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS session_links (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_session_id INTEGER NOT NULL,
                target_session_id INTEGER NOT NULL,
                link_type TEXT NOT NULL,
                strength REAL NOT NULL DEFAULT 0.0,
                created_at TEXT NOT NULL,
                FOREIGN KEY (source_session_id) REFERENCES sessions(id),
                FOREIGN KEY (target_session_id) REFERENCES sessions(id)
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS event_sessions (
                event_id INTEGER NOT NULL,
                session_id INTEGER NOT NULL,
                position REAL NOT NULL DEFAULT 0.5,
                dependency_score REAL NOT NULL DEFAULT 0.0,
                PRIMARY KEY (event_id, session_id),
                FOREIGN KEY (event_id) REFERENCES events(id),
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            )
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_sessions_started_at
            ON sessions(started_at DESC)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_sessions_total_score
            ON sessions(total_score DESC)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_event_sessions_session_id
            ON event_sessions(session_id)
            """
        )
        connection.execute(
            """
            CREATE INDEX IF NOT EXISTS idx_session_links_source
            ON session_links(source_session_id)
            """
        )
        _backfill_from_anchors(connection)
        fts_count = int(
            connection.execute("SELECT COUNT(*) AS count FROM events_fts").fetchone()["count"]
        )
        event_count = int(
            connection.execute("SELECT COUNT(*) AS count FROM events").fetchone()["count"]
        )
        if fts_count != event_count:
            connection.execute("DELETE FROM events_fts")
            rows = connection.execute("SELECT id FROM events").fetchall()
            for row in rows:
                _sync_event_fts(connection, int(row["id"]))
        connection.commit()
    try:
        from core.retention import ensure_retention_schema

        ensure_retention_schema()
    except Exception:
        pass


def append_event(
    *,
    application: str,
    window_title: str,
    url: str | None = None,
    interaction_type: str = "focus",
    content_text: str | None = None,
    full_text: str | None = None,
    exe_path: str | None = None,
    tab_titles: list[str] | None = None,
    tab_urls: list[str] | None = None,
    occurred_at: str | None = None,
    source: str = "monitor",
) -> int:
    timestamp = occurred_at or datetime.now().isoformat(sep=" ", timespec="seconds")
    normalized_full_text = normalize_capture_text(full_text, preserve_paragraphs=True, max_chars=8000) or None
    profile = extract_content_profile(
        normalized_full_text or content_text or window_title,
        title=window_title,
        app_name=application,
        url=url,
    )
    keyphrase_source = profile.keyphrase_source or normalized_full_text or str(content_text or "").strip()
    searchable_full_text = profile.cleaned_text or normalized_full_text
    keyphrases = extract_keyphrases(keyphrase_source) if keyphrase_source else []
    keyphrases_json = _encode_json_list(keyphrases)
    searchable_text = _compose_searchable_text(
        application=application,
        window_title=window_title,
        url=url,
        content_text=content_text,
        full_text=searchable_full_text,
        keyphrases=keyphrases,
        tab_titles=tab_titles,
        tab_urls=tab_urls,
    )
    embedding_json = json.dumps(embed_text(searchable_text), ensure_ascii=True)
    tab_titles_json = _encode_json_list(tab_titles)
    tab_urls_json = _encode_json_list(tab_urls)
    with get_connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO events (
                occurred_at,
                application,
                window_title,
                url,
                interaction_type,
                content_text,
                full_text,
                exe_path,
                tab_titles_json,
                tab_urls_json,
                keyphrases_json,
                searchable_text,
                embedding_json,
                source
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                timestamp,
                application,
                window_title,
                url,
                interaction_type,
                content_text,
                normalized_full_text,
                exe_path,
                tab_titles_json,
                tab_urls_json,
                keyphrases_json,
                searchable_text,
                embedding_json,
                source,
            ),
        )
        event_id = int(cursor.lastrowid)
        _sync_event_fts(connection, event_id)
        connection.commit()
    try:
        from core.vector_store import upsert_events

        event = Event(
            id=event_id,
            occurred_at=timestamp,
            application=application,
            window_title=window_title,
            url=url,
            interaction_type=interaction_type,
            content_text=content_text,
            exe_path=exe_path,
            tab_titles_json=tab_titles_json,
            tab_urls_json=tab_urls_json,
            full_text=normalized_full_text,
            keyphrases_json=keyphrases_json,
            searchable_text=searchable_text,
            embedding_json=embedding_json,
            source=source,
        )
        upsert_events([event])
    except Exception:
        pass
    try:
        from core.retention import schedule_memory_promotion

        schedule_memory_promotion(event_id)
    except Exception:
        pass
    return event_id


def list_events_by_ids(ids: list[int]) -> list[Event]:
    if not ids:
        return []
    placeholders = ", ".join("?" for _ in ids)
    with get_connection() as connection:
        rows = connection.execute(
            f"""
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
            WHERE id IN ({placeholders})
            """,
            tuple(ids),
        ).fetchall()
    by_id = {int(row["id"]): Event(**dict(row)) for row in rows}
    return [by_id[event_id] for event_id in ids if event_id in by_id]


def list_recent_events(limit: int = 400) -> list[Event]:
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
            ORDER BY occurred_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [Event(**dict(row)) for row in rows]


def list_events_between(
    start_at: str | None,
    end_at: str | None,
    *,
    limit: int = 1200,
) -> list[Event]:
    clauses: list[str] = []
    params: list[object] = []
    if start_at is not None:
        clauses.append("occurred_at >= ?")
        params.append(start_at)
    if end_at is not None:
        clauses.append("occurred_at <= ?")
        params.append(end_at)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    params.append(limit)
    with get_connection() as connection:
        rows = connection.execute(
            f"""
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
            {where}
            ORDER BY occurred_at DESC, id DESC
            LIMIT ?
            """,
            tuple(params),
        ).fetchall()
    return [Event(**dict(row)) for row in rows]


def list_events_batch(*, offset: int = 0, limit: int = 1000) -> list[Event]:
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
            ORDER BY occurred_at ASC, id ASC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()
    return [Event(**dict(row)) for row in rows]


def list_events_around(
    occurred_at: str,
    *,
    before_limit: int = 6,
    after_limit: int = 6,
) -> tuple[list[Event], list[Event]]:
    with get_connection() as connection:
        before_rows = connection.execute(
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
            WHERE occurred_at < ?
            ORDER BY occurred_at DESC, id DESC
            LIMIT ?
            """,
            (occurred_at, before_limit),
        ).fetchall()
        after_rows = connection.execute(
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
            WHERE occurred_at > ?
            ORDER BY occurred_at ASC, id ASC
            LIMIT ?
            """,
            (occurred_at, after_limit),
        ).fetchall()
    before_events = [Event(**dict(row)) for row in reversed(before_rows)]
    after_events = [Event(**dict(row)) for row in after_rows]
    return before_events, after_events


def lexical_candidates(
    query: str,
    *,
    start_at: str | None = None,
    end_at: str | None = None,
    limit: int = 80,
) -> list[Event]:
    normalized = "".join(ch if ch.isalnum() else " " for ch in query)
    tokens = [token.strip() for token in normalized.split() if token.strip()]
    if not tokens:
        return list_recent_events(limit=limit)
    match_query = " ".join(f"{token}*" for token in tokens)
    clauses = ["events_fts MATCH ?"]
    params: list[object] = [match_query]
    if start_at is not None:
        clauses.append("e.occurred_at >= ?")
        params.append(start_at)
    if end_at is not None:
        clauses.append("e.occurred_at <= ?")
        params.append(end_at)
    params.append(limit)
    with get_connection() as connection:
        rows = connection.execute(
            f"""
            SELECT
                e.id,
                e.occurred_at,
                e.application,
                e.window_title,
                e.url,
                e.interaction_type,
                e.content_text,
                e.exe_path,
                e.tab_titles_json,
                e.tab_urls_json,
                e.full_text,
                e.keyphrases_json,
                e.searchable_text,
                e.embedding_json,
                e.source
            FROM events_fts
            INNER JOIN events e ON e.id = events_fts.rowid
            WHERE {' AND '.join(clauses)}
            ORDER BY bm25(events_fts), e.occurred_at DESC
            LIMIT ?
            """,
            tuple(params),
        ).fetchall()
    return [Event(**dict(row)) for row in rows]


def clear_memory() -> None:
    with get_connection() as connection:
        for table_name in ("memory_chunks_fts",):
            try:
                connection.execute(f"DELETE FROM {table_name}")
            except Exception:
                pass
        for table_name in ("memory_events", "memory_chunks", "retained_memories", "memory_backfill_state"):
            try:
                connection.execute(f"DELETE FROM {table_name}")
            except Exception:
                pass
        connection.execute("DELETE FROM session_links")
        connection.execute("DELETE FROM event_sessions")
        connection.execute("DELETE FROM sessions")
        connection.execute("DELETE FROM events_fts")
        connection.execute("DELETE FROM events")
        connection.commit()
    try:
        from core.vector_store import reset_collection, reset_memory_chunk_collection

        reset_collection()
        reset_memory_chunk_collection()
    except Exception:
        pass


def _session_row_to_dict(row: sqlite3.Row | dict) -> dict:
    payload = dict(row)
    payload["embedding"] = _decode_json_vector(payload.get("embedding_json"))
    payload["keyphrases"] = _decode_json_list(payload.get("keyphrases_json"))
    return payload


def list_sessions(limit: int = 100) -> list[dict]:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                id,
                label,
                started_at,
                ended_at,
                event_count,
                embedding_json,
                keyphrases_json,
                recency_score,
                dependency_score,
                total_score,
                updated_at
            FROM sessions
            ORDER BY total_score DESC, started_at DESC, id DESC
            LIMIT ?
            """,
            (limit,),
        ).fetchall()
    return [_session_row_to_dict(row) for row in rows]


def get_session_events(session_id: int) -> list[Event]:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                e.id,
                e.occurred_at,
                e.application,
                e.window_title,
                e.url,
                e.interaction_type,
                e.content_text,
                e.exe_path,
                e.tab_titles_json,
                e.tab_urls_json,
                e.full_text,
                e.keyphrases_json,
                e.searchable_text,
                e.embedding_json,
                e.source
            FROM event_sessions es
            INNER JOIN events e ON e.id = es.event_id
            WHERE es.session_id = ?
            ORDER BY e.occurred_at ASC, e.id ASC
            """,
            (session_id,),
        ).fetchall()
    return [Event(**dict(row)) for row in rows]


def get_event_session(event_id: int) -> int | None:
    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT session_id
            FROM event_sessions
            WHERE event_id = ?
            ORDER BY session_id DESC
            LIMIT 1
            """,
            (event_id,),
        ).fetchone()
    if row is None:
        return None
    return int(row["session_id"])


def get_event(event_id: int) -> Event | None:
    events = list_events_by_ids([event_id])
    return events[0] if events else None


def list_unassigned_events(
    start_at: str | None = None,
    end_at: str | None = None,
    *,
    limit: int | None = None,
) -> list[Event]:
    clauses = ["es.event_id IS NULL"]
    params: list[object] = []
    if start_at is not None:
        clauses.append("e.occurred_at >= ?")
        params.append(start_at)
    if end_at is not None:
        clauses.append("e.occurred_at <= ?")
        params.append(end_at)
    limit_sql = ""
    if limit is not None:
        limit_sql = "LIMIT ?"
        params.append(limit)
    with get_connection() as connection:
        rows = connection.execute(
            f"""
            SELECT
                e.id,
                e.occurred_at,
                e.application,
                e.window_title,
                e.url,
                e.interaction_type,
                e.content_text,
                e.exe_path,
                e.tab_titles_json,
                e.tab_urls_json,
                e.full_text,
                e.keyphrases_json,
                e.searchable_text,
                e.embedding_json,
                e.source
            FROM events e
            LEFT JOIN event_sessions es ON es.event_id = e.id
            WHERE {' AND '.join(clauses)}
            ORDER BY e.occurred_at ASC, e.id ASC
            {limit_sql}
            """,
            tuple(params),
        ).fetchall()
    return [Event(**dict(row)) for row in rows]


def count_unassigned_events() -> int:
    with get_connection() as connection:
        row = connection.execute(
            """
            SELECT COUNT(*) AS count
            FROM events e
            LEFT JOIN event_sessions es ON es.event_id = e.id
            WHERE es.event_id IS NULL
            """
        ).fetchone()
    return int(row["count"]) if row else 0


def clear_episodic_graph_tables() -> None:
    with get_connection() as connection:
        connection.execute("DELETE FROM session_links")
        connection.execute("DELETE FROM event_sessions")
        connection.execute("DELETE FROM sessions")
        connection.commit()


def insert_session(
    *,
    label: str,
    started_at: str,
    ended_at: str,
    event_count: int,
    embedding: list[float],
    keyphrases: list[str] | None = None,
    recency_score: float = 0.0,
    dependency_score: float = 0.0,
    total_score: float = 0.0,
    updated_at: str | None = None,
) -> int:
    updated_timestamp = updated_at or datetime.now().isoformat(sep=" ", timespec="seconds")
    with get_connection() as connection:
        cursor = connection.execute(
            """
            INSERT INTO sessions (
                label,
                started_at,
                ended_at,
                event_count,
                embedding_json,
                keyphrases_json,
                recency_score,
                dependency_score,
                total_score,
                updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                label,
                started_at,
                ended_at,
                event_count,
                json.dumps([float(value) for value in embedding], ensure_ascii=True),
                _encode_json_list(keyphrases),
                float(recency_score),
                float(dependency_score),
                float(total_score),
                updated_timestamp,
            ),
        )
        connection.commit()
        return int(cursor.lastrowid)


def insert_event_session_mappings(session_id: int, event_ids: list[int]) -> None:
    if not event_ids:
        return
    total = max(len(event_ids) - 1, 1)
    with get_connection() as connection:
        connection.executemany(
            """
            INSERT OR REPLACE INTO event_sessions (event_id, session_id, position, dependency_score)
            VALUES (?, ?, ?, COALESCE((SELECT dependency_score FROM event_sessions WHERE event_id = ? AND session_id = ?), 0.0))
            """,
            [
                (
                    int(event_id),
                    int(session_id),
                    (index / total) if len(event_ids) > 1 else 0.5,
                    int(event_id),
                    int(session_id),
                )
                for index, event_id in enumerate(event_ids)
            ],
        )
        connection.commit()


def insert_session_links(links: list[dict]) -> int:
    if not links:
        return 0
    created_at = datetime.now().isoformat(sep=" ", timespec="seconds")
    with get_connection() as connection:
        connection.executemany(
            """
            INSERT INTO session_links (
                source_session_id,
                target_session_id,
                link_type,
                strength,
                created_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            [
                (
                    int(link["source_session_id"]),
                    int(link["target_session_id"]),
                    str(link["link_type"]),
                    float(link.get("strength", 0.0)),
                    created_at,
                )
                for link in links
            ],
        )
        connection.commit()
    return len(links)


def save_anchor(
    *,
    app_name: str,
    window_title: str,
    context_title: str | None = None,
    url: str | None = None,
    tab_snapshot: list[str] | None = None,
    tab_urls: list[str] | None = None,
    scroll_position: str | None = None,
    exe_path: str | None = None,
) -> bool:
    del scroll_position
    append_event(
        application=app_name,
        window_title=window_title,
        url=url,
        interaction_type="legacy_focus",
        content_text=context_title,
        exe_path=exe_path,
        tab_titles=tab_snapshot,
        tab_urls=tab_urls,
        source="legacy",
    )
    return True


def extend_latest_session(
    *,
    app_name: str,
    window_title: str,
    context_title: str | None = None,
    url: str | None = None,
    tab_snapshot: list[str] | None = None,
    tab_urls: list[str] | None = None,
    scroll_position: str | None = None,
    exe_path: str | None = None,
) -> bool:
    del scroll_position
    append_event(
        application=app_name,
        window_title=window_title,
        url=url,
        interaction_type="legacy_heartbeat",
        content_text=context_title,
        exe_path=exe_path,
        tab_titles=tab_snapshot,
        tab_urls=tab_urls,
        source="legacy",
    )
    return True
