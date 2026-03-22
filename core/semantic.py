from __future__ import annotations

import hashlib
import math
import re
from functools import lru_cache
from pathlib import Path


_TOKEN_PATTERN = re.compile(r"[a-z0-9]+")
_EMBED_DIM = 256
_LOCAL_MODEL_NAME = "sentence-transformers/all-MiniLM-L6-v2"
_LOCAL_RERANKER_MODEL_NAME = "cross-encoder/ms-marco-MiniLM-L-6-v2"


def _local_model_candidates(model_name: str) -> list[Path]:
    org, _, repo = model_name.partition("/")
    repo_slug = repo or org
    owner_slug = org if repo else ""
    hub_dir = (
        f"models--{owner_slug.replace('/', '--')}--{repo_slug.replace('/', '--')}"
        if owner_slug
        else f"models--{repo_slug.replace('/', '--')}"
    )
    home = Path.home()
    return [
        home / ".cache" / "huggingface" / "hub" / hub_dir,
        home / ".cache" / "torch" / "sentence_transformers" / model_name,
        home / "AppData" / "Local" / "huggingface" / "hub" / hub_dir,
        home / "AppData" / "Local" / "sentence_transformers" / model_name,
    ]


@lru_cache(maxsize=None)
def _has_local_transformer_model(model_name: str) -> bool:
    for candidate in _local_model_candidates(model_name):
        if candidate.exists():
            return True
    return False


def normalize_text(value: str) -> str:
    return " ".join(_TOKEN_PATTERN.findall((value or "").lower()))


def tokenize(value: str) -> list[str]:
    return [token for token in normalize_text(value).split() if token]


def _hash_embedding(text: str) -> list[float]:
    tokens = tokenize(text)
    if not tokens:
        return [0.0] * _EMBED_DIM
    vector = [0.0] * _EMBED_DIM
    for token in tokens:
        digest = hashlib.sha256(token.encode("utf-8")).digest()
        slot = int.from_bytes(digest[:2], "big") % _EMBED_DIM
        sign = 1.0 if digest[2] % 2 == 0 else -1.0
        vector[slot] += sign
    norm = math.sqrt(sum(value * value for value in vector)) or 1.0
    return [value / norm for value in vector]


@lru_cache(maxsize=1)
def _transformer_backend():
    try:
        from sentence_transformers import SentenceTransformer  # type: ignore

        if _has_local_transformer_model(_LOCAL_MODEL_NAME):
            return SentenceTransformer(
                _LOCAL_MODEL_NAME,
                local_files_only=True,
            )
        return SentenceTransformer(_LOCAL_MODEL_NAME)
    except Exception:
        return None


@lru_cache(maxsize=1)
def _reranker_backend():
    try:
        from sentence_transformers import CrossEncoder  # type: ignore

        if _has_local_transformer_model(_LOCAL_RERANKER_MODEL_NAME):
            return CrossEncoder(
                _LOCAL_RERANKER_MODEL_NAME,
                local_files_only=True,
            )
        return CrossEncoder(_LOCAL_RERANKER_MODEL_NAME)
    except Exception:
        return None


def embed_text(text: str) -> list[float]:
    normalized = normalize_text(text)
    if not normalized:
        return [0.0] * _EMBED_DIM
    model = _transformer_backend()
    if model is None:
        return _hash_embedding(normalized)
    try:
        vector = model.encode(normalized, normalize_embeddings=True)
        return [float(value) for value in vector]
    except Exception:
        return _hash_embedding(normalized)


def cosine_similarity(left: list[float], right: list[float]) -> float:
    if not left or not right:
        return 0.0
    size = min(len(left), len(right))
    if size == 0:
        return 0.0
    return sum(float(left[index]) * float(right[index]) for index in range(size))


def rerank_query_text_pairs(query: str, texts: list[str]) -> list[float]:
    if not texts:
        return []

    model = _reranker_backend()
    if model is not None:
        try:
            pairs = [(query, text) for text in texts]
            scores = model.predict(pairs)
            return [float(score) for score in scores]
        except Exception:
            pass

    query_tokens = tokenize(query)
    normalized_query = normalize_text(query)
    scores: list[float] = []
    for text in texts:
        normalized_text = normalize_text(text)
        ordered_tokens = normalized_text.split()
        text_tokens = set(ordered_tokens)
        overlap = (
            sum(1 for token in query_tokens if token in text_tokens) / max(len(query_tokens), 1)
            if query_tokens
            else 0.0
        )
        phrase_match = 1.0 if normalized_query and normalized_query in normalized_text else 0.0
        adjacency = 0.0
        if len(query_tokens) >= 2 and len(ordered_tokens) >= 2:
            adjacent_hits = 0
            for left, right in zip(query_tokens, query_tokens[1:]):
                pair = f"{left} {right}"
                if pair in normalized_text:
                    adjacent_hits += 1
            adjacency = adjacent_hits / max(len(query_tokens) - 1, 1)
        length_penalty = min(max(len(ordered_tokens) - 80, 0) / 240.0, 0.18)
        scores.append((overlap * 0.56) + (phrase_match * 0.30) + (adjacency * 0.22) - length_penalty)
    return scores
