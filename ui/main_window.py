from __future__ import annotations

import json
import logging
import threading
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse
import os

from PyQt6.QtCore import QObject, QPoint, QRect, QRectF, QSize, QEvent, Qt, QTimer, pyqtSignal
from PyQt6.QtGui import QAction, QColor, QCursor, QDesktopServices, QIcon, QPainter, QPainterPath, QRegion
from PyQt6.QtWidgets import (
    QApplication,
    QDialog,
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
    QLayout,
    QLayoutItem,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMenu,
    QMessageBox,
    QScrollArea,
    QProgressBar,
    QPushButton,
    QWidgetAction,
    QSpacerItem,
    QSizePolicy,
    QGridLayout,
    QSystemTrayIcon,
    QVBoxLayout,
    QWidget,
)
from PyQt6.QtCore import QUrl

from core.browser_bridge import BrowserBridgeServer, BrowserStateStore
from core.browser_setup import detect_browsers, extension_manual_url, launch_extension_setup
from core.database import init_db
from core.monitor import WindowMonitor
from core.query_engine import (
    ActivitySpan,
    QueryAnswer,
    SearchSuggestion,
    answer_query,
    autocomplete_suggestions,
    dynamic_suggestions,
    warmup_query_engine,
)
from core.search_history import add_history, clear_history, load_history, remove_history
from core.settings import load_settings, save_settings
from ui.branding import app_icon
from ui.fonts import body_font, brand_font
from ui.setup_dialog import BrowserSetupDialog
from ui.window_effects import apply_native_window_theme


SEARCH_ICON_PATH = Path(__file__).resolve().parent.parent / "assets" / "search_icon.svg"
ENTER_ICON_PATH = Path(__file__).resolve().parent.parent / "assets" / "enter_icon.svg"
EXTENSION_DIR = Path(__file__).resolve().parent.parent / "extension" / "memact"

logger = logging.getLogger(__name__)


def _domain_chip(url: str | None) -> str | None:
    if not url:
        return None
    text = url.split("://", 1)[-1].split("/", 1)[0].removeprefix("www.")
    return text or None


def _best_url_for_span(span: ActivitySpan) -> str | None:
    span_domain = _domain_chip(span.url)
    best_url: str | None = None
    best_score = -1
    for event in span.events:
        for url in event.urls:
            if not url:
                continue
            parsed = urlparse(url)
            if parsed.scheme not in ("http", "https"):
                continue
            if not parsed.netloc:
                continue
            domain = parsed.netloc.removeprefix("www.")
            if span_domain and domain != span_domain:
                continue
            score = 0
            if parsed.path and parsed.path != "/":
                score += 10 + len(parsed.path)
            if parsed.query:
                score += 2 + len(parsed.query)
            if parsed.fragment:
                score += 1
            if score > best_score:
                best_score = score
                best_url = url
    return best_url or span.url


def _link_label(url: str | None) -> str:
    if not url:
        return "Open link"
    parsed = urlparse(url)
    domain = parsed.netloc.removeprefix("www.")
    if not domain:
        return "Open link"
    display = domain
    if parsed.path and parsed.path != "/":
        display = f"{domain}{parsed.path}"
    if len(display) > 52:
        display = display[:49] + "…"
    return f"Open {display}"


def _best_exe_for_span(span: ActivitySpan) -> str | None:
    for event in span.events:
        if event.exe_path:
            return event.exe_path
    return None


def _duration_chip(seconds: int) -> str:
    minutes = max(int(round(seconds / 60)), 1)
    if minutes >= 60:
        hours, minutes = divmod(minutes, 60)
        if minutes:
            return f"{hours}h {minutes}m"
        return f"{hours}h"
    return f"{minutes}m"


class FlowLayout(QLayout):
    def __init__(self, parent: QWidget | None = None, margin: int = 0, spacing: int = 8) -> None:
        super().__init__(parent)
        self._items: list[QLayoutItem] = []
        self.setContentsMargins(margin, margin, margin, margin)
        self.setSpacing(spacing)

    def __del__(self) -> None:
        while self.count():
            self.takeAt(0)

    def addItem(self, item: QLayoutItem) -> None:
        self._items.append(item)

    def count(self) -> int:
        return len(self._items)

    def itemAt(self, index: int) -> QLayoutItem | None:
        if 0 <= index < len(self._items):
            return self._items[index]
        return None

    def takeAt(self, index: int) -> QLayoutItem | None:
        if 0 <= index < len(self._items):
            return self._items.pop(index)
        return None

    def expandingDirections(self) -> Qt.Orientations:
        return Qt.Orientation(0)

    def hasHeightForWidth(self) -> bool:
        return True

    def heightForWidth(self, width: int) -> int:
        return self._do_layout(QRect(0, 0, max(width, 0), 0), True)

    def setGeometry(self, rect: QRect) -> None:
        super().setGeometry(rect)
        self._do_layout(rect, False)

    def sizeHint(self) -> QSize:
        return self.minimumSize()

    def minimumSize(self) -> QSize:
        margins = self.contentsMargins()
        size = QSize()
        for item in self._items:
            size = size.expandedTo(item.minimumSize())
        size += QSize(margins.left() + margins.right(), margins.top() + margins.bottom())
        return size

    def _do_layout(self, rect: QRect, test_only: bool) -> int:
        margins = self.contentsMargins()
        effective = rect.adjusted(margins.left(), margins.top(), -margins.right(), -margins.bottom())
        if effective.width() <= 0:
            return margins.top() + margins.bottom()

        x = effective.x()
        y = effective.y()
        line_height = 0

        for item in self._items:
            hint = item.sizeHint()
            next_x = x + hint.width()
            if line_height > 0 and next_x > effective.right() + 1:
                x = effective.x()
                y += line_height + self.spacing()
                next_x = x + hint.width()
                line_height = 0

            if not test_only:
                item.setGeometry(QRect(QPoint(x, y), hint))

            x = next_x + self.spacing()
            line_height = max(line_height, hint.height())

        used_height = (y - effective.y()) + line_height
        return used_height + margins.top() + margins.bottom()


class SignalBridge(QObject):
    runtime_ready = pyqtSignal()
    runtime_failed = pyqtSignal(str)
    new_event = pyqtSignal()
    query_answer_ready = pyqtSignal(object, int, str)
    suggestions_ready = pyqtSignal(object, int, str, str)


class SearchInput(QLineEdit):
    focused = pyqtSignal()
    blurred = pyqtSignal()
    navigate_up = pyqtSignal()
    navigate_down = pyqtSignal()
    accept_selection = pyqtSignal()
    commit_selection = pyqtSignal()
    escape_pressed = pyqtSignal()
    typed_over_suggestion = pyqtSignal(str)

    def focusInEvent(self, event) -> None:  # noqa: N802
        super().focusInEvent(event)
        self.focused.emit()

    def focusOutEvent(self, event) -> None:  # noqa: N802
        super().focusOutEvent(event)
        self.blurred.emit()

    def keyPressEvent(self, event) -> None:  # noqa: N802
        if (
            bool(self.property("suggestionSelected"))
            and event.text()
            and not (event.modifiers() & (Qt.KeyboardModifier.ControlModifier | Qt.KeyboardModifier.AltModifier | Qt.KeyboardModifier.MetaModifier))
        ):
            self.typed_over_suggestion.emit(event.text())
            event.accept()
            return
        if event.key() == Qt.Key.Key_Down:
            self.navigate_down.emit()
            event.accept()
            return
        if event.key() == Qt.Key.Key_Up:
            self.navigate_up.emit()
            event.accept()
            return
        if event.key() == Qt.Key.Key_Escape:
            self.escape_pressed.emit()
            event.accept()
            return
        if event.key() == Qt.Key.Key_Tab and bool(self.property("suggestionSelected")):
            self.commit_selection.emit()
            event.accept()
            return
        if event.key() in (Qt.Key.Key_Return, Qt.Key.Key_Enter):
            if bool(self.property("suggestionSelected")):
                self.accept_selection.emit()
                event.accept()
                return
        super().keyPressEvent(event)


class SuggestionCard(QFrame):
    clicked = pyqtSignal(str)
    hovered = pyqtSignal(str)
    unhovered = pyqtSignal()

    def __init__(self, suggestion: SearchSuggestion, parent=None) -> None:
        super().__init__(parent)
        self._completion = suggestion.completion
        self.setObjectName("SuggestionCard")
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setProperty("hovered", False)
        self.setProperty("active", False)

        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 16, 18, 16)
        layout.setSpacing(6)

        meta = QLabel(suggestion.category.upper())
        meta.setObjectName("SuggestionMeta")
        title = QLabel(suggestion.title)
        title.setObjectName("SuggestionTitle")
        title.setWordWrap(True)
        subtitle = QLabel(suggestion.subtitle)
        subtitle.setObjectName("SuggestionSubtitle")
        subtitle.setWordWrap(True)

        layout.addWidget(meta)
        layout.addWidget(title)
        layout.addWidget(subtitle)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self._completion)
        super().mousePressEvent(event)

    def enterEvent(self, event) -> None:  # noqa: N802
        self.setProperty("hovered", True)
        self.style().unpolish(self)
        self.style().polish(self)
        self.hovered.emit(self._completion)
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802
        self.setProperty("hovered", False)
        self.style().unpolish(self)
        self.style().polish(self)
        self.unhovered.emit()
        super().leaveEvent(event)


class HistoryRow(QFrame):
    clicked = pyqtSignal(str)

    def __init__(self, query: str, parent=None) -> None:
        super().__init__(parent)
        self._query = query
        self.setObjectName("HistoryRow")
        self.setCursor(Qt.CursorShape.PointingHandCursor)
        self.setProperty("hovered", False)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            self.clicked.emit(self._query)
        super().mousePressEvent(event)

    def enterEvent(self, event) -> None:  # noqa: N802
        self.setProperty("hovered", True)
        self.style().unpolish(self)
        self.style().polish(self)
        super().enterEvent(event)

    def leaveEvent(self, event) -> None:  # noqa: N802
        self.setProperty("hovered", False)
        self.style().unpolish(self)
        self.style().polish(self)
        super().leaveEvent(event)


class EvidenceCard(QFrame):
    activated = pyqtSignal(str)

    def __init__(self, span: ActivitySpan, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("EvidenceCard")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 16, 18, 16)
        layout.setSpacing(6)
        layout.setSizeConstraint(QLayout.SizeConstraint.SetMinimumSize)
        self._wrap_labels: list[QLabel] = []

        title = QLabel(span.source_title or span.session_title)
        title.setObjectName("EvidenceTitle")
        title.setWordWrap(True)
        self._wrap_labels.append(title)

        app_label = span.application.removesuffix(".exe").replace("_", " ").title()
        chip_row = FlowLayout(spacing=8)
        chip_row.setContentsMargins(0, 0, 0, 0)
        activity_chips: list[str] = []
        if getattr(span, "activity_mode", None):
            activity_chips.append(str(span.activity_mode).replace("_", " ").title())
        category = getattr(span, "activity_category", None)
        category_conf = float(getattr(span, "activity_confidence", 0.0) or 0.0)
        if category and category not in {"typing", "scrolling"} and category_conf >= 0.44:
            activity_chips.append(str(category).replace("_", " ").title())
        if not activity_chips:
            activity_chips.append("Web Activity" if span.url else "App Activity")
        chip_values = (
            (
                app_label,
                span.source_domain or _domain_chip(span.url),
                str((span.source_type or "").replace("_", " ").title() or "Memory"),
            )
            if getattr(span, "is_retained_memory", False)
            else (
                app_label,
                _domain_chip(span.url),
                *activity_chips,
                _duration_chip(span.duration_seconds),
            )
        )
        for chip_text in chip_values:
            if not chip_text:
                continue
            chip = QLabel(chip_text)
            chip.setObjectName("EvidenceChip")
            chip_row.addWidget(chip)

        all_phrases: list[str] = []
        seen_phrases: set[str] = set()
        for event in span.events:
            for phrase in getattr(event, "keyphrases", []):
                phrase_text = str(phrase).strip()
                if not phrase_text:
                    continue
                key = phrase_text.casefold()
                if key in seen_phrases:
                    continue
                all_phrases.append(phrase_text)
                seen_phrases.add(key)
                if len(all_phrases) >= 5:
                    break
            if len(all_phrases) >= 5:
                break

        keyphrase_row = None
        if all_phrases and not getattr(span, "is_retained_memory", False):
            keyphrase_row = QHBoxLayout()
            keyphrase_row.setContentsMargins(0, 0, 0, 0)
            keyphrase_row.setSpacing(8)
            for phrase in all_phrases:
                label = QLabel(f"#{phrase}")
                label.setObjectName("EvidenceKeyphrase")
                keyphrase_row.addWidget(label)
            keyphrase_row.addStretch(1)

        if getattr(span, "is_retained_memory", False):
            meta_text = f"{span.start_at.strftime('%b %d')}  |  {span.start_at.strftime('%I:%M %p').lstrip('0')}  |  {app_label}"
        else:
            meta_text = f"{span.start_at.strftime('%b %d')}  |  {span.start_at.strftime('%I:%M %p').lstrip('0')} to {span.end_at.strftime('%I:%M %p').lstrip('0')}  |  {app_label}"
        meta = QLabel(meta_text)
        meta.setObjectName("EvidenceMeta")
        meta.setWordWrap(True)
        self._wrap_labels.append(meta)

        link_button = None
        best_url = _best_url_for_span(span)
        domain = _domain_chip(best_url)
        if best_url and domain:
            link_button = QPushButton(_link_label(best_url))
            link_button.setObjectName("EvidenceLinkButton")
            link_button.setCursor(Qt.CursorShape.PointingHandCursor)
            link_button.clicked.connect(lambda _checked=False, value=best_url: QDesktopServices.openUrl(QUrl(value)))
        elif _best_exe_for_span(span):
            exe_path = _best_exe_for_span(span)
            link_button = QPushButton(f"Open {app_label}")
            link_button.setObjectName("EvidenceLinkButton")
            link_button.setCursor(Qt.CursorShape.PointingHandCursor)
            link_button.clicked.connect(lambda _checked=False, value=exe_path: os.startfile(value))

        attention = None

        snippet_text = span.snippet.strip()
        if snippet_text and len(snippet_text) > 140:
            snippet_text = snippet_text[:137].rstrip() + "..."
        snippet = None
        if snippet_text and snippet_text.casefold() not in {span.session_title.casefold(), span.label.casefold()}:
            snippet = QLabel(snippet_text)
            snippet.setObjectName("EvidenceSnippet")
            snippet.setWordWrap(True)
            self._wrap_labels.append(snippet)

        context_line = None
        if span.before_context or span.after_context:
            parts = []
            if span.before_context:
                parts.append(span.before_context)
            if span.after_context:
                if parts:
                    parts.append("then")
                parts.append(span.after_context)
            context_line = QLabel("Context: " + " ".join(parts))
            context_line.setObjectName("EvidenceMoment")
            context_line.setWordWrap(True)
        elif span.moment_summary and span.moment_summary.casefold() != span.session_title.casefold():
            context_line = QLabel(span.moment_summary)
            context_line.setObjectName("EvidenceMoment")
            context_line.setWordWrap(True)
        if getattr(span, "why_matched", None):
            context_line = QLabel(str(span.why_matched))
            context_line.setObjectName("EvidenceMoment")
            context_line.setWordWrap(True)
        if context_line is not None:
            self._wrap_labels.append(context_line)

        layout.addWidget(title)
        layout.addLayout(chip_row)
        if keyphrase_row is not None:
            layout.addLayout(keyphrase_row)
        layout.addWidget(meta)
        if link_button is not None:
            layout.addWidget(link_button, 0, Qt.AlignmentFlag.AlignLeft)
        if snippet is not None:
            layout.addWidget(snippet)
        if context_line is not None:
            layout.addWidget(context_line)
        # Drop match-reason line to reduce clutter; details are in the summary above.
        QTimer.singleShot(0, self._reflow_labels)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._reflow_labels()

    def _reflow_labels(self) -> None:
        for label in self._wrap_labels:
            if not label.wordWrap():
                continue
            if not label.isVisible() or not label.text():
                label.setMinimumHeight(0)
                continue
            width = max(1, label.width())
            rect = label.fontMetrics().boundingRect(
                QRect(0, 0, width, 10000),
                int(Qt.TextFlag.TextWordWrap | Qt.TextFlag.TextExpandTabs),
                label.text(),
            )
            label.setMinimumHeight(rect.height() + 4)


class GlassInfoDialog(QDialog):
    def __init__(self, *, title: str, text: str, parent=None) -> None:
        super().__init__(parent)
        self.setModal(True)
        self.setWindowTitle(title)
        self.setFont(body_font(12))
        self.resize(560, 240)
        self.setWindowIcon(app_icon())

        self.setStyleSheet(
            """
            QDialog {
                background: #00011B;
                color: #ffffff;
            }
            QFrame#DialogPanel {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 24px;
            }
            QLabel#DialogTitle {
                color: #ffffff;
                font-size: 24px;
            }
            QLabel#DialogBody {
                color: rgba(255, 255, 255, 0.74);
                font-size: 14px;
            }
            QPushButton {
                background: rgba(40, 74, 128, 0.14);
                color: #ffffff;
                border: 1px solid rgba(88, 126, 188, 0.26);
                border-radius: 12px;
                padding: 0 18px;
                min-width: 118px;
                min-height: 38px;
                font-size: 13px;
                font-weight: 700;
            }
            QPushButton:hover {
                background: rgba(40, 74, 128, 0.20);
                border: 1px solid rgba(106, 150, 218, 0.32);
            }
            """
        )

        shell = QVBoxLayout(self)
        shell.setContentsMargins(20, 20, 20, 20)

        panel = QFrame()
        panel.setObjectName("DialogPanel")
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(20, 20, 20, 20)
        panel_layout.setSpacing(12)

        title_label = QLabel(title)
        title_label.setObjectName("DialogTitle")
        body_label = QLabel(text)
        body_label.setObjectName("DialogBody")
        body_label.setWordWrap(True)
        panel_layout.addWidget(title_label)
        panel_layout.addWidget(body_label)

        actions = QHBoxLayout()
        actions.addStretch(1)
        ok_button = QPushButton("OK")
        ok_button.setCursor(Qt.CursorShape.PointingHandCursor)
        ok_button.clicked.connect(self.accept)
        actions.addWidget(ok_button)
        panel_layout.addLayout(actions)

        shell.addWidget(panel)

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        apply_native_window_theme(self)


class SearchHistoryDialog(QDialog):
    def __init__(self, history: list[dict], on_clear, on_select, on_delete, parent=None) -> None:
        super().__init__(parent)
        self._history = history
        self._on_clear = on_clear
        self._on_select = on_select
        self._on_delete = on_delete
        self.setModal(True)
        self.setWindowTitle("Search history")
        self.setFont(body_font(12))
        self.resize(680, 520)
        self.setWindowIcon(app_icon())

        self.setStyleSheet(
            """
            QDialog {
                background: #00011B;
                color: #ffffff;
            }
            QFrame#DialogPanel {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 24px;
            }
            QLabel#DialogTitle {
                color: #ffffff;
                font-size: 24px;
            }
            QLabel#DialogBody {
                color: rgba(255, 255, 255, 0.74);
                font-size: 14px;
            }
            QScrollArea#HistoryScroll {
                background: transparent;
                border: none;
            }
            QScrollArea#HistoryScroll QWidget#qt_scrollarea_viewport {
                background: transparent;
            }
            QWidget#HistoryContent {
                background: transparent;
            }
            QFrame#HistoryRow {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 14px;
            }
            QFrame#HistoryRow[hovered="true"] {
                background: rgba(255, 255, 255, 0.16);
                border: 1px solid rgba(255, 255, 255, 0.16);
            }
            QLabel#HistoryQuery {
                color: #ffffff;
                font-size: 15px;
            }
            QLabel#HistoryTime {
                color: rgba(255, 255, 255, 0.58);
                font-size: 12px;
            }
            QPushButton#HistoryDeleteButton {
                background: rgba(255, 255, 255, 0.08);
                color: #ffffff;
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 10px;
                min-width: 28px;
                min-height: 28px;
                padding: 0;
                font-family: "IBM Plex Sans";
                font-size: 14px;
                font-weight: 600;
            }
            QPushButton#HistoryDeleteButton:hover {
                background: rgba(255, 255, 255, 0.16);
            }
            QPushButton#ClearButton {
                background: rgba(255, 255, 255, 0.05);
                color: #ffffff;
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 12px;
                padding: 0 18px;
                min-width: 108px;
                min-height: 38px;
                font-size: 13px;
                font-weight: 700;
            }
            QPushButton#ClearButton:hover {
                background: rgba(255, 255, 255, 0.10);
                border: 1px solid rgba(255, 255, 255, 0.16);
            }
            QPushButton#CloseButton {
                background: rgba(40, 74, 128, 0.14);
                color: #ffffff;
                border: 1px solid rgba(88, 126, 188, 0.26);
                border-radius: 12px;
                padding: 0 18px;
                min-width: 118px;
                min-height: 38px;
                font-size: 13px;
                font-weight: 700;
            }
            QPushButton#CloseButton:hover {
                background: rgba(40, 74, 128, 0.20);
                border: 1px solid rgba(106, 150, 218, 0.32);
            }
            """
        )

        shell = QVBoxLayout(self)
        shell.setContentsMargins(20, 20, 20, 20)

        panel = QFrame()
        panel.setObjectName("DialogPanel")
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(20, 20, 20, 20)
        panel_layout.setSpacing(12)

        title = QLabel("Search history")
        title.setObjectName("DialogTitle")
        subtitle = QLabel("Your recent searches are stored locally on this device.")
        subtitle.setObjectName("DialogBody")
        subtitle.setWordWrap(True)

        panel_layout.addWidget(title)
        panel_layout.addWidget(subtitle)

        self._scroll = QScrollArea()
        self._scroll.setObjectName("HistoryScroll")
        self._scroll.setWidgetResizable(True)
        self._scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self._scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)

        self._content = QWidget()
        self._content.setObjectName("HistoryContent")
        self._content_layout = QVBoxLayout(self._content)
        self._content_layout.setContentsMargins(0, 0, 0, 0)
        self._content_layout.setSpacing(10)
        self._scroll.setWidget(self._content)

        panel_layout.addWidget(self._scroll, 1)

        actions = QHBoxLayout()
        actions.addStretch(1)
        clear_button = QPushButton("Clear history")
        clear_button.setObjectName("ClearButton")
        clear_button.setCursor(Qt.CursorShape.PointingHandCursor)
        clear_button.clicked.connect(self._clear_history)
        close_button = QPushButton("Close")
        close_button.setObjectName("CloseButton")
        close_button.setCursor(Qt.CursorShape.PointingHandCursor)
        close_button.clicked.connect(self.accept)
        actions.addWidget(clear_button)
        actions.addWidget(close_button)
        panel_layout.addLayout(actions)

        shell.addWidget(panel)
        self._render_history()

    def _clear_history(self) -> None:
        self._on_clear()
        self._history = []
        self._render_history()

    def _select_query(self, query: str) -> None:
        if not query:
            return
        self._on_select(query)
        self.accept()

    def _delete_query(self, query: str) -> None:
        if not query:
            return
        self._on_delete(query)
        key = query.casefold()
        self._history = [entry for entry in self._history if str(entry.get("query", "")).casefold() != key]
        self._render_history()

    def _render_history(self) -> None:
        while self._content_layout.count():
            item = self._content_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        if not self._history:
            empty = QLabel("No searches yet.")
            empty.setObjectName("DialogBody")
            empty.setFont(body_font(12))
            self._content_layout.addWidget(empty)
            self._content_layout.addStretch(1)
            return

        for entry in self._history:
            query = str(entry.get("query", "")).strip()
            timestamp = str(entry.get("timestamp", "")).strip()
            if not query:
                continue
            readable = timestamp
            try:
                parsed = datetime.fromisoformat(timestamp)
                readable = parsed.strftime("%b %d • %I:%M %p").lstrip("0").replace(" 0", " ")
            except Exception:
                pass

            row = HistoryRow(query)
            row.clicked.connect(self._select_query)
            row_layout = QHBoxLayout(row)
            row_layout.setContentsMargins(14, 10, 14, 10)
            row_layout.setSpacing(12)
            text_col = QVBoxLayout()
            text_col.setContentsMargins(0, 0, 0, 0)
            text_col.setSpacing(6)
            query_label = QLabel(query)
            query_label.setObjectName("HistoryQuery")
            query_label.setFont(body_font(12))
            query_label.setWordWrap(True)
            time_label = QLabel(readable)
            time_label.setObjectName("HistoryTime")
            time_label.setFont(body_font(10))
            text_col.addWidget(query_label)
            text_col.addWidget(time_label)
            row_layout.addLayout(text_col, 1)

            delete_button = QPushButton("×")
            delete_button.setObjectName("HistoryDeleteButton")
            delete_button.setFont(body_font(11))
            delete_button.setCursor(Qt.CursorShape.PointingHandCursor)
            delete_button.clicked.connect(lambda _checked=False, value=query: self._delete_query(value))
            row_layout.addWidget(delete_button, 0, Qt.AlignmentFlag.AlignTop)

            self._content_layout.addWidget(row)

        self._content_layout.addStretch(1)

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        apply_native_window_theme(self)


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("Memact")
        self.resize(1120, 760)
        self.setMinimumSize(880, 620)
        self.setWindowIcon(app_icon())

        self.settings = load_settings()
        stored_versions = self.settings.get("extension_versions")
        self._extension_versions = (
            {str(key): str(value) for key, value in stored_versions.items() if value}
            if isinstance(stored_versions, dict)
            else {}
        )
        self.browser_state_store = BrowserStateStore(on_update=self._handle_browser_session)
        self.browser_bridge = BrowserBridgeServer(self.browser_state_store)
        self.monitor = WindowMonitor(
            on_new_event=lambda: self._bridge.new_event.emit(),
            browser_state_store=self.browser_state_store,
        )

        self._bridge = SignalBridge()
        self._bridge.runtime_ready.connect(self._finish_runtime_initialization)
        self._bridge.runtime_failed.connect(self._handle_runtime_failed)
        self._bridge.new_event.connect(self._handle_new_event)
        self._bridge.query_answer_ready.connect(self._handle_query_answer_ready)
        self._bridge.suggestions_ready.connect(self._handle_suggestions_ready)

        self._services_started = False
        self._db_ready = False
        self._quitting = False
        self._native_theme_applied = False
        self._last_answer: QueryAnswer | None = None
        self._search_active = False
        self._hero_shifted = False
        self._status_text_cached = ""
        self._query_request_id = 0
        self._suggestion_request_id = 0
        self._selected_suggestion_index = -1
        self._visible_suggestion_cards: list[SuggestionCard] = []
        self._typed_query_before_selection = ""
        self._cached_empty_suggestions: list[SearchSuggestion] | None = None
        self._active_time_filter: str | None = None
        self._results_mode = False

        self._suggestion_timer = QTimer(self)
        self._suggestion_timer.setSingleShot(True)
        self._suggestion_timer.setInterval(20)
        self._suggestion_timer.timeout.connect(self._kickoff_suggestion_refresh)

        self._hover_reset_timer = QTimer(self)
        self._hover_reset_timer.setSingleShot(True)
        self._hover_reset_timer.setInterval(50)
        self._hover_reset_timer.timeout.connect(self._clear_preview_if_idle)

        self._loading_timer = QTimer(self)
        self._loading_timer.setInterval(35)
        self._loading_timer.timeout.connect(self._tick_loading)
        self._loading_progress = 0

        self._tray_hide_timer = QTimer(self)
        self._tray_hide_timer.setSingleShot(True)
        self._tray_hide_timer.setInterval(250)
        self._tray_hide_timer.timeout.connect(self._hide_tray_menu_if_idle)

        self._build_ui()
        self._build_tray()
        self._build_menu()

        self._show_loading_state()
        QTimer.singleShot(300, self._initialize_runtime_async)

    def _create_results_divider(self) -> QWidget:
        host = QWidget()
        host.setFixedSize(20, 36)
        layout = QHBoxLayout(host)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(0)
        layout.addStretch(1)
        line = QFrame()
        line.setObjectName("ResultsDivider")
        line.setFixedSize(1, 32)
        layout.addWidget(line, 0, Qt.AlignmentFlag.AlignCenter)
        layout.addStretch(1)
        return host

    def _build_ui(self) -> None:
        self.setFont(body_font(12))
        self.setStyleSheet(
            """
            QMainWindow {
                background: #00011B;
            }
            QWidget#Root {
                background: transparent;
                color: #ffffff;
            }
            QFrame#MenuOrb {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 24px;
            }
            QPushButton#MenuButton {
                background: transparent;
                color: #ffffff;
                border: none;
                border-radius: 16px;
                padding: 6px 12px;
                font-size: 22px;
                font-weight: 600;
            }
            QPushButton#MenuButton:hover {
                background: rgba(255, 255, 255, 0.16);
            }
            QLabel#HeroTitle {
                color: #ffffff;
                font-size: 68px;
                font-weight: 600;
            }
            QLabel#CompactBrand {
                color: #ffffff;
                font-size: 46px;
                font-weight: 700;
            }
            QFrame#ResultsDivider {
                background: rgba(255, 255, 255, 0.32);
                border-radius: 1px;
            }
            QFrame#ResultsShadow {
                background: qlineargradient(
                    x1: 0, y1: 0,
                    x2: 0, y2: 1,
                    stop: 0 rgba(255, 255, 255, 0.14),
                    stop: 1 rgba(255, 255, 255, 0.0)
                );
                border-radius: 0px;
            }
            QProgressBar#LoadingBar {
                background: qlineargradient(
                    x1: 0, y1: 0,
                    x2: 0, y2: 1,
                    stop: 0 rgba(255, 255, 255, 0.14),
                    stop: 1 rgba(255, 255, 255, 0.0)
                );
                border: none;
                border-radius: 0px;
            }
            QProgressBar#LoadingBar::chunk {
                background: rgba(255, 255, 255, 0.8);
                border-radius: 0px;
            }
            QLineEdit#SearchInput {
                background: transparent;
                color: #ffffff;
                border: none;
                padding: 0;
                font-size: 24px;
                selection-background-color: rgba(40, 74, 128, 0.35);
            }
            QLineEdit#SearchInput[empty="true"] {
                color: rgba(255, 255, 255, 0.56);
            }
            QLineEdit#SearchInput[preview="true"] {
                color: rgba(255, 255, 255, 0.62);
            }
            QLineEdit#SearchInput:focus {
                background: transparent;
            }
            QPushButton#SearchButton {
                background: transparent;
                border: none;
                padding: 0;
            }
            QPushButton#SearchButton:hover {
                background: rgba(255, 255, 255, 0.16);
                border-radius: 12px;
            }
            QFrame#SuggestionDock {
                background: rgba(8, 10, 34, 0.98);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-top: none;
                border-top-left-radius: 0px;
                border-top-right-radius: 0px;
                border-bottom-left-radius: 24px;
                border-bottom-right-radius: 24px;
            }
            QFrame#SuggestionDock[attached="true"] {
                margin-top: 0px;
                border-top-left-radius: 0px;
                border-top-right-radius: 0px;
                border-top: none;
                border-top-color: transparent;
            }
            QScrollArea#SuggestionScroll {
                background: transparent;
                border: none;
            }
            QScrollArea#SuggestionScroll QWidget {
                background: transparent;
            }
            QScrollBar:vertical {
                background: transparent;
                width: 10px;
                margin: 6px 2px 6px 2px;
            }
            QScrollBar::handle:vertical {
                background: rgba(255, 255, 255, 0.22);
                border-radius: 5px;
                min-height: 28px;
            }
            QScrollBar::handle:vertical:hover {
                background: rgba(255, 255, 255, 0.34);
            }
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical,
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {
                background: transparent;
                border: none;
                height: 0;
            }
            QLabel#SuggestionHeading {
                color: rgba(255, 255, 255, 0.62);
                font-size: 13px;
                font-weight: 700;
                letter-spacing: 1px;
            }
            QPushButton#TimeFilterChip {
                background: rgba(255, 255, 255, 0.05);
                color: #ffffff;
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 16px;
                padding: 5px 14px;
                min-height: 28px;
                font-size: 12px;
                font-weight: 700;
            }
            QPushButton#TimeFilterChip[active="true"] {
                background: rgba(40, 74, 128, 0.14);
                color: #ffffff;
                border: 1px solid rgba(88, 126, 188, 0.26);
            }
            QPushButton#TimeFilterChip:hover {
                background: rgba(255, 255, 255, 0.10);
                border: 1px solid rgba(255, 255, 255, 0.16);
            }
            QPushButton#TimeFilterChip[active="true"]:hover {
                background: rgba(40, 74, 128, 0.20);
                border: 1px solid rgba(106, 150, 218, 0.32);
            }
            QFrame#SuggestionCard {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 14px;
            }
            QFrame#SuggestionCard[hovered="true"], QFrame#SuggestionCard[active="true"] {
                background: rgba(255, 255, 255, 0.10);
                border: 1px solid rgba(255, 255, 255, 0.16);
            }
            QLabel#SuggestionMeta {
                color: rgba(255, 255, 255, 0.42);
                font-size: 10px;
                font-weight: 700;
                letter-spacing: 0.8px;
            }
            QLabel#SuggestionTitle {
                color: #ffffff;
                font-size: 17px;
                font-weight: 500;
            }
            QLabel#SuggestionSubtitle {
                color: rgba(255, 255, 255, 0.56);
                font-size: 12px;
            }
            QFrame#SearchShell {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 26px;
            }
            QFrame#SearchShell[active="true"] {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.16);
            }
            QFrame#SearchShell[attached="true"] {
                border-bottom: none;
                border-bottom-color: transparent;
                border-bottom-left-radius: 0px;
                border-bottom-right-radius: 0px;
            }
            QFrame#AnswerCard {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 28px;
            }
            QLabel#AnswerEyebrow {
                color: rgba(255, 255, 255, 0.62);
                font-size: 12px;
                font-weight: 700;
                letter-spacing: 1px;
            }
            QLabel#AnswerText {
                color: #ffffff;
                font-size: 34px;
                font-weight: 500;
            }
            QLabel#AnswerSummary {
                color: rgba(255, 255, 255, 0.74);
                font-size: 15px;
            }
            QLabel#SessionHeading {
                color: rgba(255, 255, 255, 0.62);
                font-size: 12px;
                font-weight: 700;
                letter-spacing: 1px;
            }
            QLabel#SessionSummary {
                color: rgba(170, 194, 230, 0.92);
                font-size: 13px;
                font-weight: 600;
            }
            QPushButton#DetailsButton {
                background: transparent;
                color: #ffffff;
                border: none;
                padding: 0;
                font-size: 14px;
                font-weight: 600;
                text-align: left;
            }
            QPushButton#DetailsButton:hover {
                color: rgba(170, 194, 230, 0.95);
            }
            QScrollArea#EvidenceScroll {
                background: transparent;
                border: none;
            }
            QScrollArea#EvidenceScroll QWidget {
                background: transparent;
            }
            QFrame#EvidenceCard {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 18px;
            }
            QLabel#EvidenceTitle {
                color: #ffffff;
                font-size: 18px;
                font-weight: 600;
            }
            QLabel#EvidenceChip {
                background: rgba(40, 74, 128, 0.12);
                color: rgba(255, 255, 255, 0.88);
                border: 1px solid rgba(40, 74, 128, 0.22);
                border-radius: 11px;
                padding: 4px 10px;
                font-size: 11px;
                font-weight: 600;
            }
            QLabel#EvidenceKeyphrase {
                color: rgba(255, 255, 255, 0.38);
                font-size: 11px;
                font-style: italic;
            }
            QLabel#EvidenceMeta {
                color: rgba(170, 194, 230, 0.92);
                font-size: 12px;
                font-weight: 600;
            }
            QPushButton#EvidenceLinkButton {
                background: rgba(40, 74, 128, 0.14);
                color: #ffffff;
                border: 1px solid rgba(88, 126, 188, 0.26);
                border-radius: 12px;
                padding: 6px 12px;
                font-size: 12px;
                font-weight: 700;
            }
            QPushButton#EvidenceLinkButton:hover {
                background: rgba(40, 74, 128, 0.20);
                border: 1px solid rgba(106, 150, 218, 0.32);
            }
            QLabel#EvidenceAttention {
                color: rgba(255, 255, 255, 0.76);
                font-size: 12px;
                font-weight: 600;
            }
            QLabel#EvidenceActivity {
                color: rgba(176, 200, 236, 0.86);
                font-size: 12px;
                font-weight: 600;
            }
            QLabel#EvidenceSnippet {
                color: rgba(255, 255, 255, 0.82);
                font-size: 14px;
            }
            QLabel#EvidenceMoment {
                color: rgba(170, 194, 230, 0.94);
                font-size: 13px;
                font-weight: 600;
            }
            QLabel#EvidenceTabs {
                color: rgba(255, 255, 255, 0.66);
                font-size: 12px;
            }
            QLabel#EvidenceContext {
                color: rgba(255, 255, 255, 0.72);
                font-size: 13px;
            }
            QLabel#EvidenceReason {
                color: rgba(255, 255, 255, 0.58);
                font-size: 12px;
                font-weight: 600;
                letter-spacing: 0.3px;
            }
            QLabel#RefineHeading {
                color: rgba(255, 255, 255, 0.62);
                font-size: 12px;
                font-weight: 700;
                letter-spacing: 1px;
            }
            QPushButton#RefineButton {
                background: rgba(255, 255, 255, 0.05);
                color: #ffffff;
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 14px;
                padding: 10px 14px;
                font-size: 13px;
                text-align: left;
                font-weight: 700;
            }
            QPushButton#RefineButton:hover {
                background: rgba(255, 255, 255, 0.10);
                border: 1px solid rgba(255, 255, 255, 0.16);
            }
            QLabel#StatusText {
                color: rgba(255, 255, 255, 0.68);
                font-size: 14px;
            }
            """
        )

        orb_size = 62
        menu_button_size = 46
        results_search_width = 706
        results_header_height = 72

        root = QWidget(self)
        self.root = root
        root.setObjectName("Root")
        layout = QVBoxLayout(root)
        layout.setContentsMargins(40, 30, 40, 30)
        layout.setSpacing(16)

        top_bar = QHBoxLayout()
        self.top_bar = top_bar
        top_bar.setSpacing(0)
        self.back_orb = QFrame()
        self.back_orb.setObjectName("MenuOrb")
        self.back_orb.setFixedSize(orb_size, orb_size)
        back_layout = QVBoxLayout(self.back_orb)
        back_layout.setContentsMargins(8, 8, 8, 8)
        self.back_button = QPushButton("\u2190")
        self.back_button.setObjectName("MenuButton")
        self.back_button.setFixedSize(menu_button_size, menu_button_size)
        self.back_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.back_button.clicked.connect(self._go_home)
        back_layout.addWidget(self.back_button, 0, Qt.AlignmentFlag.AlignCenter)

        self.reload_orb = QFrame()
        self.reload_orb.setObjectName("MenuOrb")
        self.reload_orb.setFixedSize(orb_size, orb_size)
        reload_layout = QVBoxLayout(self.reload_orb)
        reload_layout.setContentsMargins(8, 8, 8, 8)
        self.reload_button = QPushButton("\u21bb")
        self.reload_button.setObjectName("MenuButton")
        self.reload_button.setFixedSize(menu_button_size, menu_button_size)
        self.reload_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.reload_button.clicked.connect(self._reload_query)
        reload_layout.addWidget(self.reload_button, 0, Qt.AlignmentFlag.AlignCenter)

        self.compact_brand_host = QWidget()
        self.compact_brand_host.setFixedWidth(orb_size)
        brand_layout = QVBoxLayout(self.compact_brand_host)
        brand_layout.setContentsMargins(0, 0, 0, 0)
        self.compact_brand = QLabel("m")
        self.compact_brand.setObjectName("CompactBrand")
        self.compact_brand.setAlignment(Qt.AlignmentFlag.AlignCenter)
        compact_brand_font = brand_font(38)
        compact_brand_font.setBold(True)
        self.compact_brand.setFont(compact_brand_font)
        brand_layout.addWidget(self.compact_brand, 0, Qt.AlignmentFlag.AlignCenter)

        self.results_header = QWidget()
        self.results_header.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.results_header.setFixedHeight(results_header_height)
        results_header_layout = QGridLayout(self.results_header)
        self.results_header_layout = results_header_layout
        results_header_layout.setContentsMargins(0, 0, 0, 0)
        results_header_layout.setHorizontalSpacing(12)
        results_header_layout.setVerticalSpacing(0)
        self.results_left_controls = QWidget()
        results_left_layout = QHBoxLayout(self.results_left_controls)
        results_left_layout.setContentsMargins(0, 0, 0, 0)
        results_left_layout.setSpacing(14)
        self.results_divider = self._create_results_divider()
        results_left_layout.addWidget(self.compact_brand_host, 0, Qt.AlignmentFlag.AlignVCenter)
        results_left_layout.addWidget(self.back_orb, 0, Qt.AlignmentFlag.AlignVCenter)
        results_left_layout.addWidget(self.reload_orb, 0, Qt.AlignmentFlag.AlignVCenter)
        self.results_menu_orb = QFrame()
        self.results_menu_orb.setObjectName("MenuOrb")
        self.results_menu_orb.setFixedSize(orb_size, orb_size)
        results_menu_layout = QVBoxLayout(self.results_menu_orb)
        results_menu_layout.setContentsMargins(8, 8, 8, 8)
        self.results_menu_button = QPushButton("...")
        self.results_menu_button.setObjectName("MenuButton")
        self.results_menu_button.setFixedSize(menu_button_size, menu_button_size)
        self.results_menu_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.results_menu_button.clicked.connect(self._show_menu)
        results_menu_layout.addWidget(self.results_menu_button, 0, Qt.AlignmentFlag.AlignCenter)
        self.results_right_controls = QWidget()
        right_controls_layout = QHBoxLayout(self.results_right_controls)
        right_controls_layout.setContentsMargins(0, 0, 0, 0)
        right_controls_layout.setSpacing(14)
        self.results_menu_divider = self._create_results_divider()
        right_controls_layout.addWidget(self.results_menu_orb, 0, Qt.AlignmentFlag.AlignVCenter)

        results_header_layout.addWidget(
            self.results_left_controls,
            0,
            0,
            Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
        )
        results_header_layout.addWidget(
            self.results_divider,
            0,
            1,
            Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignVCenter,
        )
        results_header_layout.addWidget(
            self.results_right_controls,
            0,
            4,
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
        )
        results_header_layout.addWidget(
            self.results_menu_divider,
            0,
            3,
            Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignVCenter,
        )
        results_header_layout.setColumnStretch(0, 0)
        results_header_layout.setColumnStretch(1, 0)
        results_header_layout.setColumnStretch(2, 1)
        results_header_layout.setColumnStretch(3, 0)
        results_header_layout.setColumnStretch(4, 0)
        self.results_header.hide()
        top_bar.addWidget(
            self.results_header,
            1,
            Qt.AlignmentFlag.AlignVCenter,
        )
        self.home_menu_orb = QFrame()
        self.home_menu_orb.setObjectName("MenuOrb")
        self.home_menu_orb.setFixedSize(orb_size, orb_size)
        menu_layout = QVBoxLayout(self.home_menu_orb)
        menu_layout.setContentsMargins(8, 8, 8, 8)
        self.menu_button = QPushButton("...")
        self.menu_button.setObjectName("MenuButton")
        self.menu_button.setFixedSize(menu_button_size, menu_button_size)
        self.menu_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.menu_button.clicked.connect(self._show_menu)
        menu_layout.addWidget(self.menu_button, 0, Qt.AlignmentFlag.AlignCenter)
        self.home_menu_slot = QWidget()
        self.home_menu_slot.setFixedHeight(results_header_height)
        self.home_menu_slot.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        home_slot_layout = QHBoxLayout(self.home_menu_slot)
        home_slot_layout.setContentsMargins(0, 0, 0, 0)
        home_slot_layout.addStretch(1)
        home_slot_layout.addWidget(self.home_menu_orb, 0, Qt.AlignmentFlag.AlignVCenter)
        top_bar.addWidget(
            self.home_menu_slot,
            0,
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
        )
        layout.addLayout(top_bar)

        self.top_spacer = QSpacerItem(
            20,
            12,
            QSizePolicy.Policy.Minimum,
            QSizePolicy.Policy.Expanding,
        )
        layout.addItem(self.top_spacer)

        center = QVBoxLayout()
        center.setSpacing(0)
        center.setAlignment(Qt.AlignmentFlag.AlignHCenter)
        center.setContentsMargins(0, 0, 0, 0)
        self.center_layout = center

        title = QLabel("memact")
        title.setObjectName("HeroTitle")
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        title.setFont(brand_font(66))
        self.title_label = title

        self.search_shell = QFrame()
        self.search_shell.setObjectName("SearchShell")
        self.search_shell.setProperty("active", False)
        self.search_shell.setProperty("attached", False)
        self.search_shell.setMinimumWidth(760)
        self.search_shell.setMaximumWidth(980)
        self.search_shell.setFixedHeight(orb_size)
        self.search_shell.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        search_layout = QHBoxLayout(self.search_shell)
        search_layout.setContentsMargins(26, 12, 18, 12)
        search_layout.setSpacing(14)

        self.search_input = SearchInput()
        self.search_input.setObjectName("SearchInput")
        self.search_input.setPlaceholderText("Search")
        self.search_input.setProperty("empty", True)
        self.search_input.setProperty("preview", False)
        self.search_input.setFrame(False)
        self.search_input.setFixedHeight(34)
        self.search_input.returnPressed.connect(self._submit_query)
        self.search_input.focused.connect(self._handle_search_focus)
        self.search_input.blurred.connect(self._schedule_suggestion_hide)
        self.search_input.textChanged.connect(self._handle_query_text_changed)
        self.search_input.navigate_down.connect(self._select_next_suggestion)
        self.search_input.navigate_up.connect(self._select_previous_suggestion)
        self.search_input.accept_selection.connect(self._handle_accept_selection)
        self.search_input.commit_selection.connect(self._commit_selected_suggestion)
        self.search_input.escape_pressed.connect(self._dismiss_suggestions)
        self.search_input.typed_over_suggestion.connect(self._replace_suggestion_with_typed)
        search_layout.addWidget(self.search_input, 1)
        self.search_shell.setFocusProxy(self.search_input)

        self.search_button = QPushButton("")
        self.search_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.search_button.setObjectName("SearchButton")
        self.search_button.setFixedSize(34, 34)
        self.search_button.clicked.connect(self._submit_query)
        self._search_icon = QIcon(str(SEARCH_ICON_PATH)) if SEARCH_ICON_PATH.exists() else None
        self._enter_icon = QIcon(str(ENTER_ICON_PATH)) if ENTER_ICON_PATH.exists() else None
        if SEARCH_ICON_PATH.exists():
            self.search_button.setIcon(self._search_icon)
            self.search_button.setIconSize(self.search_button.size())
        search_layout.addWidget(self.search_button, 0, Qt.AlignmentFlag.AlignVCenter)
        self.search_shell_base_margins = (26, 12, 18, 12)

        self.header_container = QFrame()
        self.header_layout = QVBoxLayout(self.header_container)
        self.header_layout.setContentsMargins(0, 0, 0, 0)
        self.header_layout.setSpacing(8)
        self.header_layout.setAlignment(Qt.AlignmentFlag.AlignHCenter)
        self.header_layout.addWidget(self.title_label, 0, Qt.AlignmentFlag.AlignHCenter)
        self.header_layout.addWidget(self.search_shell, 0, Qt.AlignmentFlag.AlignHCenter)

        self.suggestion_dock = QFrame()
        self.suggestion_dock.setObjectName("SuggestionDock")
        self.suggestion_dock.setMinimumWidth(760)
        self.suggestion_dock.setMaximumWidth(980)
        self.suggestion_dock.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Fixed)
        self._suggestion_row_height = 66
        self._suggestion_visible_limit = 6
        dock_layout = QVBoxLayout(self.suggestion_dock)
        dock_layout.setContentsMargins(10, 8, 10, 12)
        dock_layout.setSpacing(2)
        self.suggestion_heading = QLabel("")
        self.suggestion_heading.setObjectName("SuggestionHeading")
        self.suggestion_heading.hide()
        dock_layout.addWidget(self.suggestion_heading)
        self.time_chip_row = QFrame()
        self.time_chip_row.setObjectName("TimeChipRow")
        self.time_chip_row.hide()
        self._time_chip_buttons: dict[str, QPushButton] = {}
        time_chip_layout = QHBoxLayout(self.time_chip_row)
        time_chip_layout.setContentsMargins(0, 0, 0, 6)
        time_chip_layout.setSpacing(8)
        for phrase in ("Today", "Yesterday", "This week", "Last week"):
            chip = QPushButton(phrase)
            chip.setObjectName("TimeFilterChip")
            chip.setCursor(Qt.CursorShape.PointingHandCursor)
            phrase_value = phrase.lower()
            chip.clicked.connect(lambda _checked=False, value=phrase_value: self._apply_time_chip(value))
            time_chip_layout.addWidget(chip, 0, Qt.AlignmentFlag.AlignLeft)
            self._time_chip_buttons[phrase_value] = chip
        time_chip_layout.addStretch(1)
        dock_layout.addWidget(self.time_chip_row)
        self.suggestion_scroll = QScrollArea()
        self.suggestion_scroll.setObjectName("SuggestionScroll")
        self.suggestion_scroll.setWidgetResizable(True)
        self.suggestion_scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff)
        self.suggestion_scroll.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAsNeeded)
        self.suggestion_content = QWidget()
        self.suggestions_layout = QVBoxLayout(self.suggestion_content)
        self.suggestions_layout.setContentsMargins(0, 0, 0, 0)
        self.suggestions_layout.setSpacing(8)
        self.suggestion_scroll.setWidget(self.suggestion_content)
        dock_layout.addWidget(self.suggestion_scroll)

        self.answer_card = QFrame()
        self.answer_card.setObjectName("AnswerCard")
        self.answer_card.setMinimumWidth(760)
        self.answer_card.setMaximumWidth(self._max_answer_width if hasattr(self, "_max_answer_width") else 1400)
        self.answer_card.setMinimumHeight(0)
        answer_layout = QVBoxLayout(self.answer_card)
        answer_layout.setContentsMargins(22, 20, 22, 20)
        answer_layout.setSpacing(12)

        self.answer_eyebrow = QLabel("LOCAL ANSWER")
        self.answer_eyebrow.setObjectName("AnswerEyebrow")
        self.answer_text = QLabel("")
        self.answer_text.setObjectName("AnswerText")
        self.answer_text.setWordWrap(True)
        self.answer_text.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Minimum)
        self.answer_summary = QLabel("")
        self.answer_summary.setObjectName("AnswerSummary")
        self.answer_summary.setWordWrap(True)
        self.answer_summary.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Minimum)
        self.session_heading = QLabel("EPISODIC GRAPH")
        self.session_heading.setObjectName("SessionHeading")
        self.session_heading.setVisible(False)
        self.session_summary = QLabel("")
        self.session_summary.setObjectName("SessionSummary")
        self.session_summary.setWordWrap(True)
        self.session_summary.setSizePolicy(QSizePolicy.Policy.Preferred, QSizePolicy.Policy.Minimum)
        self.session_summary.setVisible(False)
        self.session_action_row = FlowLayout(spacing=8)
        self.session_action_row.setSpacing(8)
        self.session_action_row.setContentsMargins(0, 0, 0, 0)
        self.session_action_host = QWidget()
        self.session_action_host.setLayout(self.session_action_row)
        self.session_action_host.setVisible(False)
        self.details_button = QPushButton("View details")
        self.details_button.setObjectName("DetailsButton")
        self.details_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.details_button.clicked.connect(self._toggle_details)

        self.refine_heading = QLabel("REFINE SEARCH")
        self.refine_heading.setObjectName("RefineHeading")
        self.refine_heading.setVisible(False)
        self.refine_row = FlowLayout(spacing=8)
        self.refine_row.setSpacing(8)
        self.refine_row.setContentsMargins(0, 0, 0, 0)
        self.refine_host = QWidget()
        self.refine_host.setLayout(self.refine_row)
        self.refine_host.setVisible(False)

        self.evidence_scroll = QScrollArea()
        self.evidence_scroll.setObjectName("EvidenceScroll")
        self.evidence_scroll.setWidgetResizable(True)
        self.evidence_scroll.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Minimum)
        self.evidence_scroll.setVisible(False)
        self.evidence_content = QWidget()
        self.evidence_layout = QVBoxLayout(self.evidence_content)
        self.evidence_layout.setContentsMargins(0, 0, 0, 0)
        self.evidence_layout.setSpacing(10)
        self.evidence_scroll.setWidget(self.evidence_content)

        answer_layout.addWidget(self.answer_eyebrow)
        answer_layout.addWidget(self.answer_text)
        answer_layout.addWidget(self.answer_summary)
        answer_layout.addWidget(self.session_heading)
        answer_layout.addWidget(self.session_summary)
        answer_layout.addWidget(self.session_action_host)
        answer_layout.addWidget(self.refine_heading)
        answer_layout.addWidget(self.refine_host)
        answer_layout.addWidget(self.details_button, 0, Qt.AlignmentFlag.AlignLeft)
        answer_layout.addWidget(self.evidence_scroll)

        self.status_text = QLabel("")
        self.status_text.setObjectName("StatusText")
        self.status_text.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.loading_bar = QProgressBar()
        self.loading_bar.setObjectName("LoadingBar")
        self.loading_bar.setTextVisible(False)
        self.loading_bar.setRange(0, 100)
        self.loading_bar.setFixedHeight(4)
        self.loading_bar.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        self.loading_bar.hide()

        self.results_separator = QFrame()
        self.results_separator.setObjectName("ResultsShadow")
        self.results_separator.setFixedHeight(4)
        self.results_separator.setSizePolicy(
            QSizePolicy.Policy.Expanding,
            QSizePolicy.Policy.Fixed,
        )
        self.results_separator.hide()

        center.addSpacing(0)
        center.addWidget(self.header_container, 0, Qt.AlignmentFlag.AlignCenter)
        center.addSpacing(8)
        center.addWidget(self.answer_card, 0, Qt.AlignmentFlag.AlignCenter)

        layout.addLayout(center)
        self.bottom_spacer = QSpacerItem(
            20,
            260,
            QSizePolicy.Policy.Minimum,
            QSizePolicy.Policy.Expanding,
        )
        layout.addItem(self.bottom_spacer)
        layout.addWidget(self.status_text, 0, Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignBottom)

        self.setCentralWidget(root)
        self.loading_bar.setParent(self.root)
        self.results_separator.setParent(self.root)
        self.suggestion_dock.setParent(self.root)
        self.answer_card.hide()
        self.results_separator.hide()
        self.suggestion_dock.hide()
        self._apply_responsive_sizes()
        self._position_suggestion_dock()
        self._position_results_shadow()
        self._position_loading_bar()

    def _build_tray(self) -> None:
        if not QSystemTrayIcon.isSystemTrayAvailable():
            QApplication.instance().setQuitOnLastWindowClosed(True)
            self.tray = None
            return
        self.tray = QSystemTrayIcon(app_icon(64), self)
        self.tray.setToolTip("Memact — Query the Past.")
        tray_menu = QMenu(self)
        tray_menu.setFont(body_font(12))
        tray_menu.setStyleSheet(self._menu_stylesheet())
        tray_menu.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self._apply_menu_shadow(tray_menu)
        self._enable_menu_cursor(tray_menu)
        self._configure_tray_menu(tray_menu)
        show_action = QAction("Show", self)
        show_action.triggered.connect(self.show_window)
        tray_menu.addAction(show_action)
        tray_menu.addSeparator()
        self._add_quit_action(tray_menu)
        # Don't use setContextMenu() on Windows; it can force a native menu with square corners
        # and OS-controlled placement (often expanding into the taskbar). We'll position it ourselves.
        self.tray_menu = tray_menu
        self.tray.activated.connect(self._handle_tray_click)
        self.tray.show()

    def _build_menu(self) -> None:
        self.overflow_menu = QMenu(self)
        self.overflow_menu.setStyleSheet(self._menu_stylesheet())
        self.overflow_menu.setAttribute(Qt.WidgetAttribute.WA_TranslucentBackground, True)
        self._apply_menu_shadow(self.overflow_menu)
        self._enable_menu_cursor(self.overflow_menu)
        install_action = self.overflow_menu.addAction("Install Browser Extension")
        install_action.triggered.connect(self._open_browser_setup_from_menu)
        history_action = self.overflow_menu.addAction("Search History")
        history_action.triggered.connect(self._show_search_history)
        privacy_action = self.overflow_menu.addAction("Privacy Notice")
        privacy_action.triggered.connect(self._show_privacy_dialog)
        self.overflow_menu.addSeparator()
        self._add_quit_action(self.overflow_menu)

    def _show_loading_state(self) -> None:
        self.status_text.setText("Starting your local memory engine...")
        self._render_suggestions([], heading="")

    def _initialize_runtime_async(self) -> None:
        if self._db_ready:
            return
        threading.Thread(target=self._initialize_runtime_worker, daemon=True).start()

    def _initialize_runtime_worker(self) -> None:
        try:
            init_db()
        except Exception as exc:
            logger.exception("Failed to initialize local database")
            self._bridge.runtime_failed.emit(str(exc))
            return
        self._bridge.runtime_ready.emit()

    def _finish_runtime_initialization(self) -> None:
        if self._db_ready:
            return
        self._db_ready = True
        self.status_text.setText("Ready. Query the Past.")
        QTimer.singleShot(150, self._start_background_services)
        QTimer.singleShot(900, self._maybe_show_browser_setup)
        warmup_query_engine()

    def _handle_runtime_failed(self, message: str) -> None:
        self.status_text.setText("Memact could not start the local database.")
        self._set_loading(False)
        self._show_info_dialog(
            "Memact",
            f"The local database failed to start. Details: {message}",
        )

    def _start_background_services(self) -> None:
        if self._services_started:
            return
        self.browser_bridge.start()
        self.monitor.start()
        self._services_started = True
        QTimer.singleShot(1200, self._check_bridge_startup)

    def _check_bridge_startup(self) -> None:
        if self.browser_bridge.error:
            self.status_text.setText(
                "Browser bridge could not start. The extension may not connect."
            )

    def _refresh_suggestions(self) -> None:
        if not self._db_ready:
            return
        if not self.search_input.hasFocus():
            self.suggestion_dock.hide()
            return
        self._suggestion_timer.start()

    def _refresh_suggestions_immediately(self) -> None:
        if not self._db_ready or not self.search_input.hasFocus():
            return
        self._suggestion_timer.stop()
        self._kickoff_suggestion_refresh()

    def _set_search_active(self, active: bool) -> None:
        self._search_active = active
        self.search_shell.setProperty("active", active)
        self.search_shell.style().unpolish(self.search_shell)
        self.search_shell.style().polish(self.search_shell)
        self.search_shell.update()

    def _set_loading(self, active: bool) -> None:
        if not hasattr(self, "loading_bar"):
            return
        if active:
            self._loading_progress = 0
            self.loading_bar.setRange(0, 100)
            self.loading_bar.setValue(0)
            self.loading_bar.show()
            self._position_loading_bar()
            self.loading_bar.raise_()
            if not self._loading_timer.isActive():
                self._loading_timer.start()
        else:
            if self._loading_timer.isActive():
                self._loading_timer.stop()
            self.loading_bar.setRange(0, 100)
            self.loading_bar.setValue(100)
            QTimer.singleShot(140, self.loading_bar.hide)

    def _tick_loading(self) -> None:
        if not self.loading_bar.isVisible():
            return
        value = int(self.loading_bar.value())
        if value < 70:
            value += 3
        elif value < 90:
            value += 2
        elif value < 95:
            value += 1
        else:
            value = 95
        self.loading_bar.setValue(value)

    def _position_loading_bar(self) -> None:
        if not hasattr(self, "loading_bar"):
            return
        height = self.loading_bar.height()
        width = self.root.width()
        self.loading_bar.setGeometry(0, self.root.height() - height, width, height)

    def _position_results_shadow(self) -> None:
        if not hasattr(self, "results_separator"):
            return
        if not self.results_separator.isVisible() or not self._results_mode:
            return
        anchor = self.results_header.mapTo(self.root, QPoint(0, 0))
        y = anchor.y() + self.results_header.height() + 12
        self.results_separator.setGeometry(0, y, self.root.width(), self.results_separator.height())

    def _handle_search_focus(self) -> None:
        self._set_search_active(True)
        self._update_time_chip_state()
        if self._should_show_time_chips() and self._cached_empty_suggestions is None:
            self._render_suggestions([], heading="SUGGESTIONS")
        self._refresh_suggestions_immediately()
        self._update_search_button()

    def _should_show_time_chips(self) -> bool:
        return self.search_input.hasFocus() and not self.search_input.text().strip()

    def _update_time_chip_visibility(self) -> bool:
        visible = self._should_show_time_chips()
        if hasattr(self, "time_chip_row"):
            self.time_chip_row.setVisible(visible)
        return visible

    def _update_time_chip_state(self) -> None:
        if not hasattr(self, "_time_chip_buttons"):
            return
        active = (self._active_time_filter or "").casefold()
        for phrase, chip in self._time_chip_buttons.items():
            is_active = phrase.casefold() == active
            chip.setProperty("active", is_active)
            chip.style().unpolish(chip)
            chip.style().polish(chip)
            chip.update()

    def _kickoff_suggestion_refresh(self) -> None:
        if not self._db_ready or not self.search_input.hasFocus():
            return
        text = self.search_input.text().strip()
        heading = "SUGGESTIONS"
        if not text and self._active_time_filter is None and self._cached_empty_suggestions is not None:
            self._render_suggestions(self._cached_empty_suggestions, heading=heading)
            return
        self.suggestion_heading.setText(heading)
        self.suggestion_heading.setVisible(bool(heading))
        request_id = self._suggestion_request_id + 1
        self._suggestion_request_id = request_id
        threading.Thread(
            target=self._suggestion_worker,
            args=(request_id, text, heading),
            daemon=True,
        ).start()

    def _suggestion_worker(self, request_id: int, text: str, heading: str) -> None:
        try:
            suggestions = (
                autocomplete_suggestions(text, limit=5)
                if text
                else dynamic_suggestions(limit=4, time_filter=self._active_time_filter)
            )
        except Exception:
            logger.exception("Suggestion worker failed")
            suggestions = []
        self._bridge.suggestions_ready.emit(suggestions, request_id, text, heading)

    def _handle_suggestions_ready(
        self,
        suggestions: list[SearchSuggestion],
        request_id: int,
        text: str,
        heading: str,
    ) -> None:
        if request_id != self._suggestion_request_id:
            return
        if not self.search_input.hasFocus():
            return
        if self.search_input.text().strip() != text:
            return
        if not text and self._active_time_filter is None:
            self._cached_empty_suggestions = suggestions
        self._render_suggestions(suggestions, heading=heading)

    def _sync_back_button(self) -> None:
        show_back = bool(self.search_input.text().strip()) or self.answer_card.isVisible()
        self.back_orb.setVisible(show_back)
        self.reload_orb.setVisible(show_back)
        if hasattr(self, "results_divider"):
            self.results_divider.setVisible(show_back)
        if hasattr(self, "results_menu_divider"):
            self.results_menu_divider.setVisible(show_back)

    def _menu_stylesheet(self) -> str:
        return """
            QMenu {
                background: #00011B;
                color: #ffffff;
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 16px;
                padding: 8px;
            }
            QMenu::item {
                padding: 10px 18px;
                border-radius: 12px;
                background: transparent;
                margin: 2px 0;
            }
            QMenu::item:selected {
                background: rgba(255, 255, 255, 0.1);
            }
            QMenu::separator {
                height: 1px;
                background: rgba(255, 255, 255, 0.2);
                margin: 8px 10px;
            }
            QPushButton#MenuDangerButton {
                background: transparent;
                color: #ffffff;
                border: none;
                border-radius: 12px;
                padding: 10px 18px;
                text-align: left;
            }
            QPushButton#MenuDangerButton:hover {
                background: rgba(255, 86, 86, 0.16);
                border: none;
            }
        """

    def _apply_menu_shadow(self, menu: QMenu) -> None:
        shadow = QGraphicsDropShadowEffect(menu)
        shadow.setBlurRadius(26)
        shadow.setOffset(0, 8)
        shadow.setColor(QColor(255, 255, 255, 36))
        menu.setGraphicsEffect(shadow)

    def _configure_tray_menu(self, menu: QMenu) -> None:
        menu.setFocusPolicy(Qt.FocusPolicy.NoFocus)
        flags = menu.windowFlags()
        flags |= Qt.WindowType.Popup
        flags |= Qt.WindowType.FramelessWindowHint
        flags |= Qt.WindowType.WindowStaysOnTopHint
        menu.setWindowFlags(flags)
        menu.setAttribute(Qt.WidgetAttribute.WA_ShowWithoutActivating, True)

    def _enable_menu_cursor(self, menu: QMenu) -> None:
        menu.setMouseTracking(True)
        menu.installEventFilter(self)

    def _add_quit_action(self, menu: QMenu) -> None:
        quit_action = QWidgetAction(menu)
        quit_button = QPushButton("Quit")
        quit_button.setObjectName("MenuDangerButton")
        quit_button.setCursor(Qt.CursorShape.PointingHandCursor)
        quit_button.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
        quit_button.clicked.connect(self.quit_app)
        quit_action.setDefaultWidget(quit_button)
        menu.addAction(quit_action)

    def _render_suggestions(self, suggestions: list[SearchSuggestion], *, heading: str) -> None:
        self._visible_suggestion_cards = []
        self._selected_suggestion_index = -1
        self.search_input.setProperty("suggestionSelected", False)
        self._set_preview_state(False)
        while self.suggestions_layout.count():
            item = self.suggestions_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        chips_visible = self._update_time_chip_visibility()
        show_heading = bool(heading) and bool(suggestions) and not chips_visible
        self.suggestion_heading.setText(heading)
        self.suggestion_heading.setVisible(show_heading)
        typed_query_mode = bool(self.search_input.text().strip())
        row_height = 92 if typed_query_mode else self._suggestion_row_height
        for suggestion in suggestions:
            card = SuggestionCard(suggestion)
            card.setMinimumHeight(row_height)
            card.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
            card.clicked.connect(self._apply_suggestion)
            card.hovered.connect(self._select_suggestion_by_completion)
            card.unhovered.connect(self._schedule_hover_preview_reset)
            card.setMinimumWidth(520)
            self.suggestions_layout.addWidget(card)
            self._visible_suggestion_cards.append(card)
        visible_rows = min(len(suggestions), self._suggestion_visible_limit)
        heading_height = self.suggestion_heading.sizeHint().height() if self.suggestion_heading.isVisible() else 0
        chip_height = self.time_chip_row.sizeHint().height() if chips_visible else 0
        _, top_margin, _, bottom_margin = self.suggestion_dock.layout().getContentsMargins()
        desired_scroll_height = 0
        if visible_rows:
            desired_scroll_height = (
                visible_rows * row_height
                + max(visible_rows - 1, 0) * self.suggestions_layout.spacing()
            )
        anchor_pos = self.search_shell.mapTo(self.root, QPoint(0, 0))
        available_below = max(
            self.root.height() - (anchor_pos.y() + self.search_shell.height()) - 20,
            self._suggestion_row_height if suggestions else 0,
        )
        max_scroll_height = max(
            0,
            available_below
            - top_margin
            - bottom_margin
            - (heading_height + self.suggestion_dock.layout().spacing() if heading_height else 0)
            - (chip_height + self.suggestion_dock.layout().spacing() if chip_height else 0),
        )
        scroll_height = min(desired_scroll_height, max_scroll_height)
        self.suggestion_scroll.setFixedHeight(scroll_height)
        dock_height = top_margin + bottom_margin + scroll_height
        if heading_height:
            dock_height += heading_height + self.suggestion_dock.layout().spacing()
        if chip_height:
            dock_height += chip_height + self.suggestion_dock.layout().spacing()
        self.suggestion_dock.setFixedHeight(max(dock_height, 0))
        dock_width = self.search_shell.width()
        if dock_width:
            self.suggestion_dock.setMinimumWidth(dock_width)
            self.suggestion_dock.setMaximumWidth(dock_width)
            self.suggestion_dock.setFixedWidth(dock_width)
        dock_visible = bool(suggestions) or chips_visible
        self._set_hero_shifted(dock_visible)
        self.suggestion_dock.setVisible(dock_visible)
        self._sync_results_visibility_for_suggestions(dock_visible)
        self._set_search_attached(dock_visible)
        QTimer.singleShot(0, self._reveal_suggestion_dock)
        self._sync_back_button()

    def _set_search_attached(self, attached: bool) -> None:
        self.search_shell.setProperty("attached", attached)
        self.suggestion_dock.setProperty("attached", attached)
        self.search_shell.style().unpolish(self.search_shell)
        self.search_shell.style().polish(self.search_shell)
        self.suggestion_dock.style().unpolish(self.suggestion_dock)
        self.suggestion_dock.style().polish(self.suggestion_dock)
        self.search_shell.update()
        self.suggestion_dock.update()

    def _sync_results_visibility_for_suggestions(self, suggestions_visible: bool) -> None:
        if not self._results_mode:
            return
        show_results = (not suggestions_visible) and (self._last_answer is not None)
        self.answer_card.setVisible(show_results)
        if hasattr(self, "results_separator"):
            self.results_separator.setVisible(show_results)

    def _update_search_button(self) -> None:
        has_text = bool(self.search_input.text())
        if has_text and self.search_input.hasFocus():
            self.search_button.setText("")
            if self._enter_icon is not None:
                self.search_button.setIcon(self._enter_icon)
        else:
            self.search_button.setText("")
            if self._search_icon is not None:
                self.search_button.setIcon(self._search_icon)

    def _apply_responsive_sizes(self) -> None:
        if not hasattr(self, "_min_content_width"):
            self._min_content_width = 640
            self._max_content_width = 1280
            self._min_results_search_width = 520
            self._max_results_search_width = 1200
            self._max_answer_width = 1400
            self._orb_size = 62
            self._results_header_height = 72
            self._menu_button_size = 46

        margins = self.root.layout().contentsMargins()
        available = max(self.root.width() - (margins.left() + margins.right()), 600)

        def clamp(value: int, low: int, high: int) -> int:
            return max(low, min(high, value))

        min_content_width = min(self._min_content_width, available)
        left_width = self.results_left_controls.sizeHint().width()
        right_width = self.results_right_controls.sizeHint().width()
        spacing = self.results_header_layout.horizontalSpacing()
        divider_left = self.results_divider.width() if hasattr(self, "results_divider") else 0
        divider_right = self.results_menu_divider.width() if hasattr(self, "results_menu_divider") else 0
        center_available = max(
            1,
            available - left_width - right_width - divider_left - divider_right - (spacing * 4),
        )
        center_safe = max(1, center_available - 12)
        min_width = min(self._min_content_width, center_available)
        home_ratio = 0.68 if self.isMaximized() else 0.72
        preferred_search_width = clamp(
            int(available * home_ratio),
            min_width,
            min(self._max_results_search_width, center_safe),
        )
        home_width = preferred_search_width

        if self._results_mode:
            answer_max = available
        else:
            answer_max = min(self._max_answer_width, available)
        answer_width = clamp(int(available * 0.86), 700, answer_max)

        self.search_shell.setFixedWidth(home_width)
        self.search_shell.setFixedHeight(self._orb_size)
        self.header_container.setFixedWidth(home_width)
        self.suggestion_dock.setMinimumWidth(home_width)
        self.suggestion_dock.setMaximumWidth(home_width)
        self.suggestion_dock.setFixedWidth(home_width)
        self.answer_card.setFixedWidth(answer_width)

        self.results_header_layout.setColumnMinimumWidth(0, left_width)
        self.results_header_layout.setColumnMinimumWidth(4, right_width)

        self.home_menu_slot.setFixedHeight(self._results_header_height)
        self.search_shell.updateGeometry()
        self.header_container.updateGeometry()
        self.answer_card.updateGeometry()
        self.results_header.updateGeometry()
        self._position_results_shadow()
        self._position_loading_bar()
        if self.suggestion_dock.isVisible():
            QTimer.singleShot(0, self._position_suggestion_dock)

    def _settle_layout(self) -> None:
        self.root.layout().invalidate()
        self.root.layout().activate()
        if hasattr(self, "results_header_layout"):
            self.results_header_layout.invalidate()
            self.results_header_layout.activate()
        self._apply_responsive_sizes()
        self._refresh_answer_card_geometry()
        self._position_results_shadow()
        self._position_loading_bar()

    def _set_results_mode(self, active: bool) -> None:
        if self._results_mode == active:
            return
        self._results_mode = active
        self.center_layout.removeWidget(self.header_container)
        if active:
            self.title_label.hide()
            self.results_header.show()
            self.home_menu_slot.hide()
            if hasattr(self, "results_separator"):
                self.results_separator.show()
                self._position_results_shadow()
            if self.results_header_layout.indexOf(self.header_container) == -1:
                self.results_header_layout.addWidget(
                    self.header_container,
                    0,
                    2,
                    Qt.AlignmentFlag.AlignHCenter | Qt.AlignmentFlag.AlignVCenter,
                )
            self.header_layout.setSpacing(0)
            self.header_container.setFixedHeight(self._orb_size)
            self.top_spacer.changeSize(20, 8, QSizePolicy.Policy.Minimum, QSizePolicy.Policy.Fixed)
        else:
            self.results_header.hide()
            self.home_menu_slot.show()
            self.title_label.show()
            if hasattr(self, "results_separator"):
                self.results_separator.hide()
            self.results_header_layout.removeWidget(self.header_container)
            self.header_container.setMinimumHeight(0)
            self.header_container.setMaximumHeight(16777215)
            self.header_layout.setSpacing(8)
            self.center_layout.insertWidget(3, self.header_container, 0, Qt.AlignmentFlag.AlignCenter)
            self.top_spacer.changeSize(20, 12, QSizePolicy.Policy.Minimum, QSizePolicy.Policy.Expanding)
        self.root.layout().invalidate()
        self.root.layout().activate()
        self._apply_responsive_sizes()
        self._position_suggestion_dock()
        QTimer.singleShot(0, self._settle_layout)

    def _set_preview_state(self, active: bool) -> None:
        self.search_input.setProperty("preview", active)
        if not active:
            self.search_input.setProperty("suggestionSelected", False)
        self.search_input.style().unpolish(self.search_input)
        self.search_input.style().polish(self.search_input)
        self.search_input.update()

    def _show_query_start(self) -> None:
        self.search_input.setCursorPosition(0)
        self.search_input.deselect()

    def _select_suggestion(self, index: int) -> None:
        if not self._visible_suggestion_cards:
            return
        index = max(0, min(index, len(self._visible_suggestion_cards) - 1))
        self._selected_suggestion_index = index
        self.search_input.setProperty("suggestionSelected", True)
        self._set_preview_state(True)
        for current, card in enumerate(self._visible_suggestion_cards):
            active = current == index
            card.setProperty("active", active)
            card.style().unpolish(card)
            card.style().polish(card)
        completion = self._visible_suggestion_cards[index]._completion
        self.search_input.blockSignals(True)
        self.search_input.setText(completion)
        self.search_input.blockSignals(False)

    def _replace_suggestion_with_typed(self, text: str) -> None:
        if not text:
            return
        base = self._typed_query_before_selection
        next_text = f"{base}{text}"
        self.search_input.setProperty("suggestionSelected", False)
        self._set_preview_state(False)
        self.search_input.blockSignals(True)
        self.search_input.setText(next_text)
        self.search_input.blockSignals(False)
        self.search_input.setCursorPosition(len(next_text))
        self._update_search_button()

    def _select_suggestion_by_completion(self, completion: str) -> None:
        for index, card in enumerate(self._visible_suggestion_cards):
            if card._completion == completion:
                if self._selected_suggestion_index == -1:
                    self._typed_query_before_selection = self.search_input.text()
                self._select_suggestion(index)
                return

    def _schedule_hover_preview_reset(self) -> None:
        self._hover_reset_timer.start()

    def _clear_preview_if_idle(self) -> None:
        if any(bool(card.property("hovered")) for card in self._visible_suggestion_cards):
            return
        if self._selected_suggestion_index >= 0:
            for card in self._visible_suggestion_cards:
                card.setProperty("active", False)
                card.style().unpolish(card)
                card.style().polish(card)
        self._selected_suggestion_index = -1
        self.search_input.setProperty("suggestionSelected", False)
        self.search_input.blockSignals(True)
        self.search_input.setText(self._typed_query_before_selection)
        self.search_input.blockSignals(False)
        self._set_preview_state(False)
        self._update_search_button()

    def _select_next_suggestion(self) -> None:
        if not self.suggestion_dock.isVisible() or not self._visible_suggestion_cards:
            return
        if self._selected_suggestion_index == -1:
            self._typed_query_before_selection = self.search_input.text()
            self._select_suggestion(0)
            return
        self._select_suggestion((self._selected_suggestion_index + 1) % len(self._visible_suggestion_cards))

    def _select_previous_suggestion(self) -> None:
        if not self.suggestion_dock.isVisible() or not self._visible_suggestion_cards:
            return
        if self._selected_suggestion_index == -1:
            self._typed_query_before_selection = self.search_input.text()
            self._select_suggestion(len(self._visible_suggestion_cards) - 1)
            return
        self._select_suggestion((self._selected_suggestion_index - 1) % len(self._visible_suggestion_cards))

    def _handle_accept_selection(self) -> None:
        if self.suggestion_dock.isVisible() and self._selected_suggestion_index >= 0:
            self._apply_suggestion(self._visible_suggestion_cards[self._selected_suggestion_index]._completion)
            return
        self._submit_query()

    def _commit_selected_suggestion(self) -> None:
        if not self.suggestion_dock.isVisible() or self._selected_suggestion_index < 0:
            return
        completion = self._visible_suggestion_cards[self._selected_suggestion_index]._completion
        self.search_input.blockSignals(True)
        self.search_input.setText(completion)
        self.search_input.blockSignals(False)
        self._typed_query_before_selection = completion
        self.search_input.setProperty("suggestionSelected", False)
        self._set_preview_state(False)
        self._update_search_button()

    def _dismiss_suggestions(self) -> None:
        self.suggestion_dock.hide()
        self._sync_results_visibility_for_suggestions(False)
        self._update_time_chip_visibility()
        self._set_search_attached(False)
        self.search_input.setProperty("suggestionSelected", False)
        if self._selected_suggestion_index >= 0:
            self.search_input.blockSignals(True)
            self.search_input.setText(self._typed_query_before_selection)
            self.search_input.blockSignals(False)
        self._set_preview_state(False)
        self._selected_suggestion_index = -1
        self._update_search_button()

    def _apply_suggestion(self, value: str) -> None:
        self._typed_query_before_selection = value
        self.search_input.setProperty("suggestionSelected", False)
        self._set_preview_state(False)
        self.search_input.blockSignals(True)
        self.search_input.setText(value)
        self.search_input.blockSignals(False)
        self.search_input.style().unpolish(self.search_input)
        self.search_input.style().polish(self.search_input)
        self.search_input.update()
        self._update_search_button()
        self._submit_query()

    def _apply_time_chip(self, phrase: str) -> None:
        next_filter = None if (self._active_time_filter or "").casefold() == phrase.casefold() else phrase
        self._active_time_filter = next_filter
        self._cached_empty_suggestions = None
        self._update_time_chip_state()
        self.search_input.setFocus(Qt.FocusReason.OtherFocusReason)
        self._refresh_suggestions_immediately()

    def _schedule_suggestion_hide(self) -> None:
        QTimer.singleShot(140, self._hide_suggestions_if_idle)

    def _hide_suggestions_if_idle(self) -> None:
        focused = QApplication.focusWidget()
        if focused is self.search_input:
            return
        if focused is not None and self.suggestion_dock.isAncestorOf(focused):
            return
        if isinstance(focused, SuggestionCard):
            return
        self.suggestion_dock.hide()
        self._sync_results_visibility_for_suggestions(False)
        self._update_time_chip_visibility()
        self._set_search_attached(False)
        self.search_input.setProperty("suggestionSelected", False)
        self._selected_suggestion_index = -1
        self._set_preview_state(False)
        if not self.search_input.text().strip():
            self._set_search_active(False)
        self._set_hero_shifted(False)
        self._sync_back_button()
        self._update_search_button()

    def _set_hero_shifted(self, shifted: bool) -> None:
        if self._hero_shifted == shifted:
            return
        self._hero_shifted = shifted
        if shifted:
            if self.status_text.text():
                self._status_text_cached = self.status_text.text()
            self.status_text.setText("")
        else:
            if self._status_text_cached and not self.status_text.text():
                self.status_text.setText(self._status_text_cached)

    def _position_suggestion_dock(self) -> None:
        anchor_pos = self.search_shell.mapTo(self.root, QPoint(0, 0))
        dock_width = self.search_shell.width()
        self.suggestion_dock.setMinimumWidth(dock_width)
        self.suggestion_dock.setMaximumWidth(dock_width)
        self.suggestion_dock.resize(dock_width, self.suggestion_dock.height())
        x = anchor_pos.x()
        y = anchor_pos.y() + self.search_shell.height() - 1
        self.suggestion_dock.move(x, y)
        self.suggestion_dock.raise_()
        self.search_shell.raise_()

    def _reveal_suggestion_dock(self) -> None:
        self._position_suggestion_dock()
        self.search_shell.raise_()

    def _handle_query_text_changed(self, text: str) -> None:
        selected_completion = None
        if 0 <= self._selected_suggestion_index < len(self._visible_suggestion_cards):
            selected_completion = self._visible_suggestion_cards[self._selected_suggestion_index]._completion
        if bool(self.search_input.property("suggestionSelected")) and text != selected_completion:
            self._selected_suggestion_index = -1
            self.search_input.setProperty("suggestionSelected", False)
            self._set_preview_state(False)
            for card in self._visible_suggestion_cards:
                card.setProperty("active", False)
                card.style().unpolish(card)
                card.style().polish(card)
        if not bool(self.search_input.property("suggestionSelected")):
            self._typed_query_before_selection = text
        if text.strip() and self._active_time_filter is not None:
            self._active_time_filter = None
            self._update_time_chip_state()
        self.search_input.setProperty("empty", not bool(text))
        self.search_input.style().unpolish(self.search_input)
        self.search_input.style().polish(self.search_input)
        self.search_input.update()
        self._update_time_chip_visibility()
        self._update_search_button()
        self._sync_back_button()
        if text.strip():
            self._set_search_active(True)
            if len(text.strip()) <= 2:
                self._refresh_suggestions_immediately()
            else:
                self._suggestion_timer.start()
        else:
            if self.search_input.hasFocus():
                self._set_search_active(True)
                if self._cached_empty_suggestions is None:
                    self._render_suggestions([], heading="SUGGESTIONS")
                self._refresh_suggestions_immediately()
            else:
                self.suggestion_dock.hide()
                self._sync_results_visibility_for_suggestions(False)
                self._set_search_attached(False)
                self._set_search_active(False)
                self._set_hero_shifted(False)

    def _go_home(self) -> None:
        self._reset_home_state(clear_query=True)

    def _reload_query(self) -> None:
        if self.search_input.text().strip():
            self._submit_query()

    def _reset_home_state(self, *, clear_query: bool) -> None:
        self._set_results_mode(False)
        self.suggestion_dock.hide()
        self._set_search_attached(False)
        self.search_input.setProperty("suggestionSelected", False)
        self._set_preview_state(False)
        self.answer_card.hide()
        self.results_separator.hide()
        self._set_loading(False)
        self._clear_evidence_cards()
        self.evidence_scroll.hide()
        self.answer_summary.clear()
        self._render_session_context(None)
        self._render_related_queries([])
        self._last_answer = None
        self.search_button.setEnabled(True)
        if clear_query:
            self._typed_query_before_selection = ""
            self._active_time_filter = None
            self._update_time_chip_state()
            self.search_input.clear()
            self.search_input.clearFocus()
            self._update_time_chip_visibility()
            self._update_search_button()
        else:
            if self.search_input.text():
                self._show_query_start()
        self._set_search_active(False)
        self._set_hero_shifted(False)
        if self._db_ready:
            self.status_text.setText("Ready. Query the Past.")
        else:
            self.status_text.setText("Starting your local memory engine...")
        self._sync_back_button()

    def _submit_query(self) -> None:
        query = self.search_input.text().strip()
        if not query:
            self._reset_home_state(clear_query=False)
            return
        self.search_input.clearFocus()
        if not self._db_ready:
            self.status_text.setText("Still starting up. Your local memory engine is not ready yet.")
            return
        self._query_request_id += 1
        request_id = self._query_request_id
        self._typed_query_before_selection = query
        add_history(query)
        self.search_input.setProperty("suggestionSelected", False)
        self._set_preview_state(False)
        self.status_text.setText("Searching locally...")
        self.search_button.setEnabled(False)
        self._set_loading(True)
        self.search_input.clearFocus()
        self._suggestion_timer.stop()
        self.suggestion_dock.hide()
        self._sync_results_visibility_for_suggestions(False)
        self._update_time_chip_visibility()
        self._set_search_attached(False)
        threading.Thread(
            target=self._query_worker,
            args=(request_id, query),
            daemon=True,
        ).start()

    def _query_worker(self, request_id: int, query: str) -> None:
        try:
            answer = answer_query(query)
        except Exception as exc:
            logger.exception("Query worker failed")
            answer = QueryAnswer(
                answer="I hit a local error while searching.",
                summary=f"Memact could not complete that query. Details: {exc}",
                details_label="",
                evidence=[],
                time_scope_label=None,
                result_count=0,
                related_queries=[],
            )
        self._bridge.query_answer_ready.emit(answer, request_id, query)

    def _handle_query_answer_ready(self, answer: QueryAnswer, request_id: int, query: str) -> None:
        if request_id != self._query_request_id:
            return
        self._set_loading(False)
        self._set_results_mode(True)
        self.search_button.setEnabled(True)
        self._last_answer = answer
        self.search_input.setProperty("suggestionSelected", False)
        self._set_preview_state(False)
        self.search_input.blockSignals(True)
        self.search_input.setText(query)
        self.search_input.blockSignals(False)
        self.search_input.setProperty("empty", not bool(query))
        self._show_query_start()
        self.search_input.style().unpolish(self.search_input)
        self.search_input.style().polish(self.search_input)
        self.search_input.update()
        self._update_search_button()
        if answer.ui_mode == "candidates":
            eyebrow_text = "POSSIBLE MATCHES"
        elif answer.ui_mode == "memory":
            eyebrow_text = "MATCHED MEMORY"
        else:
            eyebrow_text = "LOCAL ANSWER" if not answer.time_scope_label else f"LOCAL ANSWER - {answer.time_scope_label.upper()}"
        self.answer_eyebrow.setText(eyebrow_text)
        self.answer_text.setText(answer.answer)
        self.answer_summary.setText(answer.summary)
        self.answer_summary.setVisible(bool(answer.summary))
        self._render_session_context(answer.session_context)
        self._render_related_queries(answer.related_queries)
        self.details_button.setVisible(bool(answer.evidence) and not answer.auto_expand_evidence)
        if answer.auto_expand_evidence and answer.evidence:
            self.details_button.setText("Hide matches")
        else:
            self.details_button.setText(answer.details_label or "Show top matches")
        self.evidence_scroll.setVisible(bool(answer.auto_expand_evidence))
        self.answer_card.show()
        self.results_separator.show()
        self._populate_evidence(answer)
        self.suggestion_dock.hide()
        self._sync_results_visibility_for_suggestions(False)
        self._set_search_attached(False)
        self._set_hero_shifted(False)
        if answer.ui_mode == "candidates":
            self.status_text.setText("Showing the closest local matches.")
        elif answer.evidence and all(getattr(span, "is_retained_memory", False) for span in answer.evidence):
            self.status_text.setText("Matched retained memories from local content on this device.")
        elif answer.result_count:
            self.status_text.setText(f"Matched {answer.result_count} local events and ranked the strongest evidence.")
        else:
            self.status_text.setText("Answer generated from local events on this device.")
        self._sync_back_button()
        QTimer.singleShot(0, self._refresh_answer_card_geometry)
        QTimer.singleShot(0, self._settle_layout)

    def _populate_evidence(self, answer: QueryAnswer) -> None:
        self._clear_evidence_cards()
        for span in answer.evidence:
            card = EvidenceCard(span)
            card.activated.connect(self._apply_suggestion)
            self.evidence_layout.addWidget(card)
        self.evidence_layout.addStretch(1)
        QTimer.singleShot(0, self._refresh_answer_card_geometry)

    def _clear_evidence_cards(self) -> None:
        while self.evidence_layout.count():
            item = self.evidence_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()

    def _fit_wrapped_label(self, label: QLabel) -> None:
        if not label.wordWrap():
            return
        if not label.isVisible() or not label.text():
            label.setMinimumHeight(0)
            return
        width = max(1, label.width())
        rect = label.fontMetrics().boundingRect(
            QRect(0, 0, width, 10000),
            int(Qt.TextFlag.TextWordWrap | Qt.TextFlag.TextExpandTabs),
            label.text(),
        )
        label.setMinimumHeight(rect.height() + 6)

    def _sync_evidence_height(self) -> None:
        if not self.evidence_scroll.isVisible():
            self.evidence_scroll.setMinimumHeight(0)
            self.evidence_scroll.setMaximumHeight(16777215)
            return
        self.evidence_content.adjustSize()
        content_height = self.evidence_content.sizeHint().height()
        frame_height = self.evidence_scroll.frameWidth() * 2
        max_height = 460 if self._last_answer and self._last_answer.auto_expand_evidence else 320
        target_height = max(0, min(content_height + frame_height + 6, max_height))
        self.evidence_scroll.setMinimumHeight(target_height)
        self.evidence_scroll.setMaximumHeight(target_height)

    def _refresh_answer_card_geometry(self) -> None:
        for label in (self.answer_text, self.answer_summary, self.session_summary):
            self._fit_wrapped_label(label)
        self._sync_evidence_height()
        self.answer_card.updateGeometry()

    def _render_session_context(self, session_context: dict | None) -> None:
        while self.session_action_row.count():
            item = self.session_action_row.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        session = session_context.get("session") if isinstance(session_context, dict) else None
        if not isinstance(session, dict):
            self.session_heading.hide()
            self.session_summary.hide()
            self.session_action_host.hide()
            self.session_summary.clear()
            return
        label = str(session.get("label") or "").strip() or "Local activity session"
        event_count = int(session_context.get("event_count") or session.get("event_count") or 0)
        upstream_count = len(session_context.get("upstream") or [])
        downstream_count = len(session_context.get("downstream") or [])
        foundational_count = len(session_context.get("foundational_events") or [])
        parts = [f"From session: {label}"]
        if event_count:
            parts.append(f"{event_count} events")
        if upstream_count:
            parts.append(f"{upstream_count} before")
        if downstream_count:
            parts.append(f"{downstream_count} after")
        if foundational_count:
            parts.append(f"{foundational_count} foundational")
        self.session_summary.setText("  ·  ".join(parts))
        anchor_label = label if len(label) <= 48 else f"{label[:47].rstrip(' -,:;')}…"
        prompts: list[str] = []
        if upstream_count:
            prompts.append(f"What led to {anchor_label}?")
        if downstream_count:
            prompts.append(f"What happened after {anchor_label}?")
        if not prompts:
            prompts.append(f"Show everything connected to {anchor_label}")
        for prompt in prompts[:2]:
            button = QPushButton(prompt)
            button.setObjectName("RefineButton")
            button.setCursor(Qt.CursorShape.PointingHandCursor)
            button.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
            button.setToolTip(prompt)
            button.clicked.connect(lambda _checked=False, value=prompt: self._apply_suggestion(value))
            self.session_action_row.addWidget(button)
        self.session_heading.hide()
        self.session_summary.show()
        self.session_action_host.setVisible(bool(prompts))

    def _render_related_queries(self, queries: list[str]) -> None:
        while self.refine_row.count():
            item = self.refine_row.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        blocked = {
            "what led me to this?",
            "what happened after this?",
            "show everything connected to this session",
            "what led me here?",
            "what happened after?",
            "show session chain",
        }
        cleaned: list[str] = []
        seen: set[str] = set()
        for query in queries:
            text = str(query).strip()
            key = text.casefold()
            if not text or key in seen or key in blocked:
                continue
            cleaned.append(text)
            seen.add(key)
            if len(cleaned) >= 3:
                break
        if not cleaned:
            self.refine_heading.hide()
            self.refine_host.hide()
            return
        for query in cleaned:
            button = QPushButton(query)
            button.setObjectName("RefineButton")
            button.setCursor(Qt.CursorShape.PointingHandCursor)
            button.setSizePolicy(QSizePolicy.Policy.Maximum, QSizePolicy.Policy.Fixed)
            button.setToolTip(query)
            button.clicked.connect(lambda _checked=False, value=query: self._apply_suggestion(value))
            self.refine_row.addWidget(button)
        self.refine_heading.show()
        self.refine_host.show()

    def _toggle_details(self) -> None:
        visible = not self.evidence_scroll.isVisible()
        self.evidence_scroll.setVisible(visible)
        self.details_button.setText("Hide top matches" if visible else (self._last_answer.details_label if self._last_answer else "Show top matches"))
        self._refresh_answer_card_geometry()

    def _handle_new_event(self) -> None:
        if not self._db_ready:
            return
        self._cached_empty_suggestions = None
        if self.search_input.hasFocus():
            self._refresh_suggestions_immediately()
        if self.isVisible() and not self.isMinimized():
            self.status_text.setText("Memory updated locally.")

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton:
            position = self.root.mapFromGlobal(self.mapToGlobal(event.position().toPoint()))
            in_search = self.search_shell.geometry().contains(position)
            in_dock = self.suggestion_dock.isVisible() and self.suggestion_dock.geometry().contains(position)
            if not in_search and not in_dock:
                self.suggestion_dock.hide()
                self._set_search_attached(False)
                if not self.search_input.text().strip():
                    self._set_search_active(False)
                    self._set_hero_shifted(False)
                self.search_input.clearFocus()
        super().mousePressEvent(event)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._apply_responsive_sizes()
        self._refresh_answer_card_geometry()
        self.root.layout().invalidate()
        self.root.layout().activate()
        QTimer.singleShot(0, self._position_suggestion_dock)
        self._position_results_shadow()
        self._position_loading_bar()

    def _show_menu(self) -> None:
        anchor = self.results_menu_button if self._results_mode else self.menu_button
        global_down = anchor.mapToGlobal(anchor.rect().bottomLeft())
        global_up = anchor.mapToGlobal(anchor.rect().topLeft())
        screen = QApplication.screenAt(global_down) or QApplication.primaryScreen()
        available = screen.availableGeometry() if screen is not None else self.geometry()

        self.overflow_menu.ensurePolished()
        self.overflow_menu.adjustSize()
        menu_size = self.overflow_menu.sizeHint()

        x = global_down.x()
        y = global_down.y()
        if y + menu_size.height() > available.bottom():
            y = global_up.y() - menu_size.height()

        x = max(available.left(), min(x, available.right() - menu_size.width()))
        y = max(available.top(), min(y, available.bottom() - menu_size.height()))
        self.overflow_menu.popup(QPoint(x, y))

    def _handle_tray_click(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self.show_window()
            return
        if reason != QSystemTrayIcon.ActivationReason.Context:
            return
        if not hasattr(self, "tray_menu"):
            return

        cursor_pos = QCursor.pos()
        screen = QApplication.screenAt(cursor_pos) or QApplication.primaryScreen()
        available = screen.availableGeometry() if screen is not None else self.geometry()

        self.tray_menu.ensurePolished()
        self.tray_menu.adjustSize()
        menu_size = self.tray_menu.sizeHint()

        x = cursor_pos.x()
        if cursor_pos.y() > available.center().y():
            y = cursor_pos.y() - menu_size.height()
        else:
            y = cursor_pos.y()

        x = max(available.left(), min(x, available.right() - menu_size.width()))
        y = max(available.top(), min(y, available.bottom() - menu_size.height()))
        self.tray_menu.popup(QPoint(x, y))
        self.tray_menu.raise_()
        if self._tray_hide_timer.isActive():
            self._tray_hide_timer.stop()

    def show_window(self) -> None:
        self.show()
        self.raise_()
        self.activateWindow()

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        if not self._native_theme_applied:
            apply_native_window_theme(self)
            self._native_theme_applied = True
        self._apply_responsive_sizes()
        self._refresh_answer_card_geometry()
        self._position_suggestion_dock()
        self._position_results_shadow()
        self._position_loading_bar()

    def changeEvent(self, event) -> None:  # noqa: N802
        if event.type() == QEvent.Type.WindowStateChange:
            self._apply_responsive_sizes()
            self._refresh_answer_card_geometry()
            self._position_suggestion_dock()
            self._position_results_shadow()
            self._position_loading_bar()
            self.root.layout().invalidate()
            self.root.layout().activate()
        super().changeEvent(event)

    def eventFilter(self, obj, event) -> bool:  # noqa: N802
        if isinstance(obj, QMenu):
            if event.type() in (QEvent.Type.HoverMove, QEvent.Type.MouseMove):
                action = obj.actionAt(event.pos())
                if action and not action.isSeparator():
                    obj.setCursor(Qt.CursorShape.PointingHandCursor)
                else:
                    obj.setCursor(Qt.CursorShape.ArrowCursor)
            elif event.type() == QEvent.Type.Leave:
                obj.setCursor(Qt.CursorShape.ArrowCursor)
                if getattr(self, "tray_menu", None) is obj:
                    self._tray_hide_timer.start()
            elif event.type() == QEvent.Type.Enter:
                if getattr(self, "tray_menu", None) is obj and self._tray_hide_timer.isActive():
                    self._tray_hide_timer.stop()
        return super().eventFilter(obj, event)

    def _hide_tray_menu_if_idle(self) -> None:
        if getattr(self, "tray_menu", None) is None:
            return
        if self.tray_menu.isVisible() and not self.tray_menu.underMouse():
            self.tray_menu.hide()

    def quit_app(self) -> None:
        self._quitting = True
        if self._services_started:
            self.monitor.stop()
            self.browser_bridge.stop()
            if self.monitor.is_alive():
                self.monitor.join(timeout=2)
            if self.browser_bridge.is_alive():
                self.browser_bridge.join(timeout=2)
        if getattr(self, "tray", None) is not None:
            self.tray.hide()
        self.close()
        QApplication.quit()

    def closeEvent(self, event) -> None:  # noqa: N802
        if self._quitting or getattr(self, "tray", None) is None:
            super().closeEvent(event)
            return
        event.ignore()
        self.hide()
        self.tray.showMessage(
            "Memact",
            "Memact is still running privately in the background.",
            QSystemTrayIcon.MessageIcon.Information,
            1800,
        )

    def _maybe_show_browser_setup(self) -> None:
        if self.settings.get("extension_prompt_shown"):
            return
        browsers = detect_browsers()
        self.settings["extension_prompt_shown"] = True
        save_settings(self.settings)
        if not browsers:
            return
        visible = [browser for browser in browsers if self._browser_extension_status(browser) != "ready"]
        if not visible:
            return
        dialog = BrowserSetupDialog(
            browsers=visible,
            on_setup=self._run_browser_setup,
            is_browser_ready=self._is_browser_extension_ready,
            browser_status=self._browser_extension_status,
            parent=self,
        )
        dialog.exec()

    def _open_browser_setup_from_menu(self) -> None:
        browsers = detect_browsers()
        if not browsers:
            self._show_info_dialog("Memact", "No supported browsers were detected on this PC.")
            return
        visible = [browser for browser in browsers if self._browser_extension_status(browser) != "ready"]
        if not visible:
            self._show_info_dialog("Memact", "All detected browsers are already connected to Memact.")
            return
        dialog = BrowserSetupDialog(
            browsers=visible,
            on_setup=self._run_browser_setup,
            is_browser_ready=self._is_browser_extension_ready,
            browser_status=self._browser_extension_status,
            parent=self,
        )
        dialog.exec()

    def _run_browser_setup(self, browser) -> None:
        launch_extension_setup(browser, EXTENSION_DIR)
        self.status_text.setText(
            f"Opened {browser.name}. If needed, use {extension_manual_url(browser)} in the address bar."
        )

    def _is_browser_extension_ready(self, browser) -> bool:
        return self._browser_extension_status(browser) == "ready"

    def _record_extension_version(self, browser_key: str, version: str) -> None:
        if not browser_key or not version:
            return
        if self._extension_versions.get(browser_key) == version:
            return
        self._extension_versions[browser_key] = version
        self.settings["extension_versions"] = dict(self._extension_versions)
        save_settings(self.settings)

    def _handle_browser_session(self, session) -> None:
        if not getattr(session, "extension_version", None):
            return
        QTimer.singleShot(0, lambda: self._record_extension_version(session.browser, session.extension_version))

    def _current_extension_version(self) -> str | None:
        cached = getattr(self, "_extension_version_cache", None)
        if cached is not None:
            return cached
        version = None
        try:
            manifest_path = EXTENSION_DIR / "manifest.json"
            if manifest_path.exists():
                payload = json.loads(manifest_path.read_text(encoding="utf-8"))
                version = str(payload.get("version", "")).strip() or None
        except Exception:
            version = None
        self._extension_version_cache = version
        return version

    def _version_tuple(self, value: str | None) -> tuple[int, ...]:
        if not value:
            return tuple()
        parts = []
        for chunk in str(value).split("."):
            digits = "".join(ch for ch in chunk if ch.isdigit())
            if digits:
                parts.append(int(digits))
        return tuple(parts)

    def _browser_extension_status(self, browser) -> str:
        session = self.browser_state_store.get(browser.key)
        current = self._current_extension_version()
        session_version = session.extension_version if session else None
        if session_version:
            self._record_extension_version(browser.key, session_version)
        stored_version = self._extension_versions.get(browser.key)
        effective_version = session_version or stored_version
        if not effective_version:
            return "setup"
        if current and self._version_tuple(current) == self._version_tuple(effective_version):
            return "ready"
        return "update"

    def _show_privacy_dialog(self) -> None:
        dialog = GlassInfoDialog(
            title="Privacy Notice",
            text="Memact stores events, embeddings, and answers locally on this device. It does not call cloud APIs or send your activity off-machine.",
            parent=self,
        )
        dialog.exec()

    def _show_search_history(self) -> None:
        history = load_history()
        dialog = SearchHistoryDialog(history, clear_history, self._apply_history_query, remove_history, parent=self)
        dialog.exec()

    def _apply_history_query(self, query: str) -> None:
        if not query:
            return
        self._apply_suggestion(query)

    def _style_dialog(self, dialog: QMessageBox) -> None:
        dialog.setFont(body_font(12))
        dialog.setStyleSheet(
            """
            QMessageBox {
                background: #00011B;
                color: #ffffff;
            }
            QMessageBox QLabel {
                color: #ffffff;
                font-size: 16px;
                min-width: 340px;
            }
            QMessageBox QPushButton {
                background: rgba(40, 74, 128, 0.08);
                color: #ffffff;
                border: 1px solid rgba(40, 74, 128, 0.16);
                border-radius: 12px;
                padding: 9px 16px;
                min-width: 96px;
                font-size: 14px;
            }
            QMessageBox QPushButton:hover {
                background: rgba(40, 74, 128, 0.16);
            }
            """
        )

    def _show_info_dialog(self, title: str, text: str) -> None:
        dialog = QMessageBox(self)
        dialog.setWindowTitle(title)
        dialog.setText(text)
        dialog.setIcon(QMessageBox.Icon.Information)
        dialog.setStandardButtons(QMessageBox.StandardButton.Ok)
        dialog.setWindowIcon(app_icon())
        self._style_dialog(dialog)
        for button in dialog.findChildren(QPushButton):
            button.setCursor(Qt.CursorShape.PointingHandCursor)
        apply_native_window_theme(dialog)
        dialog.exec()

    def _show_confirmation_dialog(self, title: str, text: str) -> bool:
        dialog = QMessageBox(self)
        dialog.setWindowTitle(title)
        dialog.setText(text)
        dialog.setIcon(QMessageBox.Icon.Information)
        dialog.setStandardButtons(QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel)
        dialog.setDefaultButton(QMessageBox.StandardButton.Ok)
        dialog.setWindowIcon(app_icon())
        self._style_dialog(dialog)
        for button in dialog.findChildren(QPushButton):
            button.setCursor(Qt.CursorShape.PointingHandCursor)
        apply_native_window_theme(dialog)
        return dialog.exec() == QMessageBox.StandardButton.Ok
