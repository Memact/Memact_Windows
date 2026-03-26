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

_CONTENT_QUERY_TRIGGERS = (
    "article",
    "read about",
    "that thing about",
    "saw something about",
    "remember reading",
)

CONCEPT_WORDS = {
    "jwt",
    "oauth",
    "api",
    "rest",
    "graphql",
    "sql",
    "nosql",
    "python",
    "javascript",
    "typescript",
    "rust",
    "golang",
    "async",
    "await",
    "authentication",
    "authorization",
    "docker",
    "kubernetes",
    "deployment",
    "microservices",
    "machine learning",
    "deep learning",
    "neural network",
    "transformer",
    "embedding",
    "vector",
    "database",
    "algorithm",
    "data structure",
    "recursion",
    "complexity",
    "http",
    "https",
    "tcp",
    "dns",
    "ssl",
    "tls",
    "react",
    "vue",
    "angular",
    "node",
    "flask",
    "fastapi",
    "git",
    "github",
    "gitlab",
    "ci",
    "cd",
    "devops",
}

APP_ALIASES = {
    "vs code": "VS Code",
    "vscode": "VS Code",
    "visual studio code": "VS Code",
    "code": "VS Code",
    "chrome": "Chrome",
    "google chrome": "Chrome",
    "discord": "Discord",
    "notion": "Notion",
    "slack": "Slack",
    "figma": "Figma",
    "cursor": "Cursor",
    "codex": "Codex",
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
    content_clues: tuple[str, ...] = ()
    source_hints: tuple[str, ...] = ()
    modality_hints: tuple[str, ...] = ()
    time_hints: tuple[str, ...] = ()
    intent: str = "recall"

    def embedding_text(self) -> str:
        parts = [self.raw_query]
        parts.extend(self.content_clues)
        parts.extend(self.source_hints)
        parts.extend(self.modality_hints)
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


def _starts_with_concept(text: str | None) -> bool:
    lowered = re.sub(r"\s+", " ", str(text or "").strip()).casefold()
    if not lowered:
        return False
    for concept in CONCEPT_WORDS:
        if lowered == concept or lowered.startswith(f"{concept} "):
            return True
    return False


def _contains_content_query_trigger(query: str) -> bool:
    lowered = query.casefold()
    return any(trigger in lowered for trigger in _CONTENT_QUERY_TRIGGERS)


def _apply_app_alias(app_name: str | None, query: str) -> str | None:
    cleaned = _normalize_app(str(app_name or ""))
    if not cleaned:
        return None
    lowered = cleaned.casefold()
    query_lower = query.casefold()
    for alias, canonical in APP_ALIASES.items():
        if alias == "code":
            if lowered == "code" and (
                re.search(r"\buse\s+(?:vs\s+)?code\b", query_lower)
                or "visual studio code" in query_lower
                or "vs code" in query_lower
                or "vscode" in query_lower
            ):
                return canonical
            continue
        if lowered == alias or lowered.startswith(f"{alias} "):
            return canonical
    return cleaned


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
            if _starts_with_concept(candidate_text):
                continue
            return candidate_text
    entities = [ent.text for ent in doc.ents if ent.label_ in {"ORG", "PRODUCT", "WORK_OF_ART"}]
    if entities:
        entities.sort(key=len, reverse=True)
        candidate_text = _normalize_app(entities[0])
        if not _looks_like_content_phrase(candidate_text) and not _starts_with_concept(candidate_text):
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
    if _starts_with_concept(candidate_text):
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


def _clean_phrase(text: str | None) -> str | None:
    cleaned = re.sub(r"\s+", " ", str(text or "").strip(" .,:;!?\"'()[]{}"))
    if not cleaned:
        return None
    cleaned = re.sub(
        r"^(?:what|where|when|how|did|do|i|me|my|that|this|thing|page|post|thread|article|pdf|doc|docs|answer|message)\s+",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(
        r"\b(?:today|yesterday|recently|last|week|month|morning|afternoon|evening|tonight)\b",
        "",
        cleaned,
        flags=re.IGNORECASE,
    )
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" .,:;!?\"'")
    if not cleaned:
        return None
    return cleaned


def _extract_source_hints(query: str, *, app: str | None, domain: str | None, doc) -> tuple[str, ...]:
    hints: list[str] = []
    seen: set[str] = set()
    for value in (domain, app):
        cleaned = _clean_phrase(value)
        if not cleaned:
            continue
        key = cleaned.casefold()
        if key in seen:
            continue
        hints.append(cleaned)
        seen.add(key)
    if doc is not None:
        for ent in doc.ents:
            if ent.label_ not in {"ORG", "PRODUCT"}:
                continue
            cleaned = _clean_phrase(ent.text)
            if not cleaned:
                continue
            key = cleaned.casefold()
            if key in seen or _starts_with_concept(cleaned):
                continue
            hints.append(cleaned)
            seen.add(key)
            if len(hints) >= 4:
                break
    return tuple(hints)


def _extract_modality_hints(query: str) -> tuple[str, ...]:
    lowered = query.casefold()
    modalities: list[str] = []
    seen: set[str] = set()
    modality_map = (
        ("pdf", ("pdf",)),
        ("doc", ("doc", "docs", "document")),
        ("thread", ("thread",)),
        ("post", ("post",)),
        ("chat", ("chat", "chatgpt", "claude", "conversation")),
        ("answer", ("answer",)),
        ("video", ("video", "youtube", "watch")),
        ("read", ("read", "article", "page")),
        ("saw", ("saw", "seen")),
        ("learned", ("learn", "learned", "study")),
    )
    for name, terms in modality_map:
        if any(term in lowered for term in terms):
            if name not in seen:
                modalities.append(name)
                seen.add(name)
    return tuple(modalities)


def _extract_content_clues(
    query: str,
    *,
    doc,
    app: str | None,
    domain: str | None,
    time_text: str | None,
    modality_hints: tuple[str, ...],
) -> tuple[str, ...]:
    clues: list[str] = []
    seen: set[str] = set()

    def add(value: str | None) -> None:
        cleaned = _clean_phrase(value)
        if not cleaned:
            return
        lowered = cleaned.casefold()
        if lowered in seen:
            return
        if app and lowered == app.casefold():
            return
        if domain and lowered == domain.casefold():
            return
        if time_text and lowered == time_text.casefold():
            return
        if lowered in APP_ALIASES:
            return
        if len(tokenize(lowered)) < 1:
            return
        if len(lowered) < 3:
            return
        clues.append(cleaned)
        seen.add(lowered)

    if doc is not None:
        for ent in doc.ents:
            if ent.label_ in {"PERSON", "DATE", "TIME"}:
                continue
            add(ent.text)
        for chunk in getattr(doc, "noun_chunks", []):
            text = str(chunk.text).strip()
            if not text or len(text) > 60:
                continue
            add(text)
            if len(clues) >= 5:
                break

    stripped = query
    for pattern in (
        r"^what was that thing (?:i )?(?:read|saw|learned)(?: about)?\s+",
        r"^what did i (?:read|see|learn)(?: about| on)?\s+",
        r"^where did i read about\s+",
        r"^i remember something about\s+",
        r"^that (?:pdf|doc|thread|post|page|article|answer) about\s+",
        r"^what led me to\s+",
        r"^what was\s+",
    ):
        stripped = re.sub(pattern, "", stripped, flags=re.IGNORECASE)
    add(stripped)

    if not clues:
        lowered_tokens = [
            token
            for token in tokenize(query)
            if token not in _TIME_HINTS
            and token not in _APP_VERBS
            and token not in {hint.casefold() for hint in modality_hints}
            and len(token) >= 3
        ]
        if lowered_tokens:
            add(" ".join(lowered_tokens[:6]))
    return tuple(clues[:4])


def _infer_intent(query: str, *, activity_type: str | None) -> str:
    lowered = query.casefold().strip()
    if lowered.startswith(("when ", "how much time", "did i use", "what did i do today", "show my attention", "when was i most focused")):
        return "secondary_timeline"
    if "difference between" in lowered or " versus " in lowered or " vs " in lowered:
        return "compare"
    if "connection between" in lowered or "have in common" in lowered or "relate to" in lowered:
        return "trace"
    if "what led me to" in lowered or "what started" in lowered or "trace back" in lowered:
        return "trace"
    if activity_type in {"coding", "chatting"} and lowered.startswith("when "):
        return "secondary_timeline"
    return "recall"


def extract_query_meaning(query: str) -> QueryMeaning:
    model = _spacy_model()
    doc = model(query) if model is not None else None
    domain = _extract_domain(query)
    app = _extract_app_from_doc(doc) or _extract_app_from_regex(query)
    app = _apply_app_alias(app, query)
    if app and domain and domain.casefold().startswith(app.casefold()):
        app = None
    if app and _contains_content_query_trigger(query) and _starts_with_concept(app):
        app = None
    time_text = _extract_time_text(query, doc)
    activity_type = _extract_activity_type(query, doc)
    modality_hints = _extract_modality_hints(query)
    content_clues = _extract_content_clues(
        query,
        doc=doc,
        app=app,
        domain=domain,
        time_text=time_text,
        modality_hints=modality_hints,
    )
    source_hints = _extract_source_hints(query, app=app, domain=domain, doc=doc)
    time_hints = tuple(part.strip() for part in (time_text or "").split() if part.strip()) if time_text else ()
    intent = _infer_intent(query, activity_type=activity_type)
    return QueryMeaning(
        raw_query=query,
        app=app,
        domain=domain,
        time_text=time_text,
        activity_type=activity_type,
        content_clues=content_clues,
        source_hints=source_hints,
        modality_hints=modality_hints,
        time_hints=time_hints,
        intent=intent,
    )
