from __future__ import annotations

import re
from dataclasses import dataclass

from core.semantic import tokenize


_TIME_HINTS = {
    "today",
    "yesterday",
    "tonight",
    "this morning",
    "this afternoon",
    "this evening",
    "last night",
    "last week",
    "last month",
    "this week",
    "earlier today",
    "recently",
    "around",
}

_APP_VERBS = {
    "use",
    "open",
    "visit",
    "launch",
    "watch",
    "read",
    "browse",
    "search",
    "play",
    "open",
}

_CONTENT_MARKERS = {
    "about",
    "article",
    "articles",
    "page",
    "pages",
    "post",
    "posts",
    "message",
    "messages",
    "thread",
    "threads",
    "topic",
    "topics",
    "authentication",
    "python",
    "async",
    "jwt",
}

_ACTIVITY_LEMMA_MAP = {
    "code": "coding",
    "program": "coding",
    "debug": "coding",
    "compile": "coding",
    "build": "coding",
    "chat": "chatting",
    "message": "chatting",
    "dm": "chatting",
    "email": "emailing",
    "mail": "emailing",
    "write": "writing",
    "draft": "writing",
    "note": "writing",
    "read": "reading",
    "review": "reading",
    "browse": "reading",
    "search": "searching",
    "google": "searching",
    "lookup": "searching",
    "watch": "watching",
    "stream": "watching",
    "video": "watching",
    "scroll": "scrolling",
    "type": "typing",
    "edit": "typing",
    "organize": "organizing",
    "file": "organizing",
    "folder": "organizing",
}


@dataclass(frozen=True)
class QueryMeaning:
    raw_query: str
    app: str | None
    domain: str | None
    time_text: str | None
    activity_type: str | None

    def embedding_text(self) -> str:
        parts = [self.raw_query]
        if self.app:
            parts.append(self.app)
        if self.domain:
            parts.append(self.domain)
        if self.activity_type:
            parts.append(self.activity_type)
        if self.time_text:
            parts.append(self.time_text)
        return " ".join(part.strip() for part in parts if part and part.strip())


_SPACY_MODEL = None
_SPACY_LOADING = False


def warmup_spacy() -> None:
    global _SPACY_MODEL, _SPACY_LOADING
    if _SPACY_MODEL is not None or _SPACY_LOADING:
        return
    _SPACY_LOADING = True
    try:
        import spacy  # type: ignore

        _SPACY_MODEL = spacy.load("en_core_web_sm")
    except Exception:
        _SPACY_MODEL = None
    finally:
        _SPACY_LOADING = False


def _spacy_model():
    return _SPACY_MODEL


def _extract_domain(query: str) -> str | None:
    match = re.search(r"(?:https?://)?([a-z0-9.-]+\.[a-z]{2,})", query.lower())
    if not match:
        return None
    domain = match.group(1).removeprefix("www.").strip(".")
    return domain or None


def _normalize_app(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text.strip(" .,:;!?\"'"))
    if not cleaned:
        return cleaned
    if any(char.isupper() for char in cleaned):
        return cleaned
    return cleaned.title()


def _looks_like_content_phrase(text: str | None) -> bool:
    cleaned = re.sub(r"\s+", " ", str(text or "").strip(" .,:;!?\"'"))
    if not cleaned:
        return False
    lowered = cleaned.casefold()
    if " about " in f" {lowered} ":
        return True
    tokens = tokenize(lowered)
    if not tokens:
        return False
    if len(tokens) >= 2 and any(token in _CONTENT_MARKERS for token in tokens):
        return True
    return False


def _extract_app_from_doc(doc) -> str | None:
    if doc is None:
        return None
    for token in doc:
        if token.lemma_.casefold() not in _APP_VERBS:
            continue
        collected = []
        for candidate in token.rights:
            if candidate.is_punct:
                break
            if candidate.like_url or "." in candidate.text:
                collected.append(candidate.text)
            elif candidate.pos_ in {"PROPN", "NOUN", "ADJ"}:
                collected.append(candidate.text)
        if collected:
            candidate_text = _normalize_app(" ".join(collected))
            if _looks_like_content_phrase(candidate_text):
                continue
            return candidate_text
    entities = [ent.text for ent in doc.ents if ent.label_ in {"ORG", "PRODUCT", "WORK_OF_ART"}]
    if entities:
        entities.sort(key=len, reverse=True)
        candidate_text = _normalize_app(entities[0])
        if not _looks_like_content_phrase(candidate_text):
            return candidate_text
    return None


def _extract_app_from_regex(query: str) -> str | None:
    match = re.search(
        r"(?:use|open|visit|launch|watch|read|browse|search|play)\s+([a-z0-9._-]+(?:\s+[a-z0-9._-]+){0,3})",
        query.lower(),
    )
    if not match:
        return None
    candidate_text = _normalize_app(match.group(1))
    if _looks_like_content_phrase(candidate_text):
        return None
    return candidate_text


def _extract_time_text(query: str, doc) -> str | None:
    hints: list[str] = []
    query_lower = query.lower()
    for hint in _TIME_HINTS:
        if hint in query_lower:
            hints.append(hint)
    if doc is not None:
        for ent in doc.ents:
            if ent.label_ in {"DATE", "TIME"}:
                hints.append(ent.text)
    deduped: list[str] = []
    seen: set[str] = set()
    for hint in hints:
        key = hint.casefold()
        if key in seen:
            continue
        deduped.append(hint)
        seen.add(key)
    if not deduped:
        return None
    return " ".join(deduped)


def _extract_activity_type(query: str, doc) -> str | None:
    if doc is not None:
        for token in doc:
            lemma = token.lemma_.casefold()
            if lemma in _ACTIVITY_LEMMA_MAP:
                return _ACTIVITY_LEMMA_MAP[lemma]
    for token in tokenize(query):
        if token in _ACTIVITY_LEMMA_MAP:
            return _ACTIVITY_LEMMA_MAP[token]
    return None


def extract_query_meaning(query: str) -> QueryMeaning:
    model = _spacy_model()
    doc = model(query) if model is not None else None
    domain = _extract_domain(query)
    app = _extract_app_from_doc(doc) or _extract_app_from_regex(query)
    if app and domain and domain.casefold().startswith(app.casefold()):
        app = None
    time_text = _extract_time_text(query, doc)
    activity_type = _extract_activity_type(query, doc)
    return QueryMeaning(
        raw_query=query,
        app=app,
        domain=domain,
        time_text=time_text,
        activity_type=activity_type,
    )
