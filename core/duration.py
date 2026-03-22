from __future__ import annotations

from datetime import datetime, timedelta
from urllib.parse import urlparse

from core.database import Event, list_events_between
from core.meaning_extractor import QueryMeaning


_MAX_GAP_SECONDS = 300


def _midnight(value: datetime) -> datetime:
    return value.replace(hour=0, minute=0, second=0, microsecond=0)


def resolve_time_range(time_text: str | None) -> tuple[str, str]:
    """Convert time_text to (start_at, end_at) ISO strings at local midnight boundaries."""
    now = datetime.now()
    text = (time_text or "today").strip().lower()

    if "yesterday" in text or "last night" in text:
        start = _midnight(now - timedelta(days=1))
        end = _midnight(now)
    elif "last week" in text:
        end = _midnight(now)
        start = end - timedelta(days=7)
    elif "recently" in text:
        end = _midnight(now + timedelta(days=1))
        start = _midnight(now - timedelta(days=3))
    elif "last month" in text:
        end = _midnight(now.replace(day=1))
        prev_month = end - timedelta(days=1)
        start = _midnight(prev_month.replace(day=1))
    elif "this week" in text:
        end = _midnight(now + timedelta(days=1))
        start = _midnight(now - timedelta(days=now.weekday()))
    else:
        start = _midnight(now)
        end = _midnight(now + timedelta(days=1))

    return (
        start.strftime("%Y-%m-%d %H:%M:%S"),
        end.strftime("%Y-%m-%d %H:%M:%S"),
    )


def _normalize_app(value: str | None) -> str:
    if not value:
        return ""
    text = value.strip().lower()
    if text.endswith(".exe"):
        text = text[:-4]
    return text


def _event_domain(url: str | None) -> str | None:
    if not url:
        return None
    parsed = urlparse(url)
    if parsed.scheme == "file":
        return "local file"
    if parsed.netloc:
        return parsed.netloc.removeprefix("www.").lower()
    return None


def _matches_filters(event: Event, app_filter: str | None, domain_filter: str | None) -> bool:
    app_ok = True
    domain_ok = True
    if app_filter:
        app_filter_norm = _normalize_app(app_filter)
        app_norm = _normalize_app(event.application)
        app_ok = bool(app_filter_norm) and (
            app_filter_norm == app_norm
            or app_filter_norm in app_norm
            or app_norm in app_filter_norm
        )
    if domain_filter:
        domain_filter_norm = domain_filter.strip().lower()
        domain_ok = _event_domain(event.url) == domain_filter_norm
    return app_ok and domain_ok


def calculate_duration(
    events: list[Event],
    *,
    app_filter: str | None = None,
    domain_filter: str | None = None,
) -> int:
    """Sum capped gaps between consecutive events matching app/domain."""
    if not events:
        return 0
    ordered = sorted(events, key=lambda event: event.occurred_at)
    total = 0
    for current, next_event in zip(ordered, ordered[1:]):
        if not _matches_filters(current, app_filter, domain_filter):
            continue
        try:
            current_time = datetime.fromisoformat(current.occurred_at)
            next_time = datetime.fromisoformat(next_event.occurred_at)
        except Exception:
            continue
        gap = (next_time - current_time).total_seconds()
        if gap <= 0:
            continue
        total += int(min(gap, _MAX_GAP_SECONDS))
    return int(total)


def format_duration(seconds: int) -> str:
    if seconds <= 0:
        return "less than a minute"
    minutes = int(seconds // 60)
    if minutes <= 0:
        return "less than a minute"
    hours, minutes = divmod(minutes, 60)
    parts: list[str] = []
    if hours:
        parts.append(f"{hours} hour" + ("s" if hours != 1 else ""))
    if minutes:
        parts.append(f"{minutes} minute" + ("s" if minutes != 1 else ""))
    return " ".join(parts)


def answer_duration_query(meaning: QueryMeaning) -> str:
    start_at, end_at = resolve_time_range(meaning.time_text)
    events = list_events_between(start_at, end_at, limit=1200)
    total_seconds = calculate_duration(
        events,
        app_filter=meaning.app,
        domain_filter=meaning.domain,
    )
    if total_seconds <= 0:
        return "No activity found for that app in that time window."

    target = meaning.domain or meaning.app or "that app"
    scope = (meaning.time_text or "today").strip()
    scope_suffix = f" {scope}" if scope else ""
    return f"You spent {format_duration(total_seconds)} on {target}{scope_suffix}."
