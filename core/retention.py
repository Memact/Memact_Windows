from __future__ import annotations

import hashlib
import json
import logging
import queue
import re
import threading
import time
from dataclasses import dataclass
from datetime import datetime
from urllib.parse import urlparse

from core.content_intel import ContentProfile, extract_content_profile, normalize_capture_text
from core.database import Event, get_connection, get_event, get_event_session, list_events_by_ids
from core.keywords import extract_keyphrases
from core.semantic import cosine_similarity, embed_text, normalize_text, tokenize
from core.vector_store import (
    is_available as chroma_available,
    query_memory_chunk_ids,
    reset_memory_chunk_collection,
    upsert_memory_chunks,
)

logger = logging.getLogger(__name__)

_PASSIVE_INTERACTIONS = {"heartbeat", "typing", "legacy_heartbeat"}
_SEARCH_DOMAINS = {
    "google.com",
    "bing.com",
    "duckduckgo.com",
    "search.brave.com",
    "perplexity.ai",
}
_CHAT_DOMAINS = {
    "chatgpt.com",
    "claude.ai",
    "gemini.google.com",
    "copilot.microsoft.com",
    "perplexity.ai",
    "notebooklm.google.com",
    "poe.com",
}
_SOCIAL_DOMAINS = {
    "x.com",
    "twitter.com",
    "reddit.com",
    "news.ycombinator.com",
    "linkedin.com",
    "discord.com",
    "threads.net",
}
_DOCUMENT_EXTENSIONS = {".pdf", ".docx", ".pptx", ".txt", ".md"}
_MODALITY_SOURCE_MAP = {
    "pdf": {"local_document"},
    "doc": {"local_document", "browser_article", "generic_visible_text"},
    "thread": {"social_thread", "chat_response"},
    "post": {"social_thread"},
    "chat": {"chat_response"},
    "answer": {"chat_response"},
    "message": {"chat_response", "social_thread"},
    "read": {"browser_article", "local_document", "generic_visible_text"},
    "saw": {"browser_article", "social_thread", "generic_visible_text"},
    "learned": {"browser_article", "local_document", "chat_response", "generic_visible_text"},
    "video": {"browser_article", "generic_visible_text"},
}
_STOP_CLUE_WORDS = {
    "what", "was", "that", "thing", "i", "read", "saw", "learned", "about", "from",
    "the", "a", "an", "on", "in", "did", "where", "when", "how", "much", "time",
    "spend", "spent", "use", "used", "visit", "visited", "page", "message", "thread",
    "post", "doc", "docs", "pdf", "video", "answer", "recent", "recently", "remember",
    "something",
}
_GENERIC_TOPIC_WORDS = {
    "app",
    "chat",
    "conversation",
    "dashboard",
    "default",
    "demo",
    "discord",
    "docs",
    "document",
    "file",
    "github",
    "home",
    "index",
    "local",
    "memact",
    "message",
    "page",
    "pdf",
    "post",
    "profile",
    "readme",
    "result",
    "results",
    "search",
    "session",
    "settings",
    "site",
    "speed",
    "subtitle",
    "aspect",
    "ratio",
    "normal",
    "flip",
    "screen",
    "player",
    "your",
    "still",
    "loading",
    "downloading",
    "uploading",
    "processing",
    "saved",
    "continue",
    "thread",
    "today",
    "video",
    "viewing",
    "window",
}
_TITLE_NOISE_PATTERNS = (
    re.compile(r"\band\s+\d+\s+more\s+pages?\b", re.IGNORECASE),
    re.compile(r"\bnew\s+inprivate\s+tab\b", re.IGNORECASE),
    re.compile(r"\bnew\s+tab\b", re.IGNORECASE),
    re.compile(r"\bin\s+private\b", re.IGNORECASE),
    re.compile(r"\bmicrosoft\s+edge\b", re.IGNORECASE),
    re.compile(r"\bpersonal\b", re.IGNORECASE),
    re.compile(r"\binprivate\b", re.IGNORECASE),
)
_URLISH_PATTERN = re.compile(r"https?://\S+|www\.\S+", re.IGNORECASE)
_WORD_BOUNDARY_PATTERN = re.compile(r"(?<=[a-z])(?=[A-Z])|(?<=[A-Za-z])(?=\d)|(?<=\d)(?=[A-Za-z])")

_PROMOTION_QUEUE: queue.Queue[int] = queue.Queue()
_RUNTIME_STARTED = False
_RUNTIME_LOCK = threading.Lock()
_PROMOTION_THREAD: threading.Thread | None = None
_BACKFILL_THREAD: threading.Thread | None = None
_RETENTION_PROJECTION_VERSION = "2"


@dataclass(slots=True)
class RetainedMemory:
    id: int
    source_type: str
    source_app: str
    source_domain: str | None
    title: str
    canonical_text: str
    summary_snippet: str
    keyphrases: list[str]
    embedding: list[float]
    quality_score: float
    captured_at: str
    first_event_id: int
    last_event_id: int
    session_id: int | None
    identity_key: str


@dataclass(slots=True)
class MemoryChunk:
    id: int
    memory_id: int
    chunk_text: str
    chunk_order: int
    lexical_text: str
    embedding: list[float]
    quality_score: float


@dataclass(slots=True)
class MemoryCandidate:
    memory: RetainedMemory
    best_chunk: str
    best_chunk_id: int
    score: float
    semantic_score: float
    lexical_score: float
    source_score: float
    modality_score: float
    time_score: float
    event: Event | None


class BaseSourceAdapter:
    source_type = "generic_visible_text"

    def matches(self, event: Event, profile: ContentProfile) -> bool:
        return False

    def title(self, event: Event, profile: ContentProfile) -> str:
        return _select_title_candidate(event, profile, prefer_raw_title=True)

    def canonical_text(self, event: Event, profile: ContentProfile) -> str:
        text = profile.cleaned_text or normalize_capture_text(
            event.full_text or event.content_text or event.window_title,
            preserve_paragraphs=True,
            max_chars=8000,
        )
        return text or ""

    def summary_snippet(self, event: Event, profile: ContentProfile) -> str:
        return _select_summary_candidate(profile, self.title(event, profile))

    def chunk_passages(self, event: Event, profile: ContentProfile) -> list[str]:
        passages = _clean_passages(profile.passages, self.title(event, profile))
        if passages:
            return passages[:6]
        snippet = self.summary_snippet(event, profile)
        return [snippet] if snippet else []

    def quality_bonus(self, event: Event, profile: ContentProfile) -> float:
        return 0.0

    def minimum_quality(self, event: Event, profile: ContentProfile) -> float:
        return 0.33


class BrowserSearchResultsAdapter(BaseSourceAdapter):
    source_type = "search_results"

    def matches(self, event: Event, profile: ContentProfile) -> bool:
        domain = _domain_from_url(event.url)
        url = str(event.url or "")
        title = str(event.window_title or "").casefold()
        return bool(
            domain in _SEARCH_DOMAINS
            and ("?q=" in url or "/search" in url or "search results" in title)
        )

    def quality_bonus(self, event: Event, profile: ContentProfile) -> float:
        return -0.14

    def minimum_quality(self, event: Event, profile: ContentProfile) -> float:
        return 0.62

    def title(self, event: Event, profile: ContentProfile) -> str:
        return _select_title_candidate(event, profile, prefer_raw_title=False)


class BrowserChatAdapter(BaseSourceAdapter):
    source_type = "chat_response"

    def matches(self, event: Event, profile: ContentProfile) -> bool:
        domain = _domain_from_url(event.url)
        title = str(event.window_title or "").casefold()
        return bool(
            domain in _CHAT_DOMAINS
            or any(term in title for term in ("chatgpt", "claude", "conversation", "gemini"))
        )

    def quality_bonus(self, event: Event, profile: ContentProfile) -> float:
        return 0.12 if len(profile.cleaned_text) >= 180 else 0.02

    def minimum_quality(self, event: Event, profile: ContentProfile) -> float:
        return 0.28

    def title(self, event: Event, profile: ContentProfile) -> str:
        return _select_title_candidate(event, profile, prefer_raw_title=False)


class BrowserSocialAdapter(BaseSourceAdapter):
    source_type = "social_thread"

    def matches(self, event: Event, profile: ContentProfile) -> bool:
        domain = _domain_from_url(event.url)
        return bool(domain in _SOCIAL_DOMAINS)

    def quality_bonus(self, event: Event, profile: ContentProfile) -> float:
        return 0.08 if len(profile.passages) >= 2 else 0.01

    def minimum_quality(self, event: Event, profile: ContentProfile) -> float:
        return 0.3

    def title(self, event: Event, profile: ContentProfile) -> str:
        return _select_title_candidate(event, profile, prefer_raw_title=False)


class LocalDocumentAdapter(BaseSourceAdapter):
    source_type = "local_document"

    def matches(self, event: Event, profile: ContentProfile) -> bool:
        url = str(event.url or "")
        title = str(event.window_title or "")
        path_text = f"{url} {title}".casefold()
        return url.startswith("file://") or any(ext in path_text for ext in _DOCUMENT_EXTENSIONS)

    def quality_bonus(self, event: Event, profile: ContentProfile) -> float:
        return 0.14 if len(profile.cleaned_text) >= 200 else 0.06

    def minimum_quality(self, event: Event, profile: ContentProfile) -> float:
        return 0.24


class BrowserArticleAdapter(BaseSourceAdapter):
    source_type = "browser_article"

    def matches(self, event: Event, profile: ContentProfile) -> bool:
        domain = _domain_from_url(event.url) or ""
        title = str(event.window_title or "").casefold()
        return bool(
            len(profile.passages) >= 2
            or len(profile.headings) >= 1
            or any(marker in domain for marker in ("medium.com", "dev.to", "substack.com", "github.com", "docs", "documentation"))
            or any(marker in title for marker in ("guide", "tutorial", "documentation", "article"))
        )

    def quality_bonus(self, event: Event, profile: ContentProfile) -> float:
        return 0.1 if len(profile.passages) >= 2 else 0.03

    def minimum_quality(self, event: Event, profile: ContentProfile) -> float:
        return 0.3

    def title(self, event: Event, profile: ContentProfile) -> str:
        return _select_title_candidate(event, profile, prefer_raw_title=False)


class GenericVisibleTextAdapter(BaseSourceAdapter):
    source_type = "generic_visible_text"

    def matches(self, event: Event, profile: ContentProfile) -> bool:
        return True

    def quality_bonus(self, event: Event, profile: ContentProfile) -> float:
        return -0.08

    def minimum_quality(self, event: Event, profile: ContentProfile) -> float:
        return 0.42


_ADAPTERS: tuple[BaseSourceAdapter, ...] = (
    LocalDocumentAdapter(),
    BrowserChatAdapter(),
    BrowserSocialAdapter(),
    BrowserSearchResultsAdapter(),
    BrowserArticleAdapter(),
    GenericVisibleTextAdapter(),
)


def _friendly_app_name(application: str | None) -> str:
    text = str(application or "").strip()
    if not text:
        return "Unknown app"
    return text.removesuffix(".exe").replace("_", " ").title()


def _domain_from_url(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme == "file":
        return "local file"
    host = parsed.netloc.removeprefix("www.").strip().lower()
    return host or None


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


def _humanize_text(value: str | None, *, max_chars: int | None = None) -> str:
    text = str(value or "").replace("\u200b", " ").replace("›", " / ").replace("»", " / ")
    text = _URLISH_PATTERN.sub(" ", text)
    text = _WORD_BOUNDARY_PATTERN.sub(" ", text)
    for pattern in _TITLE_NOISE_PATTERNS:
        text = pattern.sub(" ", text)
    text = re.sub(r"\s*[-|:]+\s*", " - ", text)
    text = re.sub(r"\s*[\\/]\s*", " / ", text)
    text = re.sub(r"\s+", " ", text)
    text = re.sub(r"^[^\w]+", "", text)
    text = text.strip(" -|/:")
    return normalize_capture_text(text, preserve_paragraphs=False, max_chars=max_chars)


def _title_looks_noisy(text: str, *, source_domain: str | None, source_app: str | None) -> bool:
    lowered = normalize_text(text)
    if not lowered:
        return True
    tokens = [token for token in tokenize(text) if len(token) >= 2]
    if len(tokens) < 2:
        return True
    if source_domain and lowered == normalize_text(source_domain):
        return True
    if source_app and lowered == normalize_text(source_app):
        return True
    if any(pattern.search(text) for pattern in _TITLE_NOISE_PATTERNS):
        return True
    if lowered in {"browser session", "edge browser session", "search results", "new tab"}:
        return True
    if text.startswith("?"):
        return True
    if text.count(" - ") >= 2 and len(tokens) <= 8:
        return True
    generic_hits = sum(1 for token in tokens if token in _GENERIC_TOPIC_WORDS)
    if generic_hits >= max(2, len(tokens)):
        return True
    if generic_hits >= 2 and len(tokens) <= 6:
        return True
    if text.count(" - ") >= 3:
        return True
    return False


def _select_title_candidate(
    event: Event,
    profile: ContentProfile,
    *,
    prefer_raw_title: bool,
) -> str:
    source_domain = _domain_from_url(event.url)
    source_app = _friendly_app_name(event.application)
    candidates: list[str] = []
    if prefer_raw_title:
        candidates.append(str(event.window_title or ""))
    candidates.extend(profile.headings[:3])
    candidates.extend(profile.passages[:3])
    if profile.snippet:
        candidates.append(profile.snippet)

    fallback = ""
    seen: set[str] = set()
    for candidate in candidates:
        cleaned = _humanize_text(candidate, max_chars=140)
        if not cleaned:
            continue
        key = cleaned.casefold()
        if key in seen:
            continue
        seen.add(key)
        if not fallback:
            fallback = cleaned
        if _title_looks_noisy(cleaned, source_domain=source_domain, source_app=source_app):
            continue
        if len(cleaned) > 96:
            cleaned = cleaned[:93].rstrip(" -,:;") + "..."
        return cleaned

    if fallback:
        if len(fallback) > 96:
            fallback = fallback[:93].rstrip(" -,:;") + "..."
        return fallback
    return source_domain or source_app


def _select_summary_candidate(profile: ContentProfile, title: str) -> str:
    title_key = normalize_text(title)
    candidates = list(profile.passages[:4])
    if profile.snippet:
        candidates.append(profile.snippet)
    if profile.cleaned_text:
        candidates.append(profile.cleaned_text[:360])

    for candidate in candidates:
        cleaned = _humanize_text(candidate, max_chars=240)
        if not cleaned:
            continue
        normalized = normalize_text(cleaned)
        if title_key and (normalized == title_key or normalized.startswith(title_key)):
            continue
        return cleaned
    return _humanize_text(profile.snippet or title, max_chars=240)


def _clean_passages(passages: list[str], title: str) -> list[str]:
    cleaned_passages: list[str] = []
    seen: set[str] = set()
    title_key = normalize_text(title)
    for passage in passages:
        cleaned = _humanize_text(passage, max_chars=420)
        if not cleaned:
            continue
        key = normalize_text(cleaned)
        if not key or key in seen:
            continue
        if title_key and key == title_key:
            continue
        seen.add(key)
        cleaned_passages.append(cleaned)
        if len(cleaned_passages) >= 6:
            break
    return cleaned_passages


def _encode_json_list(values: list[str]) -> str | None:
    cleaned = [str(value).strip() for value in values if str(value).strip()]
    if not cleaned:
        return None
    return json.dumps(cleaned, ensure_ascii=True)


def _timestamp(value: str | None) -> str:
    return str(value or datetime.now().isoformat(sep=" ", timespec="seconds"))


def _choose_adapter(event: Event, profile: ContentProfile) -> BaseSourceAdapter:
    for adapter in _ADAPTERS:
        if adapter.matches(event, profile):
            return adapter
    return GenericVisibleTextAdapter()

def _retention_quality(event: Event, profile: ContentProfile, adapter: BaseSourceAdapter) -> float:
    cleaned = profile.cleaned_text or ""
    tokens = tokenize(cleaned)
    if not tokens:
        return 0.0
    unique_ratio = len(set(tokens)) / max(len(tokens), 1)
    text_len = len(cleaned)
    passage_count = len(profile.passages)
    heading_count = len(profile.headings)
    source_bonus = adapter.quality_bonus(event, profile)
    full_text_bonus = 0.08 if (event.full_text or "").strip() else 0.0
    passive_penalty = 0.05 if event.interaction_type in _PASSIVE_INTERACTIONS else 0.0
    urlish_hits = len(_URLISH_PATTERN.findall(cleaned)) + cleaned.count(" / ") + cleaned.count("›")
    repetition_penalty = 0.14 if unique_ratio < 0.42 and text_len > 220 else 0.0
    score = 0.0
    score += min(text_len / 1200.0, 1.15) * 0.42
    score += min(passage_count / 4.0, 1.0) * 0.22
    score += min(heading_count / 2.0, 1.0) * 0.08
    score += unique_ratio * 0.18
    score += full_text_bonus
    score += source_bonus
    score -= min(urlish_hits * 0.035, 0.24)
    score -= repetition_penalty
    score -= passive_penalty
    return max(0.0, min(score, 1.5))


def _normalized_title(value: str) -> str:
    title = normalize_text(value)
    if not title:
        return "untitled"
    return title[:120]


def _build_identity_key(source_type: str, source_domain: str | None, title: str, snippet: str) -> str:
    parts = [source_type, source_domain or "", _normalized_title(title)]
    if len(parts[-1]) < 10:
        parts.append(normalize_text(snippet)[:180])
    digest = hashlib.sha1("|".join(parts).encode("utf-8")).hexdigest()
    return digest


def ensure_retention_schema() -> None:
    with get_connection() as connection:
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS retained_memories (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                identity_key TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_app TEXT NOT NULL,
                source_domain TEXT,
                title TEXT NOT NULL,
                canonical_text TEXT NOT NULL,
                summary_snippet TEXT NOT NULL,
                keyphrases_json TEXT,
                embedding_json TEXT NOT NULL DEFAULT '[]',
                quality_score REAL NOT NULL DEFAULT 0.0,
                captured_at TEXT NOT NULL,
                first_event_id INTEGER NOT NULL,
                last_event_id INTEGER NOT NULL,
                session_id INTEGER,
                FOREIGN KEY (first_event_id) REFERENCES events(id),
                FOREIGN KEY (last_event_id) REFERENCES events(id),
                FOREIGN KEY (session_id) REFERENCES sessions(id)
            )
            """
        )
        connection.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_retained_memories_identity ON retained_memories(identity_key)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_retained_memories_captured_at ON retained_memories(captured_at DESC)")
        connection.execute("CREATE INDEX IF NOT EXISTS idx_retained_memories_quality ON retained_memories(quality_score DESC)")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS memory_chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                memory_id INTEGER NOT NULL,
                chunk_text TEXT NOT NULL,
                chunk_order INTEGER NOT NULL DEFAULT 0,
                lexical_text TEXT NOT NULL,
                embedding_json TEXT NOT NULL DEFAULT '[]',
                quality_score REAL NOT NULL DEFAULT 0.0,
                FOREIGN KEY (memory_id) REFERENCES retained_memories(id)
            )
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_memory_chunks_memory_id ON memory_chunks(memory_id)")
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS memory_events (
                memory_id INTEGER NOT NULL,
                event_id INTEGER NOT NULL,
                PRIMARY KEY (memory_id, event_id),
                FOREIGN KEY (memory_id) REFERENCES retained_memories(id),
                FOREIGN KEY (event_id) REFERENCES events(id)
            )
            """
        )
        connection.execute("CREATE INDEX IF NOT EXISTS idx_memory_events_event_id ON memory_events(event_id)")
        connection.execute(
            """
            CREATE VIRTUAL TABLE IF NOT EXISTS memory_chunks_fts
            USING fts5(
                chunk_id UNINDEXED,
                memory_id UNINDEXED,
                chunk_text,
                lexical_text,
                title,
                source_label
            )
            """
        )
        connection.execute(
            """
            CREATE TABLE IF NOT EXISTS memory_backfill_state (
                name TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at TEXT NOT NULL
            )
            """
        )
        connection.commit()


def _sync_memory_chunk_fts(connection, chunk_id: int) -> None:
    connection.execute("DELETE FROM memory_chunks_fts WHERE rowid = ?", (chunk_id,))
    row = connection.execute(
        """
        SELECT mc.id, mc.memory_id, mc.chunk_text, mc.lexical_text, rm.title,
               COALESCE(rm.source_domain, rm.source_app, '') AS source_label
        FROM memory_chunks mc
        INNER JOIN retained_memories rm ON rm.id = mc.memory_id
        WHERE mc.id = ?
        """,
        (chunk_id,),
    ).fetchone()
    if row is None:
        return
    connection.execute(
        """
        INSERT INTO memory_chunks_fts(rowid, chunk_id, memory_id, chunk_text, lexical_text, title, source_label)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            int(row["id"]),
            int(row["id"]),
            int(row["memory_id"]),
            str(row["chunk_text"] or ""),
            str(row["lexical_text"] or ""),
            str(row["title"] or ""),
            str(row["source_label"] or ""),
        ),
    )


def _rebuild_memory_chunks(connection, memory_id: int, title: str, source_label: str, passages: list[str]) -> list[int]:
    existing = connection.execute("SELECT id FROM memory_chunks WHERE memory_id = ?", (memory_id,)).fetchall()
    for row in existing:
        connection.execute("DELETE FROM memory_chunks_fts WHERE rowid = ?", (int(row["id"]),))
    connection.execute("DELETE FROM memory_chunks WHERE memory_id = ?", (memory_id,))

    chunk_ids: list[int] = []
    for index, passage in enumerate(passages):
        cleaned = normalize_capture_text(passage, preserve_paragraphs=False, max_chars=700)
        if not cleaned:
            continue
        lexical_text = f"{title} {source_label} {cleaned}".strip()
        embedding_json = json.dumps(embed_text(lexical_text), ensure_ascii=True)
        cursor = connection.execute(
            """
            INSERT INTO memory_chunks (memory_id, chunk_text, chunk_order, lexical_text, embedding_json, quality_score)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            (int(memory_id), cleaned, int(index), lexical_text, embedding_json, max(0.2, 1.0 - (index * 0.08))),
        )
        chunk_id = int(cursor.lastrowid)
        _sync_memory_chunk_fts(connection, chunk_id)
        chunk_ids.append(chunk_id)
    return chunk_ids


def _memory_keyphrases(event: Event, canonical_text: str) -> list[str]:
    phrases = list(event.keyphrases)
    if phrases:
        return phrases[:10]
    return extract_keyphrases(canonical_text[:4000])[:10]


def _upsert_retained_memory(event: Event, adapter: BaseSourceAdapter, profile: ContentProfile) -> int | None:
    canonical_text = adapter.canonical_text(event, profile)
    if not canonical_text:
        return None
    quality = _retention_quality(event, profile, adapter)
    if quality < adapter.minimum_quality(event, profile):
        return None

    title = normalize_capture_text(adapter.title(event, profile), preserve_paragraphs=False, max_chars=180) or _friendly_app_name(event.application)
    snippet = normalize_capture_text(adapter.summary_snippet(event, profile), preserve_paragraphs=False, max_chars=260) or title
    source_domain = _domain_from_url(event.url)
    source_app = _friendly_app_name(event.application)
    keyphrases = _memory_keyphrases(event, canonical_text)
    embedding_text = " ".join(part for part in [title, source_domain or source_app, " ".join(keyphrases[:6]), snippet, canonical_text[:1800]] if part)
    embedding_json = json.dumps(embed_text(embedding_text), ensure_ascii=True)
    captured_at = _timestamp(event.occurred_at)
    session_id = get_event_session(int(event.id))
    identity_key = _build_identity_key(adapter.source_type, source_domain, title, snippet)
    passages = adapter.chunk_passages(event, profile) or [snippet]

    with get_connection() as connection:
        row = connection.execute(
            "SELECT id, first_event_id, last_event_id, session_id, keyphrases_json, canonical_text, summary_snippet, quality_score FROM retained_memories WHERE identity_key = ?",
            (identity_key,),
        ).fetchone()
        if row is None:
            cursor = connection.execute(
                """
                INSERT INTO retained_memories (
                    identity_key, source_type, source_app, source_domain, title, canonical_text,
                    summary_snippet, keyphrases_json, embedding_json, quality_score, captured_at,
                    first_event_id, last_event_id, session_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    identity_key, adapter.source_type, source_app, source_domain, title, canonical_text,
                    snippet, _encode_json_list(keyphrases), embedding_json, float(quality), captured_at,
                    int(event.id), int(event.id), session_id,
                ),
            )
            memory_id = int(cursor.lastrowid)
        else:
            memory_id = int(row["id"])
            merged_keyphrases = _decode_json_list(row["keyphrases_json"]) + keyphrases
            deduped_keyphrases: list[str] = []
            seen_keys: set[str] = set()
            for phrase in merged_keyphrases:
                key = phrase.casefold()
                if key in seen_keys:
                    continue
                seen_keys.add(key)
                deduped_keyphrases.append(phrase)
                if len(deduped_keyphrases) >= 12:
                    break
            existing_text = str(row["canonical_text"] or "")
            existing_snippet = str(row["summary_snippet"] or "")
            connection.execute(
                """
                UPDATE retained_memories
                SET source_app = ?, source_domain = ?, title = ?, canonical_text = ?, summary_snippet = ?,
                    keyphrases_json = ?, embedding_json = ?, quality_score = ?, captured_at = ?,
                    first_event_id = ?, last_event_id = ?, session_id = COALESCE(?, session_id)
                WHERE id = ?
                """,
                (
                    source_app,
                    source_domain,
                    title,
                    canonical_text if len(canonical_text) >= len(existing_text) else existing_text,
                    snippet if len(snippet) >= len(existing_snippet) else existing_snippet,
                    _encode_json_list(deduped_keyphrases),
                    embedding_json,
                    max(float(row["quality_score"] or 0.0), float(quality)),
                    captured_at,
                    min(int(row["first_event_id"]), int(event.id)),
                    max(int(row["last_event_id"]), int(event.id)),
                    session_id,
                    memory_id,
                ),
            )
        connection.execute("INSERT OR IGNORE INTO memory_events (memory_id, event_id) VALUES (?, ?)", (memory_id, int(event.id)))
        chunk_ids = _rebuild_memory_chunks(connection, memory_id, title, source_domain or source_app, passages[:6])
        connection.commit()

    if chunk_ids and chroma_available():
        try:
            upsert_memory_chunks(list_memory_chunks_by_ids(chunk_ids))
        except Exception:
            logger.exception("Failed to upsert retained-memory chunks to vector store.")
    return memory_id


def promote_event_to_memory(event_id: int) -> int | None:
    ensure_retention_schema()
    event = get_event(int(event_id))
    if event is None:
        return None
    if event.interaction_type in _PASSIVE_INTERACTIONS and not (event.full_text or "").strip():
        return None
    profile = extract_content_profile(
        event.full_text or event.content_text or event.window_title,
        title=event.window_title,
        app_name=event.application,
        url=event.url,
    )
    adapter = _choose_adapter(event, profile)
    try:
        return _upsert_retained_memory(event, adapter, profile)
    except Exception:
        logger.exception("Failed to promote event %s into retained memory.", event_id)
        return None


def _backfill_state(name: str, default: str = "0") -> str:
    ensure_retention_schema()
    with get_connection() as connection:
        row = connection.execute("SELECT value FROM memory_backfill_state WHERE name = ?", (name,)).fetchone()
        return str(row["value"]) if row is not None else default


def _set_backfill_state(name: str, value: str) -> None:
    timestamp = _timestamp(None)
    with get_connection() as connection:
        connection.execute(
            """
            INSERT INTO memory_backfill_state(name, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(name) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (name, str(value), timestamp),
        )
        connection.commit()


def _reset_retention_projection() -> None:
    with get_connection() as connection:
        connection.execute("DELETE FROM memory_events")
        connection.execute("DELETE FROM memory_chunks_fts")
        connection.execute("DELETE FROM memory_chunks")
        connection.execute("DELETE FROM retained_memories")
        connection.execute("DELETE FROM memory_backfill_state WHERE name IN ('last_event_id', 'status', 'completed_at')")
        connection.commit()
    if chroma_available():
        try:
            reset_memory_chunk_collection()
        except Exception:
            logger.exception("Failed to reset retained-memory chunk collection.")


def _next_backfill_batch(after_event_id: int, limit: int = 24) -> list[int]:
    ensure_retention_schema()
    with get_connection() as connection:
        rows = connection.execute("SELECT id FROM events WHERE id > ? ORDER BY id ASC LIMIT ?", (int(after_event_id), int(limit))).fetchall()
    return [int(row["id"]) for row in rows]


def _run_backfill() -> None:
    _set_backfill_state("status", "running")
    last_processed = int(_backfill_state("last_event_id", "0") or 0)
    while True:
        batch = _next_backfill_batch(last_processed)
        if not batch:
            _set_backfill_state("status", "complete")
            _set_backfill_state("completed_at", _timestamp(None))
            return
        for event_id in batch:
            try:
                promote_event_to_memory(event_id)
            except Exception:
                logger.exception("Memory backfill failed on event %s.", event_id)
            last_processed = event_id
            _set_backfill_state("last_event_id", str(last_processed))
        time.sleep(0.12)


def _run_promotion_worker() -> None:
    while True:
        try:
            event_id = _PROMOTION_QUEUE.get(timeout=1.0)
        except queue.Empty:
            continue
        try:
            promote_event_to_memory(int(event_id))
        except Exception:
            logger.exception("Retention promotion worker failed for event %s.", event_id)
        finally:
            _PROMOTION_QUEUE.task_done()


def start_retention_runtime() -> None:
    global _RUNTIME_STARTED, _PROMOTION_THREAD, _BACKFILL_THREAD
    with _RUNTIME_LOCK:
        if _RUNTIME_STARTED:
            return
        ensure_retention_schema()
        current_version = _backfill_state("projection_version", "")
        if current_version != _RETENTION_PROJECTION_VERSION:
            _reset_retention_projection()
            _set_backfill_state("projection_version", _RETENTION_PROJECTION_VERSION)
            _set_backfill_state("last_event_id", "0")
            _set_backfill_state("status", "pending")
        _PROMOTION_THREAD = threading.Thread(
            target=_run_promotion_worker,
            name="memact-retention-promotion",
            daemon=True,
        )
        _PROMOTION_THREAD.start()
        _BACKFILL_THREAD = threading.Thread(
            target=_run_backfill,
            name="memact-retention-backfill",
            daemon=True,
        )
        _BACKFILL_THREAD.start()
        _RUNTIME_STARTED = True


def schedule_memory_promotion(event_id: int | None) -> None:
    if not event_id:
        return
    start_retention_runtime()
    try:
        _PROMOTION_QUEUE.put_nowait(int(event_id))
    except Exception:
        logger.exception("Failed to queue retained-memory promotion for event %s.", event_id)


def retention_runtime_state() -> dict:
    return {
        "started": _RUNTIME_STARTED,
        "promotion_queue_size": _PROMOTION_QUEUE.qsize(),
        "promotion_alive": bool(_PROMOTION_THREAD and _PROMOTION_THREAD.is_alive()),
        "backfill_alive": bool(_BACKFILL_THREAD and _BACKFILL_THREAD.is_alive()),
        "backfill_status": _backfill_state("status", "idle"),
        "backfill_last_event_id": int(_backfill_state("last_event_id", "0") or 0),
    }


def list_memory_chunks_by_ids(chunk_ids: list[int]) -> list[MemoryChunk]:
    if not chunk_ids:
        return []
    placeholders = ", ".join("?" for _ in chunk_ids)
    with get_connection() as connection:
        rows = connection.execute(
            f"""
            SELECT id, memory_id, chunk_text, chunk_order, lexical_text, embedding_json, quality_score
            FROM memory_chunks
            WHERE id IN ({placeholders})
            """,
            tuple(int(chunk_id) for chunk_id in chunk_ids),
        ).fetchall()
    by_id: dict[int, MemoryChunk] = {}
    for row in rows:
        chunk_id = int(row["id"])
        by_id[chunk_id] = MemoryChunk(
            id=chunk_id,
            memory_id=int(row["memory_id"]),
            chunk_text=str(row["chunk_text"] or ""),
            chunk_order=int(row["chunk_order"] or 0),
            lexical_text=str(row["lexical_text"] or ""),
            embedding=_decode_json_vector(row["embedding_json"]),
            quality_score=float(row["quality_score"] or 0.0),
        )
    return [by_id[chunk_id] for chunk_id in chunk_ids if chunk_id in by_id]


def _list_retained_memories_by_ids(memory_ids: list[int]) -> dict[int, RetainedMemory]:
    if not memory_ids:
        return {}
    placeholders = ", ".join("?" for _ in memory_ids)
    with get_connection() as connection:
        rows = connection.execute(
            f"""
            SELECT
                id,
                source_type,
                source_app,
                source_domain,
                title,
                canonical_text,
                summary_snippet,
                keyphrases_json,
                embedding_json,
                quality_score,
                captured_at,
                first_event_id,
                last_event_id,
                session_id,
                identity_key
            FROM retained_memories
            WHERE id IN ({placeholders})
            """,
            tuple(int(memory_id) for memory_id in memory_ids),
        ).fetchall()
    memories: dict[int, RetainedMemory] = {}
    for row in rows:
        memory_id = int(row["id"])
        memories[memory_id] = RetainedMemory(
            id=memory_id,
            source_type=str(row["source_type"] or ""),
            source_app=str(row["source_app"] or ""),
            source_domain=str(row["source_domain"] or "") or None,
            title=str(row["title"] or ""),
            canonical_text=str(row["canonical_text"] or ""),
            summary_snippet=str(row["summary_snippet"] or ""),
            keyphrases=_decode_json_list(row["keyphrases_json"]),
            embedding=_decode_json_vector(row["embedding_json"]),
            quality_score=float(row["quality_score"] or 0.0),
            captured_at=str(row["captured_at"] or ""),
            first_event_id=int(row["first_event_id"]),
            last_event_id=int(row["last_event_id"]),
            session_id=int(row["session_id"]) if row["session_id"] is not None else None,
            identity_key=str(row["identity_key"] or ""),
        )
    return memories


def _meaningful_query_tokens(query_text: str) -> list[str]:
    return [token for token in tokenize(query_text) if token not in _STOP_CLUE_WORDS and len(token) >= 3]


def _topic_is_specific(text: str | None) -> bool:
    tokens = [token for token in tokenize(text or "") if len(token) >= 3]
    if not tokens:
        return False
    if len(tokens) == 1 and tokens[0] in _GENERIC_TOPIC_WORDS:
        return False
    if all(token in _GENERIC_TOPIC_WORDS for token in tokens):
        return False
    return True


def _fts_query(query_text: str) -> str | None:
    tokens = _meaningful_query_tokens(query_text)
    if not tokens:
        return None
    return " ".join(f"{token}*" for token in tokens[:8])


def _lexical_overlap_score(query_text: str, text: str) -> float:
    query_tokens = _meaningful_query_tokens(query_text)
    if not query_tokens:
        return 0.0
    text_tokens = set(tokenize(text))
    if not text_tokens:
        return 0.0
    overlap = sum(1 for token in query_tokens if token in text_tokens)
    phrase_bonus = 0.16 if normalize_text(query_text) and normalize_text(query_text) in normalize_text(text) else 0.0
    return min((overlap / max(len(query_tokens), 1)) + phrase_bonus, 1.0)


def _memory_noise_penalty(memory: RetainedMemory, chunk_text: str) -> float:
    combined = f"{memory.title} {chunk_text}"
    lowered = combined.casefold()
    penalty = 0.0
    if any(pattern.search(combined) for pattern in _TITLE_NOISE_PATTERNS):
        penalty += 0.12
    penalty += min(len(_URLISH_PATTERN.findall(combined)) * 0.05, 0.2)
    if lowered.count(" / ") >= 3:
        penalty += 0.08
    if memory.source_type.casefold() == "search_results":
        penalty += 0.08
    return penalty


def _time_score(captured_at: str, time_text: str | None) -> float:
    hint = str(time_text or "").casefold()
    if not hint:
        return 0.0
    try:
        timestamp = datetime.fromisoformat(captured_at)
    except Exception:
        return 0.0
    today = datetime.now().date()
    if "today" in hint:
        return 0.08 if timestamp.date() == today else 0.0
    if "yesterday" in hint:
        return 0.08 if timestamp.date() == (today.fromordinal(today.toordinal() - 1)) else 0.0
    if "recent" in hint:
        age = (datetime.now() - timestamp).total_seconds()
        if age <= 3 * 24 * 60 * 60:
            return 0.05
    return 0.0


def _source_score(memory: RetainedMemory, source_hints: list[str]) -> float:
    if not source_hints:
        return 0.0
    domain = (memory.source_domain or "").casefold()
    app = memory.source_app.casefold()
    source_type = memory.source_type.casefold()
    score = 0.0
    for hint in source_hints:
        lowered = hint.casefold()
        if not lowered:
            continue
        if domain and (domain == lowered or domain.endswith(f".{lowered}") or lowered in domain):
            score = max(score, 0.26)
        elif app and lowered in app:
            score = max(score, 0.2)
        elif lowered in source_type:
            score = max(score, 0.16)
    return score


def _modality_score(memory: RetainedMemory, modality_hints: list[str]) -> float:
    if not modality_hints:
        return 0.0
    source_type = memory.source_type.casefold()
    score = 0.0
    for modality in modality_hints:
        supported = _MODALITY_SOURCE_MAP.get(modality.casefold(), set())
        if source_type in supported:
            score = max(score, 0.16)
    return score


def _source_type_prior(memory: RetainedMemory) -> float:
    source_type = memory.source_type.casefold()
    priors = {
        "chat_response": 0.1,
        "local_document": 0.08,
        "browser_article": 0.06,
        "social_thread": 0.03,
        "search_results": -0.2,
        "generic_visible_text": -0.1,
    }
    return priors.get(source_type, 0.0)


def _chunk_rows_by_ids(chunk_ids: list[int]) -> list[dict]:
    if not chunk_ids:
        return []
    placeholders = ", ".join("?" for _ in chunk_ids)
    with get_connection() as connection:
        rows = connection.execute(
            f"""
            SELECT
                mc.id,
                mc.memory_id,
                mc.chunk_text,
                mc.chunk_order,
                mc.lexical_text,
                mc.embedding_json,
                mc.quality_score
            FROM memory_chunks mc
            WHERE mc.id IN ({placeholders})
            """,
            tuple(int(chunk_id) for chunk_id in chunk_ids),
        ).fetchall()
    by_id = {int(row["id"]): dict(row) for row in rows}
    return [by_id[chunk_id] for chunk_id in chunk_ids if chunk_id in by_id]


def _lexical_memory_chunk_rows(query_text: str, *, limit: int = 40) -> list[dict]:
    match_query = _fts_query(query_text)
    if not match_query:
        return []
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                mc.id,
                mc.memory_id,
                mc.chunk_text,
                mc.chunk_order,
                mc.lexical_text,
                mc.embedding_json,
                mc.quality_score
            FROM memory_chunks_fts fts
            INNER JOIN memory_chunks mc ON mc.id = fts.chunk_id
            WHERE memory_chunks_fts MATCH ?
            ORDER BY bm25(memory_chunks_fts)
            LIMIT ?
            """,
            (match_query, int(limit)),
        ).fetchall()
    return [dict(row) for row in rows]


def _fallback_memory_rows(limit: int = 24) -> list[dict]:
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT
                mc.id,
                mc.memory_id,
                mc.chunk_text,
                mc.chunk_order,
                mc.lexical_text,
                mc.embedding_json,
                mc.quality_score
            FROM memory_chunks mc
            INNER JOIN retained_memories rm ON rm.id = mc.memory_id
            ORDER BY rm.quality_score DESC, rm.captured_at DESC, mc.chunk_order ASC
            LIMIT ?
            """,
            (int(limit),),
        ).fetchall()
    return [dict(row) for row in rows]


def query_retained_memories(
    query_text: str,
    *,
    content_clues: list[str] | None = None,
    source_hints: list[str] | None = None,
    modality_hints: list[str] | None = None,
    time_text: str | None = None,
    limit: int = 6,
) -> list[MemoryCandidate]:
    ensure_retention_schema()
    normalized_query = normalize_capture_text(query_text, preserve_paragraphs=False, max_chars=400) or query_text.strip()
    if not normalized_query:
        return []
    query_embedding = embed_text(" ".join(part for part in [normalized_query, " ".join(content_clues or []), " ".join(source_hints or []), " ".join(modality_hints or [])] if part))

    chunk_rows: list[dict] = []
    seen_chunk_ids: set[int] = set()
    if chroma_available():
        for chunk_id in query_memory_chunk_ids(query_embedding, limit=max(limit * 10, 40)):
            if chunk_id in seen_chunk_ids:
                continue
            seen_chunk_ids.add(chunk_id)
        chunk_rows.extend(_chunk_rows_by_ids(list(seen_chunk_ids)))
    for row in _lexical_memory_chunk_rows(normalized_query, limit=max(limit * 8, 32)):
        chunk_id = int(row["id"])
        if chunk_id in seen_chunk_ids:
            continue
        seen_chunk_ids.add(chunk_id)
        chunk_rows.append(row)
    if not chunk_rows:
        chunk_rows = _fallback_memory_rows(limit=max(limit * 6, 16))
    if not chunk_rows:
        return []

    query_tokens = _meaningful_query_tokens(" ".join(part for part in [normalized_query, " ".join(content_clues or [])] if part))
    memory_ids = [int(row["memory_id"]) for row in chunk_rows]
    memories = _list_retained_memories_by_ids(memory_ids)
    event_ids = [memories[memory_id].last_event_id for memory_id in memories if memory_id in memories]
    events_by_id = {event.id: event for event in list_events_by_ids(list(dict.fromkeys(event_ids)))}

    candidate_by_memory: dict[int, MemoryCandidate] = {}
    for row in chunk_rows:
        memory_id = int(row["memory_id"])
        memory = memories.get(memory_id)
        if memory is None:
            continue
        chunk_text = str(row["chunk_text"] or "")
        chunk_embedding = _decode_json_vector(row.get("embedding_json"))
        semantic_score = cosine_similarity(query_embedding, chunk_embedding or memory.embedding)
        lexical_score = _lexical_overlap_score(normalized_query, f"{memory.title} {chunk_text} {' '.join(memory.keyphrases)}")
        title_score = _lexical_overlap_score(normalized_query, f"{memory.title} {' '.join(memory.keyphrases)}")
        source_score = _source_score(memory, source_hints or [])
        modality_score = _modality_score(memory, modality_hints or [])
        time_score = _time_score(memory.captured_at, time_text)
        source_type_prior = _source_type_prior(memory)
        noise_penalty = _memory_noise_penalty(memory, chunk_text)
        chunk_quality = float(row.get("quality_score") or 0.0)
        short_query = len(query_tokens) <= 2
        if len(query_tokens) == 1 and lexical_score < 0.18 and title_score < 0.18:
            continue
        semantic_weight = 0.38 if short_query else 0.56
        lexical_weight = 0.34 if short_query else 0.2
        title_weight = 0.24 if short_query else 0.12
        weak_match_penalty = 0.18 if short_query and title_score < 0.24 and lexical_score < 0.24 else 0.0
        score = (
            semantic_score * semantic_weight
            + lexical_score * lexical_weight
            + title_score * title_weight
            + source_score
            + modality_score
            + time_score
            + source_type_prior
            + min(chunk_quality, 1.0) * 0.06
            + min(memory.quality_score, 1.0) * 0.06
            - weak_match_penalty
            - noise_penalty
        )
        if memory.source_type.casefold() == "search_results" and title_score < 0.3 and lexical_score < 0.3:
            continue
        event = events_by_id.get(memory.last_event_id)
        existing = candidate_by_memory.get(memory_id)
        if existing is None or score > existing.score:
            candidate_by_memory[memory_id] = MemoryCandidate(
                memory=memory,
                best_chunk=chunk_text or memory.summary_snippet,
                best_chunk_id=int(row["id"]),
                score=score,
                semantic_score=semantic_score,
                lexical_score=lexical_score,
                source_score=source_score,
                modality_score=modality_score,
                time_score=time_score,
                event=event,
            )

    ranked = sorted(
        candidate_by_memory.values(),
        key=lambda item: (
            item.score,
            item.semantic_score,
            item.lexical_score,
            item.memory.quality_score,
            item.memory.captured_at,
            item.memory.id,
        ),
        reverse=True,
    )
    return ranked[: max(limit, 1)]


def recent_memory_topics(*, limit: int = 6) -> list[str]:
    ensure_retention_schema()
    with get_connection() as connection:
        rows = connection.execute(
            """
            SELECT title, summary_snippet, keyphrases_json
            FROM retained_memories
            ORDER BY quality_score DESC, captured_at DESC, id DESC
            LIMIT ?
            """,
            (max(limit * 3, 12),),
        ).fetchall()
    topics: list[str] = []
    seen: set[str] = set()
    for row in rows:
        for phrase in _decode_json_list(row["keyphrases_json"]):
            cleaned_phrase = _humanize_text(phrase, max_chars=80)
            if not _topic_is_specific(cleaned_phrase) or _title_looks_noisy(cleaned_phrase, source_domain=None, source_app=None):
                continue
            normalized = normalize_text(cleaned_phrase)
            if not normalized or normalized in seen:
                continue
            seen.add(normalized)
            topics.append(cleaned_phrase)
            if len(topics) >= limit:
                return topics
        title = _humanize_text(row["title"], max_chars=80)
        if title:
            if not _topic_is_specific(title) or _title_looks_noisy(title, source_domain=None, source_app=None):
                continue
            normalized = normalize_text(title)
            if normalized and normalized not in seen and len(normalized.split()) >= 2:
                seen.add(normalized)
                topics.append(title)
                if len(topics) >= limit:
                    return topics
    return topics[:limit]
