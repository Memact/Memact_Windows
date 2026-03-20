from __future__ import annotations

import json
import logging
import threading
from pathlib import Path
from urllib.parse import urlparse

from PyQt6.QtCore import QObject, QPoint, QRectF, QEvent, Qt, QTimer, pyqtSignal
from PyQt6.QtGui import QAction, QColor, QCursor, QDesktopServices, QIcon, QPainter, QPainterPath, QRegion
from PyQt6.QtWidgets import (
    QApplication,
    QDialog,
    QFrame,
    QGraphicsDropShadowEffect,
    QHBoxLayout,
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
)
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


def _duration_chip(seconds: int) -> str:
    minutes = max(int(round(seconds / 60)), 1)
    if minutes >= 60:
        hours, minutes = divmod(minutes, 60)
        if minutes:
            return f"{hours}h {minutes}m"
        return f"{hours}h"
    return f"{minutes}m"


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


class EvidenceCard(QFrame):
    def __init__(self, span: ActivitySpan, parent=None) -> None:
        super().__init__(parent)
        self.setObjectName("EvidenceCard")
        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 16, 18, 16)
        layout.setSpacing(6)

        title = QLabel(span.session_title)
        title.setObjectName("EvidenceTitle")
        title.setWordWrap(True)

        app_label = span.application.removesuffix(".exe").replace("_", " ").title()
        chip_row = QHBoxLayout()
        chip_row.setContentsMargins(0, 0, 0, 0)
        chip_row.setSpacing(8)
        activity_chips: list[str] = []
        if getattr(span, "activity_mode", None):
            activity_chips.append(str(span.activity_mode).replace("_", " ").title())
        category = getattr(span, "activity_category", None)
        category_conf = float(getattr(span, "activity_confidence", 0.0) or 0.0)
        if category and category not in {"typing", "scrolling"} and category_conf >= 0.44:
            activity_chips.append(str(category).replace("_", " ").title())
        if not activity_chips:
            activity_chips.append("Web Activity" if span.url else "App Activity")
        for chip_text in (
            app_label,
            _domain_chip(span.url),
            *activity_chips,
            _duration_chip(span.duration_seconds),
        ):
            if not chip_text:
                continue
            chip = QLabel(chip_text)
            chip.setObjectName("EvidenceChip")
            chip_row.addWidget(chip)
        chip_row.addStretch(1)

        meta = QLabel(
            f"{span.start_at.strftime('%b %d')}  |  {span.start_at.strftime('%I:%M %p').lstrip('0')} to {span.end_at.strftime('%I:%M %p').lstrip('0')}  |  {app_label}"
        )
        meta.setObjectName("EvidenceMeta")
        meta.setWordWrap(True)

        link_button = None
        best_url = _best_url_for_span(span)
        domain = _domain_chip(best_url)
        if best_url and domain:
            link_button = QPushButton(_link_label(best_url))
            link_button.setObjectName("EvidenceLinkButton")
            link_button.setCursor(Qt.CursorShape.PointingHandCursor)
            link_button.clicked.connect(lambda _checked=False, value=best_url: QDesktopServices.openUrl(QUrl(value)))

        if span.attention_cue:
            attention = QLabel(span.attention_cue)
            attention.setObjectName("EvidenceAttention")
            attention.setWordWrap(True)
        else:
            attention = None

        action_map = {
            "app_switch": "app switch",
            "tab_switch": "tab switch",
            "navigate": "navigate",
            "context_change": "context change",
            "focus": "focus",
            "typing": "typing",
            "scrolling": "scrolling",
        }
        actions: list[str] = []
        seen_actions: set[str] = set()
        for event in span.events:
            kind = (event.interaction_type or "").strip().lower()
            if not kind or kind in {"heartbeat", "legacy_import", "legacy_focus", "legacy_heartbeat"}:
                continue
            label = action_map.get(kind, kind.replace("_", " "))
            if label in seen_actions:
                continue
            seen_actions.add(label)
            actions.append(label)
            if len(actions) >= 5:
                break
        activity_line = None
        if actions:
            activity_line = QLabel("Actions: " + " | ".join(actions))
            activity_line.setObjectName("EvidenceActivity")
            activity_line.setWordWrap(True)

        snippet = QLabel(span.snippet)
        snippet.setObjectName("EvidenceSnippet")
        snippet.setWordWrap(True)

        reason = QLabel(span.match_reason)
        reason.setObjectName("EvidenceReason")
        reason.setWordWrap(True)

        moment_text = span.session_flow if span.session_flow.casefold() != span.session_title.casefold() else span.moment_summary
        moment = QLabel(moment_text)
        moment.setObjectName("EvidenceMoment")
        moment.setWordWrap(True)

        layout.addWidget(title)
        layout.addLayout(chip_row)
        layout.addWidget(meta)
        if link_button is not None:
            layout.addWidget(link_button, 0, Qt.AlignmentFlag.AlignLeft)
        if attention is not None:
            layout.addWidget(attention)
        if activity_line is not None:
            layout.addWidget(activity_line)
        layout.addWidget(snippet)
        layout.addWidget(moment)
        if span.tab_preview:
            tabs = QLabel("Nearby tabs: " + "  |  ".join(span.tab_preview))
            tabs.setObjectName("EvidenceTabs")
            tabs.setWordWrap(True)
            layout.addWidget(tabs)
        if span.before_context:
            before = QLabel(f"Before: {span.before_context}")
            before.setObjectName("EvidenceContext")
            before.setWordWrap(True)
            layout.addWidget(before)
        if span.after_context:
            after = QLabel(f"After: {span.after_context}")
            after.setObjectName("EvidenceContext")
            after.setWordWrap(True)
            layout.addWidget(after)
        layout.addWidget(reason)


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
                border: 1px solid rgba(255, 255, 255, 0.18);
                border-radius: 24px;
            }
            QLabel#DialogTitle {
                color: #ffffff;
                font-size: 24px;
            }
            QLabel#DialogBody {
                color: #ffffff;
                font-size: 17px;
            }
            QFrame#InfoOrb {
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.18);
                border-radius: 28px;
            }
            QLabel#InfoGlyph {
                color: #ffffff;
                font-size: 28px;
                font-weight: 600;
            }
            QPushButton {
                background: rgba(40, 74, 128, 0.22);
                color: #ffffff;
                border: 1px solid rgba(40, 74, 128, 0.35);
                border-radius: 14px;
                padding: 10px 18px;
                min-width: 110px;
                font-size: 15px;
            }
            QPushButton:hover {
                background: rgba(40, 74, 128, 0.3);
            }
            """
        )

        shell = QVBoxLayout(self)
        shell.setContentsMargins(20, 20, 20, 20)

        panel = QFrame()
        panel.setObjectName("DialogPanel")
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(22, 22, 22, 22)
        panel_layout.setSpacing(18)

        top = QHBoxLayout()
        top.setSpacing(16)

        orb = QFrame()
        orb.setObjectName("InfoOrb")
        orb.setFixedSize(56, 56)
        orb_layout = QVBoxLayout(orb)
        orb_layout.setContentsMargins(0, 0, 0, 0)
        glyph = QLabel("i")
        glyph.setObjectName("InfoGlyph")
        glyph.setAlignment(Qt.AlignmentFlag.AlignCenter)
        orb_layout.addWidget(glyph)

        text_col = QVBoxLayout()
        text_col.setSpacing(10)
        title_label = QLabel(title)
        title_label.setObjectName("DialogTitle")
        body_label = QLabel(text)
        body_label.setObjectName("DialogBody")
        body_label.setWordWrap(True)
        text_col.addWidget(title_label)
        text_col.addWidget(body_label)

        top.addWidget(orb, 0, Qt.AlignmentFlag.AlignTop)
        top.addLayout(text_col, 1)
        panel_layout.addLayout(top)

        actions = QHBoxLayout()
        actions.addStretch(1)
        ok_button = QPushButton("OK")
        ok_button.clicked.connect(self.accept)
        actions.addWidget(ok_button)
        panel_layout.addLayout(actions)

        shell.addWidget(panel)

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
        self.browser_state_store = BrowserStateStore()
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
                border: 1px solid rgba(255, 255, 255, 0.14);
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
                background: rgba(255, 255, 255, 0.08);
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
                background: rgba(255, 255, 255, 0.08);
                border-radius: 12px;
            }
            QFrame#SuggestionDock {
                background: rgba(0, 1, 27, 0.975);
                border: 1px solid rgba(255, 255, 255, 0.14);
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
            QFrame#SuggestionCard {
                background: rgba(255, 255, 255, 0.035);
                border: none;
                border-radius: 14px;
            }
            QFrame#SuggestionCard[hovered="true"], QFrame#SuggestionCard[active="true"] {
                background: rgba(255, 255, 255, 0.11);
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
                background: rgba(255, 255, 255, 0.11);
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 26px;
            }
            QFrame#SearchShell[active="true"] {
                background: rgba(255, 255, 255, 0.14);
                border: 1px solid rgba(40, 74, 128, 0.45);
            }
            QFrame#SearchShell[attached="true"] {
                border-bottom: none;
                border-bottom-color: transparent;
                border-bottom-left-radius: 0px;
                border-bottom-right-radius: 0px;
            }
            QFrame#AnswerCard {
                background: rgba(255, 255, 255, 0.11);
                border: 1px solid rgba(255, 255, 255, 0.14);
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
                background: rgba(255, 255, 255, 0.085);
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
            QLabel#EvidenceMeta {
                color: rgba(170, 194, 230, 0.92);
                font-size: 12px;
                font-weight: 600;
            }
            QPushButton#EvidenceLinkButton {
                background: rgba(40, 74, 128, 0.12);
                color: #ffffff;
                border: 1px solid rgba(40, 74, 128, 0.24);
                border-radius: 12px;
                padding: 6px 12px;
                font-size: 12px;
                font-weight: 600;
            }
            QPushButton#EvidenceLinkButton:hover {
                background: rgba(40, 74, 128, 0.2);
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
                background: rgba(255, 255, 255, 0.045);
                color: #ffffff;
                border: 1px solid rgba(255, 255, 255, 0.12);
                border-radius: 14px;
                padding: 10px 14px;
                font-size: 13px;
                text-align: left;
            }
            QPushButton#RefineButton:hover {
                background: rgba(255, 255, 255, 0.1);
                border: 1px solid rgba(255, 255, 255, 0.22);
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
        results_header_layout.setHorizontalSpacing(14)
        results_header_layout.setVerticalSpacing(0)
        self.results_left_controls = QWidget()
        results_left_layout = QHBoxLayout(self.results_left_controls)
        results_left_layout.setContentsMargins(0, 0, 0, 0)
        results_left_layout.setSpacing(14)
        self.results_divider = QFrame()
        self.results_divider.setObjectName("ResultsDivider")
        self.results_divider.setFixedSize(1, 32)
        results_left_layout.addWidget(self.compact_brand_host, 0, Qt.AlignmentFlag.AlignVCenter)
        results_left_layout.addWidget(self.back_orb, 0, Qt.AlignmentFlag.AlignVCenter)
        results_left_layout.addWidget(self.reload_orb, 0, Qt.AlignmentFlag.AlignVCenter)
        results_left_layout.addWidget(self.results_divider, 0, Qt.AlignmentFlag.AlignVCenter)
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
        self.results_menu_divider = QFrame()
        self.results_menu_divider.setObjectName("ResultsDivider")
        self.results_menu_divider.setFixedSize(1, 32)
        right_controls_layout.addWidget(self.results_menu_divider, 0, Qt.AlignmentFlag.AlignVCenter)
        right_controls_layout.addWidget(self.results_menu_orb, 0, Qt.AlignmentFlag.AlignVCenter)

        results_header_layout.addWidget(
            self.results_left_controls,
            0,
            0,
            Qt.AlignmentFlag.AlignLeft | Qt.AlignmentFlag.AlignVCenter,
        )
        results_header_layout.addWidget(
            self.results_right_controls,
            0,
            2,
            Qt.AlignmentFlag.AlignRight | Qt.AlignmentFlag.AlignVCenter,
        )
        results_header_layout.setColumnStretch(0, 0)
        results_header_layout.setColumnStretch(1, 1)
        results_header_layout.setColumnStretch(2, 0)
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
        self.answer_summary = QLabel("")
        self.answer_summary.setObjectName("AnswerSummary")
        self.answer_summary.setWordWrap(True)
        self.details_button = QPushButton("View details")
        self.details_button.setObjectName("DetailsButton")
        self.details_button.setCursor(Qt.CursorShape.PointingHandCursor)
        self.details_button.clicked.connect(self._toggle_details)

        self.refine_heading = QLabel("REFINE SEARCH")
        self.refine_heading.setObjectName("RefineHeading")
        self.refine_heading.setVisible(False)
        self.refine_row = QHBoxLayout()
        self.refine_row.setSpacing(8)
        self.refine_row.setContentsMargins(0, 0, 0, 0)
        self.refine_host = QWidget()
        self.refine_host.setLayout(self.refine_row)
        self.refine_host.setVisible(False)

        self.evidence_scroll = QScrollArea()
        self.evidence_scroll.setObjectName("EvidenceScroll")
        self.evidence_scroll.setWidgetResizable(True)
        self.evidence_scroll.setVisible(False)
        self.evidence_content = QWidget()
        self.evidence_layout = QVBoxLayout(self.evidence_content)
        self.evidence_layout.setContentsMargins(0, 0, 0, 0)
        self.evidence_layout.setSpacing(10)
        self.evidence_scroll.setWidget(self.evidence_content)

        answer_layout.addWidget(self.answer_eyebrow)
        answer_layout.addWidget(self.answer_text)
        answer_layout.addWidget(self.answer_summary)
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
        self.tray.setToolTip("Memact is privately recording local actions")
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
        self.status_text.setText("Ready. Ask anything about your past actions.")
        QTimer.singleShot(150, self._start_background_services)
        QTimer.singleShot(900, self._maybe_show_browser_setup)

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
        self._refresh_suggestions_immediately()
        self._update_search_button()

    def _kickoff_suggestion_refresh(self) -> None:
        if not self._db_ready or not self.search_input.hasFocus():
            return
        text = self.search_input.text().strip()
        heading = "AUTOCOMPLETE" if text else "RECENT PROMPTS"
        if not text and self._cached_empty_suggestions is not None:
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
            suggestions = autocomplete_suggestions(text, limit=5) if text else dynamic_suggestions(limit=4)
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
        if not text:
            self._cached_empty_suggestions = suggestions
        self._render_suggestions(suggestions, heading=heading)

    def _sync_back_button(self) -> None:
        show_back = bool(self.search_input.text().strip()) or self.answer_card.isVisible()
        self.back_orb.setVisible(show_back)
        self.reload_orb.setVisible(show_back)
        if hasattr(self, "results_divider"):
            self.results_divider.setVisible(show_back)

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
                background: rgba(255, 86, 86, 0.26);
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
        self.suggestion_heading.setText(heading)
        self.suggestion_heading.setVisible(bool(heading))
        for suggestion in suggestions:
            card = SuggestionCard(suggestion)
            card.setMinimumHeight(self._suggestion_row_height)
            card.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)
            card.clicked.connect(self._apply_suggestion)
            card.hovered.connect(self._select_suggestion_by_completion)
            card.unhovered.connect(self._schedule_hover_preview_reset)
            card.setMinimumWidth(520)
            self.suggestions_layout.addWidget(card)
            self._visible_suggestion_cards.append(card)
        visible_rows = min(len(suggestions), self._suggestion_visible_limit)
        scroll_height = 0
        if visible_rows:
            scroll_height = (
                visible_rows * self._suggestion_row_height
                + max(visible_rows - 1, 0) * self.suggestions_layout.spacing()
            )
        self.suggestion_scroll.setFixedHeight(scroll_height)
        heading_height = self.suggestion_heading.sizeHint().height() if self.suggestion_heading.isVisible() else 0
        _, top_margin, _, bottom_margin = self.suggestion_dock.layout().getContentsMargins()
        dock_height = top_margin + bottom_margin + scroll_height
        if heading_height:
            dock_height += heading_height + self.suggestion_dock.layout().spacing()
        self.suggestion_dock.setFixedHeight(max(dock_height, 0))
        dock_width = self.search_shell.width()
        if dock_width:
            self.suggestion_dock.setMinimumWidth(dock_width)
            self.suggestion_dock.setMaximumWidth(dock_width)
            self.suggestion_dock.setFixedWidth(dock_width)
        self._set_hero_shifted(bool(suggestions))
        self.suggestion_dock.setVisible(bool(suggestions))
        self._set_search_attached(bool(suggestions))
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
        center_available = max(1, available - left_width - right_width - (spacing * 2))
        min_width = min(self._min_content_width, center_available)
        if self._results_mode:
            home_width = clamp(int(available * 0.82), min_width, center_available)
        else:
            home_ratio = 0.68 if self.isMaximized() else 0.72
            home_width = clamp(int(available * home_ratio), min_width, center_available)

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
        self.results_header_layout.setColumnMinimumWidth(2, right_width)

        self.home_menu_slot.setFixedHeight(self._results_header_height)
        self.search_shell.updateGeometry()
        self.header_container.updateGeometry()
        self.answer_card.updateGeometry()
        self.results_header.updateGeometry()
        self._position_results_shadow()
        self._position_loading_bar()
        if self.suggestion_dock.isVisible():
            QTimer.singleShot(0, self._position_suggestion_dock)

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
                    1,
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
        self.search_input.setProperty("empty", not bool(text))
        self.search_input.style().unpolish(self.search_input)
        self.search_input.style().polish(self.search_input)
        self.search_input.update()
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
                self._refresh_suggestions_immediately()
            else:
                self.suggestion_dock.hide()
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
        self._render_related_queries([])
        self._last_answer = None
        self.search_button.setEnabled(True)
        if clear_query:
            self._typed_query_before_selection = ""
            self.search_input.clear()
            self.search_input.clearFocus()
            self._update_search_button()
        else:
            if self.search_input.text():
                self._show_query_start()
        self._set_search_active(False)
        self._set_hero_shifted(False)
        if self._db_ready:
            self.status_text.setText("Ready. Ask anything about your past actions.")
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
        self.search_input.setProperty("suggestionSelected", False)
        self._set_preview_state(False)
        self.status_text.setText("Searching locally...")
        self.search_button.setEnabled(False)
        self._set_loading(True)
        self.search_input.clearFocus()
        self._suggestion_timer.stop()
        self.suggestion_dock.hide()
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
        self.answer_eyebrow.setText("LOCAL ANSWER" if not answer.time_scope_label else f"LOCAL ANSWER - {answer.time_scope_label.upper()}")
        self.answer_text.setText(answer.answer)
        self.answer_summary.setText(answer.summary)
        self._render_related_queries(answer.related_queries)
        self.details_button.setVisible(bool(answer.evidence))
        self.details_button.setText(answer.details_label or "Show top matches")
        self.evidence_scroll.setVisible(False)
        self.answer_card.show()
        self.results_separator.show()
        self._populate_evidence(answer)
        self.suggestion_dock.hide()
        self._set_search_attached(False)
        self._set_hero_shifted(False)
        if answer.result_count:
            self.status_text.setText(f"Matched {answer.result_count} local events and ranked the strongest evidence.")
        else:
            self.status_text.setText("Answer generated from local events on this device.")
        self._sync_back_button()

    def _populate_evidence(self, answer: QueryAnswer) -> None:
        self._clear_evidence_cards()
        for span in answer.evidence:
            card = EvidenceCard(span)
            self.evidence_layout.addWidget(card)
        self.evidence_layout.addStretch(1)

    def _clear_evidence_cards(self) -> None:
        while self.evidence_layout.count():
            item = self.evidence_layout.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()

    def _render_related_queries(self, queries: list[str]) -> None:
        while self.refine_row.count():
            item = self.refine_row.takeAt(0)
            widget = item.widget()
            if widget is not None:
                widget.deleteLater()
        if not queries:
            self.refine_heading.hide()
            self.refine_host.hide()
            return
        for query in queries:
            button = QPushButton(query)
            button.setObjectName("RefineButton")
            button.setCursor(Qt.CursorShape.PointingHandCursor)
            button.clicked.connect(lambda _checked=False, value=query: self._apply_suggestion(value))
            self.refine_row.addWidget(button)
        self.refine_row.addStretch(1)
        self.refine_heading.show()
        self.refine_host.show()

    def _toggle_details(self) -> None:
        visible = not self.evidence_scroll.isVisible()
        self.evidence_scroll.setVisible(visible)
        self.details_button.setText("Hide top matches" if visible else (self._last_answer.details_label if self._last_answer else "Show top matches"))

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
        self._position_suggestion_dock()
        self._position_results_shadow()
        self._position_loading_bar()

    def changeEvent(self, event) -> None:  # noqa: N802
        if event.type() == QEvent.Type.WindowStateChange:
            self._apply_responsive_sizes()
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
        return self.browser_state_store.has_session(browser.key)

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
        if session is None:
            return "setup"
        current = self._current_extension_version()
        session_version = session.extension_version
        if current and session_version:
            if self._version_tuple(current) == self._version_tuple(session_version):
                return "ready"
            return "update"
        if session_version:
            return "update"
        return "update"

    def _show_privacy_dialog(self) -> None:
        dialog = GlassInfoDialog(
            title="Privacy Notice",
            text="Memact stores events, embeddings, and answers locally on this device. It does not call cloud APIs or send your activity off-machine.",
            parent=self,
        )
        dialog.exec()

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
                background: rgba(40, 74, 128, 0.22);
                color: #ffffff;
                border: 1px solid rgba(40, 74, 128, 0.35);
                border-radius: 12px;
                padding: 9px 16px;
                min-width: 96px;
                font-size: 14px;
            }
            QMessageBox QPushButton:hover {
                background: rgba(40, 74, 128, 0.3);
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
        apply_native_window_theme(dialog)
        return dialog.exec() == QMessageBox.StandardButton.Ok
