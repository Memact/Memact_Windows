from __future__ import annotations

import json
import logging
import math
from collections import defaultdict
from datetime import datetime

from core.database import Event, get_connection
from core.semantic import cosine_similarity, embed_text


logger = logging.getLogger(__name__)

_REFERENCE_THRESHOLD = 0.43
_PASSIVE_INTERACTIONS = {
    "heartbeat",
    "scrolling",
    "typing",
    "legacy_heartbeat",
}


def _parse_timestamp(value: str) -> datetime:
    return datetime.fromisoformat(value)


def _float_vector(raw: str | list[float] | None) -> list[float]:
    if isinstance(raw, list):
        values = raw
    elif isinstance(raw, str):
        try:
            values = json.loads(raw)
        except Exception:
            values = []
    else:
        values = []
    vector: list[float] = []
    for value in values:
        try:
            vector.append(float(value))
        except Exception:
            continue
    return vector


def score_event_dependencies(
    event_ids: list[int] | None = None,
) -> int:
    """
    Compute and persist dependency scores for events.
    Updates event_sessions.dependency_score.
    Returns number of events scored.
    """
    try:
        params: list[object] = []
        where = ""
        if event_ids:
            placeholders = ", ".join("?" for _ in event_ids)
            where = f"WHERE es.event_id IN ({placeholders})"
            params.extend(event_ids)
        with get_connection() as connection:
            rows = connection.execute(
                f"""
                SELECT
                    es.event_id,
                    es.session_id,
                    es.position,
                    e.occurred_at,
                    e.interaction_type,
                    e.searchable_text,
                    e.embedding_json
                FROM event_sessions es
                INNER JOIN events e ON e.id = es.event_id
                {where}
                """,
                tuple(params),
            ).fetchall()
            if not rows:
                return 0

            outbound_rows = connection.execute(
                """
                SELECT source_session_id, COUNT(*) AS count
                FROM session_links
                GROUP BY source_session_id
                """
            ).fetchall()
            outbound_counts = {int(row["source_session_id"]): int(row["count"]) for row in outbound_rows}

            target_rows = connection.execute(
                """
                SELECT
                    sl.source_session_id,
                    s.id AS target_session_id,
                    s.embedding_json
                FROM session_links sl
                INNER JOIN sessions s ON s.id = sl.target_session_id
                """
            ).fetchall()
            target_embeddings: dict[int, list[list[float]]] = defaultdict(list)
            for row in target_rows:
                target_embeddings[int(row["source_session_id"])].append(_float_vector(row["embedding_json"]))

            updates: list[tuple[float, int, int]] = []
            for row in rows:
                session_id = int(row["session_id"])
                event_vector = _float_vector(row["embedding_json"])
                if not event_vector:
                    event_vector = embed_text(str(row["searchable_text"] or ""))
                reference_count = 0
                for target_vector in target_embeddings.get(session_id, []):
                    if cosine_similarity(event_vector, target_vector) >= _REFERENCE_THRESHOLD:
                        reference_count += 1
                interaction_type = str(row["interaction_type"] or "")
                is_passive = interaction_type in _PASSIVE_INTERACTIONS
                if is_passive:
                    dependency_score = 0.0
                else:
                    position = float(row["position"] or 0.5)
                    position_weight = max(0.0, 1.0 - position)
                    foundation_weight = max(0.0, 1.0 - (position * 1.5))
                    outbound = float(outbound_counts.get(session_id, 0))
                    outbound_score = math.log1p(outbound) * foundation_weight
                    reference_score = float(reference_count) * max(0.2, position_weight) * 0.35
                    dependency_score = outbound_score + reference_score
                updates.append((dependency_score, int(row["event_id"]), session_id))

            connection.executemany(
                """
                UPDATE event_sessions
                SET dependency_score = ?
                WHERE event_id = ? AND session_id = ?
                """,
                updates,
            )
            connection.commit()
            return len(updates)
    except Exception:
        logger.exception("Failed to score event dependencies.")
        return 0


def score_sessions() -> int:
    """
    Compute and persist total_score for all sessions.
    Returns number of sessions scored.
    """
    try:
        with get_connection() as connection:
            rows = connection.execute(
                """
                SELECT id, ended_at, event_count
                FROM sessions
                """
            ).fetchall()
            if not rows:
                return 0

            dep_rows = connection.execute(
                """
                SELECT session_id, AVG(dependency_score) AS avg_dependency
                FROM event_sessions
                GROUP BY session_id
                """
            ).fetchall()
            dependency_scores = {
                int(row["session_id"]): float(row["avg_dependency"] or 0.0)
                for row in dep_rows
            }
            max_event_count = max(int(row["event_count"]) for row in rows) or 1
            updated_at = datetime.now().isoformat(sep=" ", timespec="seconds")
            updates: list[tuple[float, float, float, str, int]] = []
            for row in rows:
                session_id = int(row["id"])
                days_since = max((datetime.now() - _parse_timestamp(str(row["ended_at"]))).total_seconds() / 86400.0, 0.0)
                recency_score = math.exp(-days_since / 14.0)
                dependency_score = dependency_scores.get(session_id, 0.0)
                event_count_normalized = float(row["event_count"]) / float(max_event_count)
                total_score = (
                    (recency_score * 0.35)
                    + (dependency_score * 0.45)
                    + (event_count_normalized * 0.20)
                )
                updates.append((recency_score, dependency_score, total_score, updated_at, session_id))

            connection.executemany(
                """
                UPDATE sessions
                SET recency_score = ?,
                    dependency_score = ?,
                    total_score = ?,
                    updated_at = ?
                WHERE id = ?
                """,
                updates,
            )
            connection.commit()
            return len(updates)
    except Exception:
        logger.exception("Failed to score sessions.")
        return 0


def get_foundational_events(
    session_id: int,
    limit: int = 3,
) -> list[Event]:
    """
    Return the most foundational events in a session —
    those with highest dependency scores.
    These are the bottom bricks.
    """
    try:
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
                  AND e.interaction_type NOT IN ('heartbeat', 'scrolling', 'typing', 'legacy_heartbeat')
                ORDER BY es.dependency_score DESC, es.position ASC, e.occurred_at ASC
                LIMIT ?
                """,
                (session_id, limit),
            ).fetchall()
        return [Event(**dict(row)) for row in rows]
    except Exception:
        logger.exception("Failed to load foundational events for session %s", session_id)
        return []


def get_network_health() -> dict:
    """
    Return dependency score distribution for health checking.
    {
      total_events: int,
      passive_events: int,
      active_events: int,
      foundational_events: int,
      leaf_events: int,
      foundational_pct: float,
    }
    """
    try:
        with get_connection() as connection:
            total = int(connection.execute("SELECT COUNT(*) FROM event_sessions").fetchone()[0])

            passive = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM event_sessions es
                    INNER JOIN events e ON e.id = es.event_id
                    WHERE e.interaction_type IN (
                        'heartbeat', 'scrolling', 'typing', 'legacy_heartbeat'
                    )
                    """
                ).fetchone()[0]
            )

            foundational = int(
                connection.execute(
                    "SELECT COUNT(*) FROM event_sessions WHERE dependency_score > 1.0"
                ).fetchone()[0]
            )

            leaf = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM event_sessions es
                    INNER JOIN events e ON e.id = es.event_id
                    WHERE es.dependency_score = 0.0
                      AND e.interaction_type NOT IN (
                          'heartbeat', 'scrolling', 'typing', 'legacy_heartbeat'
                      )
                    """
                ).fetchone()[0]
            )

        active = total - passive
        return {
            "total_events": total,
            "passive_events": passive,
            "active_events": active,
            "foundational_events": foundational,
            "leaf_events": leaf,
            "foundational_pct": round((foundational / max(active, 1)) * 100, 1),
        }
    except Exception:
        logger.exception("Failed to get network health.")
        return {}
