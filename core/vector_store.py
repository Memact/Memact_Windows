from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Iterable

try:
    import chromadb  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    chromadb = None

from core.semantic import embed_text


_COLLECTION_NAME = "memact_events"


def is_available() -> bool:
    return chromadb is not None


def _persist_directory() -> Path:
    return Path.home() / "AppData" / "Local" / "memact" / "chroma"


def _client():
    if chromadb is None:
        raise RuntimeError("ChromaDB is not available.")
    try:
        return chromadb.PersistentClient(
            path=str(_persist_directory()),
            settings=chromadb.Settings(anonymized_telemetry=False),
        )
    except Exception:
        return chromadb.PersistentClient(path=str(_persist_directory()))


def _collection():
    client = _client()
    return client.get_or_create_collection(name=_COLLECTION_NAME)


def _domain_from_url(url: str | None) -> str | None:
    if not url:
        return None
    if "://" not in url:
        return None
    host = url.split("://", 1)[1].split("/", 1)[0]
    return host.removeprefix("www.").lower() if host else None


def _to_epoch(value: str) -> int:
    try:
        return int(datetime.fromisoformat(value).timestamp())
    except Exception:
        return 0


def _target_embedding_dim() -> int:
    return len(embed_text("memact vector probe"))


def upsert_events(events: Iterable) -> None:
    if chromadb is None:
        return
    items = list(events)
    if not items:
        return
    target_dim = _target_embedding_dim()
    ids: list[str] = []
    embeddings: list[list[float]] = []
    metadatas: list[dict[str, object]] = []
    documents: list[str] = []
    for event in items:
        if not getattr(event, "embedding_json", None):
            continue
        try:
            embedding = list(map(float, json.loads(event.embedding_json)))
        except Exception:
            embedding = []
        if len(embedding) != target_dim:
            embedding = embed_text(getattr(event, "searchable_text", "") or "")
        if len(embedding) != target_dim:
            continue
        event_id = int(getattr(event, "id"))
        occurred_at = getattr(event, "occurred_at", "") or ""
        application = getattr(event, "application", "") or ""
        url = getattr(event, "url", None)
        domain = _domain_from_url(url)
        metadata = {
            "event_id": event_id,
            "occurred_at": occurred_at,
            "occurred_at_unix": _to_epoch(occurred_at),
            "application": application,
            "app_name": application.removesuffix(".exe").lower(),
            "domain": domain or "",
            "interaction_type": getattr(event, "interaction_type", "") or "",
            "source": getattr(event, "source", "") or "",
        }
        ids.append(str(event_id))
        embeddings.append(embedding)
        metadatas.append(metadata)
        documents.append(getattr(event, "searchable_text", "") or "")
    if not ids:
        return
    collection = _collection()
    collection.upsert(ids=ids, embeddings=embeddings, metadatas=metadatas, documents=documents)


def ensure_seeded(events: Iterable) -> None:
    if chromadb is None:
        return
    try:
        collection = _collection()
        if collection.count() == 0:
            upsert_events(events)
    except Exception:
        return


def reset_collection() -> None:
    if chromadb is None:
        return
    try:
        client = _client()
        client.delete_collection(name=_COLLECTION_NAME)
    except Exception:
        try:
            collection = _collection()
            collection.delete(where={})
        except Exception:
            return
    try:
        _collection()
    except Exception:
        return


def query_event_ids(
    embedding: list[float],
    *,
    where: dict | None = None,
    limit: int = 120,
) -> list[int]:
    if chromadb is None:
        return []
    try:
        collection = _collection()
        result = collection.query(
            query_embeddings=[embedding],
            n_results=limit,
            where=where,
            include=["ids"],
        )
        ids = result.get("ids", [[]])[0]
        return [int(value) for value in ids if str(value).isdigit()]
    except Exception:
        return []
