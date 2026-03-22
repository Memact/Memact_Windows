from __future__ import annotations

import re
from collections import Counter

try:
    import yake  # type: ignore
except Exception:  # pragma: no cover - optional dependency
    yake = None


_TOKEN_PATTERN = re.compile(r"[a-z0-9]+", re.IGNORECASE)
_STOP_WORDS = {
    "a",
    "about",
    "after",
    "all",
    "also",
    "an",
    "and",
    "are",
    "as",
    "at",
    "be",
    "been",
    "but",
    "by",
    "can",
    "could",
    "did",
    "do",
    "for",
    "from",
    "had",
    "has",
    "have",
    "how",
    "i",
    "if",
    "in",
    "into",
    "is",
    "it",
    "its",
    "just",
    "more",
    "not",
    "of",
    "on",
    "or",
    "our",
    "s",
    "so",
    "supports",
    "than",
    "that",
    "the",
    "their",
    "them",
    "then",
    "there",
    "these",
    "this",
    "to",
    "using",
    "uses",
    "was",
    "we",
    "were",
    "what",
    "when",
    "which",
    "with",
    "your",
}


def _tokenize(text: str) -> list[str]:
    return [token.lower() for token in _TOKEN_PATTERN.findall(text or "")]


def _fallback_keyphrases(text: str, max_phrases: int) -> list[str]:
    tokens = _tokenize(text)
    if not tokens:
        return []

    filtered = [token for token in tokens if len(token) >= 4 and token not in _STOP_WORDS]
    if not filtered:
        return []

    unigram_counts = Counter(filtered)
    bigram_counts = Counter(
        " ".join(pair)
        for pair in zip(filtered, filtered[1:])
        if pair[0] != pair[1]
    )
    trigram_counts = Counter(
        " ".join(triple)
        for triple in zip(filtered, filtered[1:], filtered[2:])
        if len(set(triple)) >= 2
    )

    combined: list[tuple[str, int]] = []
    combined.extend((phrase, score) for phrase, score in trigram_counts.items() if score >= 2)
    combined.extend((phrase, score) for phrase, score in bigram_counts.items() if score >= 2)
    combined.extend((phrase, score) for phrase, score in unigram_counts.items() if score >= 2)
    combined.sort(key=lambda item: (item[1], len(item[0])), reverse=True)

    phrases: list[str] = []
    seen: set[str] = set()
    for phrase, _score in combined:
        normalized = phrase.strip()
        if not normalized or normalized in seen:
            continue
        phrases.append(normalized)
        seen.add(normalized)
        if len(phrases) >= max_phrases:
            break
    return phrases


def extract_keyphrases(text: str, max_phrases: int = 12) -> list[str]:
    """Extract top keyphrases from text using YAKE.

    Returns an empty list when the input is empty, YAKE is unavailable,
    or extraction fails for any reason.
    """
    cleaned = str(text or "").strip()
    if not cleaned or max_phrases <= 0:
        return []
    if yake is None:
        return _fallback_keyphrases(cleaned, max_phrases)
    try:
        extractor = yake.KeywordExtractor(
            lan="en",
            n=3,
            top=max_phrases,
            dedupLim=0.9,
        )
        raw_keywords = extractor.extract_keywords(cleaned)
    except Exception:
        return _fallback_keyphrases(cleaned, max_phrases)

    phrases: list[str] = []
    seen: set[str] = set()
    for item in raw_keywords:
        if isinstance(item, tuple):
            phrase = str(item[0]).strip()
        else:
            phrase = str(item).strip()
        key = phrase.casefold()
        if not phrase or key in seen:
            continue
        phrases.append(phrase)
        seen.add(key)
        if len(phrases) >= max_phrases:
            break
    return phrases


def keyphrases_to_text(phrases: list[str]) -> str:
    """Join keyphrases into a single searchable string."""
    cleaned: list[str] = []
    seen: set[str] = set()
    for phrase in phrases or []:
        value = str(phrase).strip()
        key = value.casefold()
        if not value or key in seen:
            continue
        cleaned.append(value)
        seen.add(key)
    return " ".join(cleaned)
