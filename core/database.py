from __future__ import annotations

import json
import sqlite3
from collections import Counter
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse


APP_DIR = Path.home() / "AppData" / "Local" / "Memact"
DB_PATH = APP_DIR / "memact.db"


@dataclass(slots=True)
class Anchor:
    id: int
    timestamp: str
    timestamp_start: str
    timestamp_end: str
    session_start: str
    session_end: str
    duration_seconds: int
    app_name: str
    window_title: str
    context_title: str | None
    url: str | None
    tab_snapshot: str | None
    tab_urls: str | None
    scroll_position: str | None
    exe_path: str | None
    group_id: int | None = None
    group_name: str | None = None

    @property
    def title(self) -> str:
        return (self.context_title or self.window_title or "").strip()

    @property
    def start_time(self) -> str:
        return self.timestamp_start or self.session_start or self.timestamp

    @property
    def end_time(self) -> str:
        return self.timestamp_end or self.session_end or self.timestamp

    @property
    def tabs(self) -> list[str]:
        if not self.tab_snapshot:
            return []
        try:
            value = json.loads(self.tab_snapshot)
            if isinstance(value, list):
                return [str(item) for item in value if str(item).strip()]
        except Exception:
            return []
        return []

    @property
    def urls(self) -> list[str]:
        if not self.tab_urls:
            return [self.url] if self.url else []
        try:
            value = json.loads(self.tab_urls)
            if isinstance(value, list):
                urls = [str(item) for item in value if str(item).strip()]
                return urls or ([self.url] if self.url else [])
        except Exception:
            return [self.url] if self.url else []
        return [self.url] if self.url else []


@dataclass(slots=True)
class Group:
    id: int
    name: str
    created_at: str
    auto_generated: int
    session_count: int


def get_connection() -> sqlite3.Connection:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection


CODING_APP_NAMES = {
    "code",
    "cursor",
    "devenv",
    "pycharm64",
    "studio64",
    "webstorm64",
    "clion64",
    "rider64",
    "goland64",
    "windowsterminal",
    "powershell",
    "cmd",
    "python",
    "pythonw",
}


def _browser_domain(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme == "file":
        return "local file"
    if parsed.netloc:
        return parsed.netloc.removeprefix("www.").lower()
    return None


def _session_title(window_title: str, context_title: str | None) -> str:
    return (context_title or window_title or "").strip()


def _title_words(title: str) -> set[str]:
    words: set[str] = set()
    for raw in title.lower().replace("-", " ").replace("_", " ").split():
        token = "".join(ch for ch in raw if ch.isalnum())
        if len(token) >= 3:
            words.add(token)
    return words


def _coding_dominates(app_names: list[str]) -> bool:
    if not app_names:
        return False
    coding_count = sum(
        1
        for app_name in app_names
        if app_name.removesuffix(".exe").lower() in CODING_APP_NAMES
    )
    return coding_count >= max(1, len(app_names) // 2 + len(app_names) % 2)


def _friendly_group_app_name(app_name: str) -> str:
    base = app_name.removesuffix(".exe")
    friendly_names = {
        "code": "VSCode",
        "windowsterminal": "Windows Terminal",
        "python": "Python",
        "pythonw": "Python",
        "devenv": "Visual Studio",
    }
    return friendly_names.get(base.lower(), base.replace("_", " ").title())


def _default_group_name(app_name: str, url: str | None) -> str:
    domain = _browser_domain(url)
    if domain:
        return domain
    return _friendly_group_app_name(app_name)


def _create_group(
    connection: sqlite3.Connection,
    *,
    name: str,
    auto_generated: bool = True,
) -> int:
    created_at = datetime.now().isoformat(sep=" ", timespec="seconds")
    cursor = connection.execute(
        """
        INSERT INTO groups (name, created_at, auto_generated)
        VALUES (?, ?, ?)
        """,
        (name, created_at, 1 if auto_generated else 0),
    )
    return int(cursor.lastrowid)


def _delete_session_fts(connection: sqlite3.Connection, session_id: int) -> None:
    connection.execute(
        "DELETE FROM sessions_fts WHERE rowid = ?",
        (session_id,),
    )


def _sync_session_fts(connection: sqlite3.Connection, session_id: int) -> None:
    row = connection.execute(
        """
        SELECT
            a.id,
            COALESCE(a.context_title, a.window_title, '') AS title,
            a.app_name,
            COALESCE(a.url, '') AS url,
            COALESCE(g.name, '') AS group_name
        FROM anchors a
        LEFT JOIN group_sessions gs ON gs.session_id = a.id
        LEFT JOIN groups g ON g.id = gs.group_id
        WHERE a.id = ?
        """,
        (session_id,),
    ).fetchone()
    _delete_session_fts(connection, session_id)
    if row is None:
        return
    connection.execute(
        """
        INSERT INTO sessions_fts(rowid, session_id, title, app_name, url, group_name)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            row["id"],
            row["id"],
            row["title"],
            row["app_name"],
            row["url"],
            row["group_name"],
        ),
    )


def _sync_group_sessions_fts(connection: sqlite3.Connection, group_id: int) -> None:
    rows = connection.execute(
        "SELECT session_id FROM group_sessions WHERE group_id = ?",
        (group_id,),
    ).fetchall()
    for row in rows:
        _sync_session_fts(connection, row["session_id"])


def _refresh_group_name(connection: sqlite3.Connection, group_id: int) -> None:
    group = connection.execute(
        "SELECT auto_generated FROM groups WHERE id = ?",
        (group_id,),
    ).fetchone()
    if group is None or not int(group["auto_generated"]):
        return

    rows = connection.execute(
        """
        SELECT a.app_name, a.url
        FROM anchors a
        INNER JOIN group_sessions gs ON gs.session_id = a.id
        WHERE gs.group_id = ?
        """,
        (group_id,),
    ).fetchall()
    if not rows:
        connection.execute("DELETE FROM groups WHERE id = ?", (group_id,))
        return

    domains = [_browser_domain(row["url"]) for row in rows]
    non_empty_domains = [domain for domain in domains if domain]
    app_names = [row["app_name"] for row in rows]
    unique_apps = {app_name.lower() for app_name in app_names}

    if len(unique_apps) == 1:
        name = _friendly_group_app_name(app_names[0])
    elif non_empty_domains and len(non_empty_domains) == len(rows) and len(set(non_empty_domains)) == 1:
        name = non_empty_domains[0]
    else:
        name = "Work Session"

    connection.execute(
        "UPDATE groups SET name = ? WHERE id = ?",
        (name, group_id),
    )
    _sync_group_sessions_fts(connection, group_id)


def _attach_session_to_group(
    connection: sqlite3.Connection,
    *,
    session_id: int,
    group_id: int,
) -> None:
    connection.execute(
        """
        INSERT OR REPLACE INTO group_sessions (group_id, session_id)
        VALUES (?, ?)
        """,
        (group_id, session_id),
    )


def _auto_group_for_session(
    connection: sqlite3.Connection,
    *,
    session_id: int,
    session_end: str,
    app_name: str,
    url: str | None,
    title: str,
) -> int:
    recent_groups = connection.execute(
        """
        SELECT
            gs.group_id,
            a.app_name,
            a.url,
            a.window_title,
            a.context_title,
            COALESCE(a.session_end, a.timestamp) AS session_end
        FROM group_sessions gs
        INNER JOIN anchors a ON a.id = gs.session_id
        INNER JOIN (
            SELECT
                gs2.group_id,
                MAX(COALESCE(a2.session_end, a2.timestamp)) AS latest_session_end
            FROM group_sessions gs2
            INNER JOIN anchors a2 ON a2.id = gs2.session_id
            GROUP BY gs2.group_id
        ) recent ON recent.group_id = gs.group_id
                 AND recent.latest_session_end = COALESCE(a.session_end, a.timestamp)
        WHERE a.id <> ?
        ORDER BY recent.latest_session_end DESC, gs.group_id DESC
        LIMIT 8
        """,
        (session_id,),
    ).fetchall()

    current_domain = _browser_domain(url)
    current_title = title
    best_score = -1
    previous_group_id = None
    for previous in recent_groups:
        score = 0
        try:
            previous_end = datetime.fromisoformat(previous["session_end"])
            current_end = datetime.fromisoformat(session_end)
            within_window = (current_end - previous_end).total_seconds() <= 600
        except ValueError:
            within_window = False
        previous_domain = _browser_domain(previous["url"])
        if previous["app_name"].lower() == app_name.lower():
            score += 3
        if current_domain and previous_domain and current_domain == previous_domain:
            score += 3
        previous_title = _session_title(
            previous["window_title"],
            previous["context_title"],
        )
        if _title_words(current_title) & _title_words(previous_title):
            score += 2
        if within_window:
            score += 2
        if score > best_score:
            best_score = score
            previous_group_id = previous["group_id"]

    if previous_group_id is None or best_score < 4:
        previous_group_id = _create_group(
            connection,
            name=_default_group_name(app_name, url),
            auto_generated=True,
        )

    _attach_session_to_group(
        connection,
        session_id=session_id,
        group_id=int(previous_group_id),
    )
    _refresh_group_name(connection, int(previous_group_id))
    _sync_session_fts(connection, session_id)
    return int(previous_group_id)


def _backfill_groups(connection: sqlite3.Connection) -> bool:
    anchor_count = connection.execute(
        "SELECT COUNT(*) AS count FROM anchors"
    ).fetchone()["count"]
    grouped_count = connection.execute(
        "SELECT COUNT(*) AS count FROM group_sessions"
    ).fetchone()["count"]
    if anchor_count == 0 or grouped_count > 0:
        return False

    rows = connection.execute(
        """
        SELECT
            id,
            app_name,
            url,
            window_title,
            context_title,
            COALESCE(session_end, timestamp) AS session_end
        FROM anchors
        ORDER BY COALESCE(session_start, timestamp) ASC, id ASC
        """
    ).fetchall()
    for row in rows:
        _auto_group_for_session(
            connection,
            session_id=row["id"],
            session_end=row["session_end"],
            app_name=row["app_name"],
            url=row["url"],
            title=_session_title(row["window_title"], row["context_title"]),
        )
    return True


def _rebuild_fts(connection: sqlite3.Connection) -> None:
    connection.execute("DELETE FROM sessions_fts")
    rows = connection.execute("SELECT id FROM anchors").fetchall()
    for row in rows:
        _sync_session_fts(connection, row["id"])


def _refresh_all_auto_group_names(connection: sqlite3.Connection) -> None:
    rows = connection.execute(
        "SELECT id FROM groups WHERE auto_generated = 1"
    ).fetchall()
    for row in rows:
        _refresh_group_name(connection, row["id"])


def init_db() -> None:
    with get_connection() as connection:
        needs_group_name_refresh = False
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS anchors (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                timestamp_start TEXT,
                timestamp_end TEXT,
                session_start TEXT,
                session_end TEXT,
                duration_seconds INTEGER NOT NULL DEFAULT 0,
                app_name TEXT NOT NULL,
                window_title TEXT NOT NULL,
                context_title TEXT,
                url TEXT,
                tab_snapshot TEXT,
                tab_urls TEXT,
                scroll_position TEXT,
                exe_path TEXT
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS groups (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL,
                auto_generated INTEGER NOT NULL DEFAULT 1
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS group_sessions (
                group_id INTEGER NOT NULL,
                session_id INTEGER NOT NULL UNIQUE,
                PRIMARY KEY (group_id, session_id),
                FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
                FOREIGN KEY (session_id) REFERENCES anchors(id) ON DELETE CASCADE
            )
            """
        )
        connection.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS sessions_fts
            USING fts5(
                session_id UNINDEXED,
                title,
                app_name,
                url,
                group_name
            )
            """
        )
        columns = {
            row["name"]
            for row in connection.execute("PRAGMA table_info(anchors)").fetchall()
        }
        if "url" not in columns:
            connection.execute("ALTER TABLE anchors ADD COLUMN url TEXT")
        if "context_title" not in columns:
            connection.execute("ALTER TABLE anchors ADD COLUMN context_title TEXT")
        if "timestamp_start" not in columns:
            connection.execute("ALTER TABLE anchors ADD COLUMN timestamp_start TEXT")
        if "timestamp_end" not in columns:
            connection.execute("ALTER TABLE anchors ADD COLUMN timestamp_end TEXT")
        if "session_start" not in columns:
            connection.execute("ALTER TABLE anchors ADD COLUMN session_start TEXT")
        if "session_end" not in columns:
            connection.execute("ALTER TABLE anchors ADD COLUMN session_end TEXT")
        if "duration_seconds" not in columns:
            connection.execute(
                "ALTER TABLE anchors ADD COLUMN duration_seconds INTEGER NOT NULL DEFAULT 0"
            )
        if "tab_snapshot" not in columns:
            connection.execute("ALTER TABLE anchors ADD COLUMN tab_snapshot TEXT")
        if "tab_urls" not in columns:
            connection.execute("ALTER TABLE anchors ADD COLUMN tab_urls TEXT")
        if "scroll_position" not in columns:
            connection.execute(
                "ALTER TABLE anchors ADD COLUMN scroll_position TEXT"
            )
        connection.execute(
            """
            UPDATE anchors
            SET
                timestamp_start = COALESCE(timestamp_start, session_start, timestamp),
                timestamp_end = COALESCE(timestamp_end, session_end, timestamp),
                session_start = COALESCE(session_start, timestamp),
                session_end = COALESCE(session_end, timestamp),
                duration_seconds = COALESCE(
                    duration_seconds,
                    0
                )
            """
        )
        if _backfill_groups(connection):
            needs_group_name_refresh = True

        anchor_count = int(
            connection.execute("SELECT COUNT(*) AS count FROM anchors").fetchone()["count"]
        )
        fts_count = int(
            connection.execute("SELECT COUNT(*) AS count FROM sessions_fts").fetchone()["count"]
        )
        if needs_group_name_refresh:
            _refresh_all_auto_group_names(connection)
        if fts_count != anchor_count:
            _rebuild_fts(connection)
        connection.commit()


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
    timestamp = datetime.now().isoformat(sep=" ", timespec="seconds")
    with get_connection() as connection:
        latest = connection.execute(
            """
            SELECT id, session_start, session_end
            FROM anchors
            ORDER BY id DESC
            LIMIT 1
            """
        ).fetchone()
        session_start = timestamp
        should_merge = False

        if latest is not None:
            latest_end = latest["session_end"] or latest["session_start"]
            try:
                last_seen_at = datetime.fromisoformat(latest_end)
                current_at = datetime.fromisoformat(timestamp)
                inactivity_seconds = (current_at - last_seen_at).total_seconds()
                should_merge = (
                    inactivity_seconds <= 120
                    and connection.execute(
                        """
                        SELECT 1
                        FROM anchors
                        WHERE id = ?
                          AND lower(app_name) = lower(?)
                          AND window_title = ?
                        """,
                        (latest["id"], app_name, window_title),
                    ).fetchone()
                    is not None
                )
                if should_merge:
                    session_start = latest["session_start"] or timestamp
            except ValueError:
                should_merge = False

        encoded_tab_snapshot = json.dumps(tab_snapshot) if tab_snapshot else None
        encoded_tab_urls = json.dumps(tab_urls) if tab_urls else None

        if should_merge and latest is not None:
            start_dt = datetime.fromisoformat(session_start)
            end_dt = datetime.fromisoformat(timestamp)
            duration_seconds = max(int((end_dt - start_dt).total_seconds()), 0)
            session_id = int(latest["id"])
            connection.execute(
                """
                UPDATE anchors
                SET
                    session_end = ?,
                    timestamp_end = ?,
                    duration_seconds = ?,
                    context_title = ?,
                    url = ?,
                    tab_snapshot = ?,
                    tab_urls = ?,
                    scroll_position = ?,
                    exe_path = ?,
                    timestamp = ?
                WHERE id = ?
                """,
                (
                    timestamp,
                    timestamp,
                    duration_seconds,
                    context_title,
                    url,
                    encoded_tab_snapshot,
                    encoded_tab_urls,
                    scroll_position,
                    exe_path,
                    timestamp,
                    session_id,
                ),
            )
            _sync_session_fts(connection, session_id)
        else:
            cursor = connection.execute(
                """
                INSERT INTO anchors (
                    timestamp,
                    timestamp_start,
                    timestamp_end,
                    session_start,
                    session_end,
                    duration_seconds,
                    app_name,
                    window_title,
                    context_title,
                    url,
                    tab_snapshot,
                    tab_urls,
                    scroll_position,
                    exe_path
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    timestamp,
                    timestamp,
                    timestamp,
                    timestamp,
                    timestamp,
                    0,
                    app_name,
                    window_title,
                    context_title,
                    url,
                    encoded_tab_snapshot,
                    encoded_tab_urls,
                    scroll_position,
                    exe_path,
                ),
            )
            session_id = int(cursor.lastrowid)
            _auto_group_for_session(
                connection,
                session_id=session_id,
                session_end=timestamp,
                app_name=app_name,
                url=url,
                title=_session_title(window_title, context_title),
            )
        connection.commit()
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
    timestamp = datetime.now().isoformat(sep=" ", timespec="seconds")
    encoded_tab_snapshot = json.dumps(tab_snapshot) if tab_snapshot else None
    encoded_tab_urls = json.dumps(tab_urls) if tab_urls else None

    with get_connection() as connection:
        latest = connection.execute(
            """
            SELECT id, session_start
            FROM anchors
            WHERE lower(app_name) = lower(?)
              AND window_title = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (app_name, window_title),
        ).fetchone()
        if latest is None:
            return False

        try:
            start_dt = datetime.fromisoformat(latest["session_start"] or timestamp)
            end_dt = datetime.fromisoformat(timestamp)
            duration_seconds = max(int((end_dt - start_dt).total_seconds()), 0)
        except ValueError:
            duration_seconds = 0

        connection.execute(
            """
            UPDATE anchors
            SET
                session_end = ?,
                timestamp_end = ?,
                duration_seconds = ?,
                context_title = ?,
                url = ?,
                tab_snapshot = ?,
                tab_urls = ?,
                scroll_position = ?,
                exe_path = ?
            WHERE id = ?
            """,
            (
                timestamp,
                timestamp,
                duration_seconds,
                context_title,
                url,
                encoded_tab_snapshot,
                encoded_tab_urls,
                scroll_position,
                exe_path,
                latest["id"],
            ),
        )
        _sync_session_fts(connection, int(latest["id"]))
        connection.commit()
    return True


def list_anchors(limit: int = 300, group_id: int | None = None) -> list[Anchor]:
    with get_connection() as connection:
        if group_id is None:
            rows = connection.execute(
                """
            SELECT
                a.id,
                COALESCE(a.session_start, a.timestamp) AS timestamp,
                COALESCE(a.timestamp_start, a.session_start, a.timestamp) AS timestamp_start,
                COALESCE(a.timestamp_end, a.session_end, a.timestamp) AS timestamp_end,
                COALESCE(a.session_start, a.timestamp) AS session_start,
                COALESCE(a.session_end, a.timestamp) AS session_end,
                COALESCE(a.duration_seconds, 0) AS duration_seconds,
                a.app_name,
                a.window_title,
                a.context_title,
                a.url,
                a.tab_snapshot,
                a.tab_urls,
                a.scroll_position,
                a.exe_path,
                gs.group_id,
                g.name AS group_name
            FROM anchors a
            LEFT JOIN group_sessions gs ON gs.session_id = a.id
            LEFT JOIN groups g ON g.id = gs.group_id
            ORDER BY COALESCE(a.session_end, a.timestamp) DESC, a.id DESC
            LIMIT ?
            """,
                (limit,),
            ).fetchall()
        else:
            rows = connection.execute(
                """
                SELECT
                    a.id,
                    COALESCE(a.session_start, a.timestamp) AS timestamp,
                    COALESCE(a.timestamp_start, a.session_start, a.timestamp) AS timestamp_start,
                    COALESCE(a.timestamp_end, a.session_end, a.timestamp) AS timestamp_end,
                    COALESCE(a.session_start, a.timestamp) AS session_start,
                    COALESCE(a.session_end, a.timestamp) AS session_end,
                    COALESCE(a.duration_seconds, 0) AS duration_seconds,
                    a.app_name,
                    a.window_title,
                    a.context_title,
                    a.url,
                    a.tab_snapshot,
                    a.tab_urls,
                    a.scroll_position,
                    a.exe_path,
                    gs.group_id,
                    g.name AS group_name
                FROM anchors a
                INNER JOIN group_sessions gs ON gs.session_id = a.id
                LEFT JOIN groups g ON g.id = gs.group_id
                WHERE gs.group_id = ?
                ORDER BY COALESCE(a.session_end, a.timestamp) DESC, a.id DESC
                LIMIT ?
                """,
                (group_id, limit),
            ).fetchall()

    return [Anchor(**dict(row)) for row in rows]


def search_anchors(
    query: str,
    *,
    group_id: int | None = None,
    limit: int = 50,
) -> list[Anchor]:
    normalized = "".join(ch if ch.isalnum() else " " for ch in query)
    tokens = [token.strip() for token in normalized.split() if token.strip()]
    if not tokens:
        return list_anchors(limit=limit, group_id=group_id)
    match_query = " ".join(f"{token}*" for token in tokens)
    with get_connection() as connection:
        sql = """
            SELECT
                a.id,
                COALESCE(a.session_start, a.timestamp) AS timestamp,
                COALESCE(a.timestamp_start, a.session_start, a.timestamp) AS timestamp_start,
                COALESCE(a.timestamp_end, a.session_end, a.timestamp) AS timestamp_end,
                COALESCE(a.session_start, a.timestamp) AS session_start,
                COALESCE(a.session_end, a.timestamp) AS session_end,
                COALESCE(a.duration_seconds, 0) AS duration_seconds,
                a.app_name,
                a.window_title,
                a.context_title,
                a.url,
                a.tab_snapshot,
                a.tab_urls,
                a.scroll_position,
                a.exe_path,
                gs.group_id,
                g.name AS group_name
            FROM sessions_fts
            INNER JOIN anchors a ON a.id = sessions_fts.rowid
            LEFT JOIN group_sessions gs ON gs.session_id = a.id
            LEFT JOIN groups g ON g.id = gs.group_id
        """
        params: list[object] = [match_query]
        where = ["sessions_fts MATCH ?"]
        if group_id is not None:
            where.append("gs.group_id = ?")
            params.append(group_id)
        sql += f" WHERE {' AND '.join(where)}"
        sql += """
            ORDER BY COALESCE(g.name, 'Work Session') ASC,
                     bm25(sessions_fts),
                     COALESCE(a.session_end, a.timestamp) DESC
            LIMIT ?
        """
        params.append(limit)
        rows = connection.execute(sql, tuple(params)).fetchall()
    return [Anchor(**dict(row)) for row in rows]


def list_groups() -> list[Group]:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                g.id,
                g.name,
                g.created_at,
                g.auto_generated,
                COUNT(gs.session_id) AS session_count
            FROM groups g
            LEFT JOIN group_sessions gs ON gs.group_id = g.id
            GROUP BY g.id, g.name, g.created_at, g.auto_generated
            ORDER BY MAX(gs.session_id) DESC, g.created_at DESC
            """
        ).fetchall()
    return [Group(**dict(row)) for row in rows]


def rename_group(group_id: int, name: str) -> None:
    with get_connection() as connection:
        connection.execute(
            "UPDATE groups SET name = ?, auto_generated = 0 WHERE id = ?",
            (name.strip(), group_id),
        )
        _sync_group_sessions_fts(connection, group_id)
        connection.commit()


def move_session_to_group(session_id: int, group_id: int) -> None:
    with get_connection() as connection:
        previous = connection.execute(
            "SELECT group_id FROM group_sessions WHERE session_id = ?",
            (session_id,),
        ).fetchone()
        _attach_session_to_group(connection, session_id=session_id, group_id=group_id)
        if previous is not None:
            _refresh_group_name(connection, int(previous["group_id"]))
        _refresh_group_name(connection, group_id)
        _sync_session_fts(connection, session_id)
        connection.commit()


def merge_groups(source_group_id: int, target_group_id: int) -> None:
    if source_group_id == target_group_id:
        return
    with get_connection() as connection:
        session_ids = connection.execute(
            "SELECT session_id FROM group_sessions WHERE group_id = ?",
            (source_group_id,),
        ).fetchall()
        for row in session_ids:
            _attach_session_to_group(
                connection,
                session_id=row["session_id"],
                group_id=target_group_id,
            )
            _sync_session_fts(connection, row["session_id"])
        connection.execute("DELETE FROM groups WHERE id = ?", (source_group_id,))
        connection.execute(
            "DELETE FROM group_sessions WHERE group_id = ?",
            (source_group_id,),
        )
        _refresh_group_name(connection, target_group_id)
        connection.commit()


def delete_group(group_id: int) -> None:
    with get_connection() as connection:
        rows = connection.execute(
            "SELECT session_id FROM group_sessions WHERE group_id = ?",
            (group_id,),
        ).fetchall()
        connection.execute("DELETE FROM group_sessions WHERE group_id = ?", (group_id,))
        connection.execute("DELETE FROM groups WHERE id = ?", (group_id,))
        for row in rows:
            _sync_session_fts(connection, row["session_id"])
        connection.commit()


def delete_anchor(anchor_id: int) -> None:
    with get_connection() as connection:
        previous = connection.execute(
            "SELECT group_id FROM group_sessions WHERE session_id = ?",
            (anchor_id,),
        ).fetchone()
        connection.execute("DELETE FROM group_sessions WHERE session_id = ?", (anchor_id,))
        connection.execute("DELETE FROM anchors WHERE id = ?", (anchor_id,))
        _delete_session_fts(connection, anchor_id)
        if previous is not None:
            _refresh_group_name(connection, int(previous["group_id"]))
        connection.commit()


def clear_anchors() -> None:
    with get_connection() as connection:
        connection.execute("DELETE FROM sessions_fts")
        connection.execute("DELETE FROM group_sessions")
        connection.execute("DELETE FROM groups")
        connection.execute("DELETE FROM anchors")
        connection.commit()
