from __future__ import annotations

import html
import re
import sys
import threading
from collections import Counter
from datetime import date, datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse

from PyQt6.QtCore import QEvent, QObject, Qt, QTimer, pyqtSignal
from PyQt6.QtCore import QSize
from PyQt6.QtGui import QAction, QFont, QFontDatabase, QIcon
from PyQt6.QtWidgets import (
    QAbstractItemView,
    QApplication,
    QCheckBox,
    QDialog,
    QDialogButtonBox,
    QFrame,
    QHBoxLayout,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPushButton,
    QSizePolicy,
    QStatusBar,
    QStackedWidget,
    QSystemTrayIcon,
    QVBoxLayout,
    QWidget,
)

from core.database import (
    Anchor,
    clear_anchors,
    delete_anchor,
    delete_group,
    init_db,
    list_anchors,
    list_groups,
    merge_groups,
    move_session_to_group,
    rename_group,
    search_anchors,
)
from core.browser_bridge import BrowserBridgeServer, BrowserStateStore
from core.browser_setup import detect_browsers, extension_manual_url, launch_extension_setup
from core.monitor import WindowMonitor
from core.restorer import restore_anchor, restore_browser_urls
from core.settings import load_settings, save_settings
from ui.setup_dialog import BrowserSetupDialog
from ui.window_effects import apply_native_window_theme

ICON_PATH = Path(__file__).resolve().parent.parent / "assets" / "memact_icon.svg"
CHECK_ICON_PATH = Path(__file__).resolve().parent.parent / "assets" / "check_mark.svg"
TIMELINE_ICON_PATH = Path(__file__).resolve().parent.parent / "assets" / "timeline_icon.svg"
SEARCH_ICON_PATH = Path(__file__).resolve().parent.parent / "assets" / "search_icon.svg"
GROUPS_ICON_PATH = Path(__file__).resolve().parent.parent / "assets" / "groups_icon.svg"
FONT_DIR = Path(__file__).resolve().parent.parent / "assets" / "fonts"
EXTENSION_DIR = Path(__file__).resolve().parent.parent / "extension" / "memact"
ORBITRON_FONT_PATH = FONT_DIR / "Orbitron-Bold.ttf"
TAB_SELECTION_STYLESHEET = """
QDialog {
    background: #000543;
    color: #ffffff;
    font-family: "Segoe UI";
}
QLabel#DialogTitle {
    font-size: 18px;
    font-weight: 700;
    color: #ffffff;
}
QLabel#DialogSubtitle {
    font-size: 13px;
    color: rgba(255, 255, 255, 0.78);
}
QListWidget {
    border: 1px solid rgba(0, 56, 255, 0.24);
    background: rgba(255, 255, 255, 0.03);
    border-radius: 18px;
    padding: 10px;
}
QCheckBox {
    color: #ffffff;
    font-size: 13px;
    font-family: "Segoe UI";
    font-weight: 500;
    spacing: 10px;
    padding: 8px 4px;
}
QCheckBox::indicator {
    width: 16px;
    height: 16px;
}
QCheckBox::indicator:unchecked {
    border: 1px solid rgba(255, 255, 255, 0.45);
    background: transparent;
    border-radius: 4px;
}
QCheckBox::indicator:checked {
    border: 1px solid #0038ff;
    background: #0038ff;
    border-radius: 4px;
    image: url("__CHECK_ICON__");
}
QPushButton {
    background: #0038ff;
    color: #ffffff;
    border: 1px solid rgba(0, 56, 255, 0.26);
    border-radius: 14px;
    padding: 10px 18px;
    font-size: 13px;
    font-family: "Segoe UI";
    font-weight: 600;
}
QPushButton:hover {
    background: #1a4fff;
}
"""


class SignalBridge(QObject):
    anchor_saved = pyqtSignal()
    runtime_ready = pyqtSignal()


def app_display_name(anchor: Anchor) -> str:
    app_name = anchor.app_name.removesuffix(".exe")
    friendly_names = {
        "msedge": "Microsoft Edge",
        "chrome": "Google Chrome",
        "brave": "Brave",
        "opera": "Opera",
        "launcher": "Opera GX",
        "vivaldi": "Vivaldi",
        "discord": "Discord",
        "windowsterminal": "Windows Terminal",
        "code": "Visual Studio Code",
        "python": "Python",
        "pythonw": "Python",
    }
    return friendly_names.get(app_name.lower(), app_name.replace("_", " ").title())


def format_group_timestamp(value: str) -> str:
    try:
        timestamp = datetime.fromisoformat(value)
        return timestamp.strftime("%#I:%M %p" if sys.platform == "win32" else "%-I:%M %p")
    except ValueError:
        return value


def highlight_text(text: str, query: str) -> str:
    value = text or ""
    escaped = html.escape(value)
    tokens = [token for token in re.split(r"\s+", query.strip()) if token]
    if not tokens:
        return escaped
    pattern = re.compile(
        "(" + "|".join(re.escape(token) for token in tokens) + ")",
        re.IGNORECASE,
    )
    return pattern.sub(
        r'<span style="background-color: rgba(255,255,255,0.22); border-radius: 3px;">\1</span>',
        escaped,
    )


class GroupHeaderRow(QWidget):
    def __init__(self, group_name: str, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(4, 6, 4, 2)
        label = QLabel(group_name or "Work Session")
        label.setObjectName("GroupHeader")
        layout.addWidget(label)


class JumpOverlay(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setObjectName("JumpOverlay")
        self.setAttribute(Qt.WidgetAttribute.WA_TransparentForMouseEvents, True)
        layout = QVBoxLayout(self)
        layout.setContentsMargins(18, 16, 18, 16)
        layout.setSpacing(2)

        self.title_label = QLabel("Jumped Back")
        self.title_label.setObjectName("JumpOverlayTitle")
        layout.addWidget(self.title_label)

        self.session_label = QLabel("")
        self.session_label.setObjectName("JumpOverlaySession")
        self.session_label.setWordWrap(True)
        layout.addWidget(self.session_label)

        self.time_label = QLabel("")
        self.time_label.setObjectName("JumpOverlayTime")
        layout.addWidget(self.time_label)

        self.hide()


class SearchHintRow(QWidget):
    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        layout = QHBoxLayout(self)
        layout.setContentsMargins(6, 0, 6, 0)
        layout.setSpacing(8)

        label = QLabel("Example:")
        label.setObjectName("SearchHintLabel")
        layout.addWidget(label)

        examples = QLabel("youtube, terminal, github")
        examples.setObjectName("SearchHintText")
        layout.addWidget(examples)
        layout.addStretch(1)


class GroupRow(QWidget):
    def __init__(
        self,
        label: str,
        *,
        session_count: int | None = None,
        on_open=None,
        on_menu=None,
        show_menu: bool = True,
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._on_open = on_open
        self._label = label
        layout = QHBoxLayout(self)
        layout.setContentsMargins(12, 10, 10, 10)
        layout.setSpacing(10)

        text = QLabel(label)
        text.setObjectName("GroupRowTitle")
        layout.addWidget(text, 1)

        if session_count is not None:
            count = QLabel(str(session_count))
            count.setObjectName("GroupRowCount")
            count.setAlignment(Qt.AlignmentFlag.AlignCenter)
            layout.addWidget(count)

        self.menu_button = QPushButton("...")
        self.menu_button.setObjectName("GroupRowMenu")
        self.menu_button.setFixedSize(32, 32)
        self.menu_button.setVisible(show_menu)
        if on_menu is not None:
            self.menu_button.clicked.connect(lambda: on_menu(self))
        layout.addWidget(self.menu_button)

    def mousePressEvent(self, event) -> None:  # noqa: N802
        if event.button() == Qt.MouseButton.LeftButton and self._on_open is not None:
            self._on_open()
        super().mousePressEvent(event)


class AnchorRow(QWidget):
    def __init__(
        self,
        anchor: Anchor,
        on_jump_back=None,
        on_delete=None,
        on_choose_tabs=None,
        search_text: str = "",
        parent: QWidget | None = None,
    ) -> None:
        super().__init__(parent)
        self._anchor = anchor
        self._on_jump_back = on_jump_back
        self._on_delete = on_delete
        self._on_choose_tabs = on_choose_tabs
        self._search_text = search_text
        self._shell = QWidget(self)
        self._shell.setObjectName("AnchorRow")
        self._shell.setProperty("selected", False)

        outer = QVBoxLayout(self)
        outer.setContentsMargins(0, 0, 0, 0)
        outer.addWidget(self._shell)

        layout = QVBoxLayout(self._shell)
        layout.setContentsMargins(16, 14, 16, 14)
        layout.setSpacing(8)

        title = QLabel()
        title.setObjectName("AnchorTitle")
        title.setFont(QFont("Segoe UI", 15, QFont.Weight.Bold))
        title.setWordWrap(True)
        self._set_highlightable_text(title, self._display_title(anchor))
        layout.addWidget(title)

        metadata = QLabel(self._metadata_text(anchor))
        metadata.setObjectName("AnchorMeta")
        metadata.setFont(QFont("Segoe UI", 10))
        metadata.setWordWrap(False)
        layout.addWidget(metadata)

        self._actions_row = QHBoxLayout()
        self._actions_row.setSpacing(10)
        self._actions_row.setContentsMargins(0, 4, 0, 0)
        self._jump_button = QPushButton("Jump Back")
        self._jump_button.setObjectName("CardAction")
        self._jump_button.clicked.connect(lambda: self._on_jump_back(self._anchor))
        self._delete_button = QPushButton("Delete")
        self._delete_button.setObjectName("CardAction")
        self._delete_button.clicked.connect(lambda: self._on_delete(self._anchor))
        self._actions_row.addWidget(self._jump_button)
        self._actions_row.addWidget(self._delete_button)
        self._actions_row.addStretch(1)
        layout.addLayout(self._actions_row)
        self._set_actions_visible(False)
        duration_text = self._duration_text(anchor)
        self._shell.setToolTip(duration_text)
        title.setToolTip(duration_text)
        metadata.setToolTip(duration_text)

        self.setSizePolicy(QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Fixed)

    def size_hint_for_width(self, width: int) -> QSize:
        self.setFixedWidth(width)
        self.layout().activate()
        hint = self.sizeHint()
        self.setMinimumWidth(0)
        self.setMaximumWidth(16777215)
        return QSize(width, hint.height() + 6)

    def set_selected(self, selected: bool) -> None:
        self._shell.setProperty("selected", selected)
        self._shell.style().unpolish(self._shell)
        self._shell.style().polish(self._shell)
        self._shell.update()
        self._set_actions_visible(selected)

    def _set_actions_visible(self, visible: bool) -> None:
        has_actions = self._on_jump_back is not None and self._on_delete is not None
        self._jump_button.setVisible(visible and has_actions)
        self._delete_button.setVisible(visible and has_actions)

    def _set_highlightable_text(self, label: QLabel, value: str) -> None:
        if self._search_text.strip():
            label.setTextFormat(Qt.TextFormat.RichText)
            label.setText(highlight_text(value, self._search_text))
        else:
            label.setTextFormat(Qt.TextFormat.PlainText)
            label.setText(value)

    def _format_clock(self, value: str) -> str:
        try:
            timestamp = datetime.fromisoformat(value)
            return timestamp.strftime("%#I:%M %p" if sys.platform == "win32" else "%-I:%M %p")
        except ValueError:
            return value

    def _time_range_text(self, anchor: Anchor) -> str:
        start = self._format_clock(anchor.session_start)
        end = self._format_clock(anchor.session_end)
        if start == end:
            return start
        return f"{start} - {end}"

    def _time_duration_text(self, anchor: Anchor) -> str:
        return self._format_clock(anchor.timestamp_start)

    def _metadata_text(self, anchor: Anchor) -> str:
        return f"{app_display_name(anchor)} \N{BULLET} {self._time_duration_text(anchor)}"

    def _duration_text(self, anchor: Anchor) -> str:
        seconds = max(int(anchor.duration_seconds or 0), 0)
        if seconds < 60:
            unit = "second" if seconds == 1 else "seconds"
            return f"Duration: {seconds} {unit}"
        minutes = seconds // 60
        if minutes < 60:
            unit = "minute" if minutes == 1 else "minutes"
            return f"Duration: {minutes} {unit}"
        hours, remaining_minutes = divmod(minutes, 60)
        hour_unit = "hour" if hours == 1 else "hours"
        if remaining_minutes == 0:
            return f"Duration: {hours} {hour_unit}"
        minute_unit = "minute" if remaining_minutes == 1 else "minutes"
        return f"Duration: {hours} {hour_unit} {remaining_minutes} {minute_unit}"

    def _duration_short_text(self, anchor: Anchor) -> str:
        seconds = max(int(anchor.duration_seconds or 0), 0)
        if seconds < 60:
            return "<1 min"
        minutes = max(seconds // 60, 1)
        if minutes < 60:
            return f"{minutes} min"
        hours, remaining_minutes = divmod(minutes, 60)
        if remaining_minutes == 0:
            return f"{hours} hr"
        return f"{hours} hr {remaining_minutes} min"

    def _display_title(self, anchor: Anchor) -> str:
        if len(anchor.urls) > 1:
            count = len(anchor.urls)
            noun = "tab" if count == 1 else "tabs"
            return f"{count} saved {noun} browsing session"
        value = (anchor.context_title or anchor.window_title).strip()
        app_name = app_display_name(anchor)
        if " | " in value:
            value = value.split(" | ", 1)[0].strip()
        if value.endswith(f" - {app_name}"):
            value = value[: -(len(app_name) + 3)].strip()
        if value.endswith(f"| {app_name}"):
            value = value[: -(len(app_name) + 2)].strip()
        if value.lower() == app_name.lower():
            return app_name
        if value.lower() in {"newtab", "new tab"}:
            return "New Tab"
        return value


class TabSelectionDialog(QDialog):
    def __init__(self, anchor: Anchor, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.anchor = anchor
        self._checkboxes: list[QCheckBox] = []
        self.setWindowTitle("Choose Tabs")
        self.setModal(True)
        self.resize(500, 420)
        self.setFont(QFont("Segoe UI", 11))
        if ICON_PATH.exists():
            self.setWindowIcon(QIcon(str(ICON_PATH)))

        layout = QVBoxLayout(self)
        layout.setContentsMargins(20, 20, 20, 20)
        layout.setSpacing(14)

        title = QLabel("Choose which saved tabs to reopen")
        title.setObjectName("DialogTitle")
        title.setFont(QFont("Segoe UI", 18, QFont.Weight.Bold))
        layout.addWidget(title)

        subtitle = QLabel(app_display_name(anchor))
        subtitle.setObjectName("DialogSubtitle")
        subtitle.setFont(QFont("Segoe UI", 11))
        layout.addWidget(subtitle)

        tab_list = QListWidget()
        tab_list.setSelectionMode(QAbstractItemView.SelectionMode.NoSelection)
        tab_list.setSpacing(6)
        layout.addWidget(tab_list, 1)

        labels = anchor.tabs
        for index, url in enumerate(anchor.urls):
            item = QListWidgetItem()
            item.setFlags(item.flags() & ~Qt.ItemFlag.ItemIsSelectable)
            checkbox = QCheckBox(self._tab_label(index, labels, url))
            checkbox.setChecked(True)
            checkbox.setObjectName("TabChoice")
            checkbox.setFont(QFont("Segoe UI", 12))
            self._checkboxes.append(checkbox)
            item.setSizeHint(checkbox.sizeHint())
            tab_list.addItem(item)
            tab_list.setItemWidget(item, checkbox)

        buttons = QDialogButtonBox(self)
        open_selected = buttons.addButton("Open Selected", QDialogButtonBox.ButtonRole.AcceptRole)
        open_all = buttons.addButton("Open All", QDialogButtonBox.ButtonRole.ActionRole)
        cancel = buttons.addButton(QDialogButtonBox.StandardButton.Cancel)
        open_selected.clicked.connect(self.accept)
        open_all.clicked.connect(self._open_all)
        cancel.clicked.connect(self.reject)
        layout.addWidget(buttons)

        check_icon_url = CHECK_ICON_PATH.as_posix()
        self.setStyleSheet(TAB_SELECTION_STYLESHEET.replace("__CHECK_ICON__", check_icon_url))
        apply_native_window_theme(self)

    def _tab_label(self, index: int, labels: list[str], url: str) -> str:
        if index < len(labels) and labels[index].strip():
            value = labels[index].strip()
            if value.lower() in {"newtab", "new tab"}:
                return "New Tab"
            return value
        parsed = urlparse(url)
        if parsed.netloc:
            return parsed.netloc.removeprefix("www.")
        return url

    def _open_all(self) -> None:
        for checkbox in self._checkboxes:
            checkbox.setChecked(True)
        self.accept()

    def selected_urls(self) -> list[str]:
        urls: list[str] = []
        for checkbox, url in zip(self._checkboxes, self.anchor.urls):
            if checkbox.isChecked():
                urls.append(url)
        return urls


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("MemAct")
        self.resize(980, 760)
        self.setMinimumSize(820, 620)
        if ICON_PATH.exists():
            self.setWindowIcon(QIcon(str(ICON_PATH)))

        self.settings = load_settings()
        self.browser_state_store = BrowserStateStore()
        self.browser_bridge = BrowserBridgeServer(self.browser_state_store)
        self._services_started = False
        self._db_ready = False
        self._quitting = False
        self._selected_group_id: int | None = None
        self._current_mode = "timeline"

        self._bridge = SignalBridge()
        self._bridge.anchor_saved.connect(self._handle_new_anchor)
        self._bridge.runtime_ready.connect(self._finish_runtime_initialization)
        self._pending_anchor_refresh = False
        self._native_theme_applied = False
        self._initial_population_done = False

        self._build_ui()
        self._build_tray()
        self._build_overflow_menu()

        self.monitor = WindowMonitor(
            on_new_anchor=self._bridge.anchor_saved.emit,
            browser_state_store=self.browser_state_store,
        )

        self.refresh_timer = QTimer(self)
        self.refresh_timer.timeout.connect(self.refresh_timeline)
        self.refresh_timer.start(5000)

        self.view_refresh_timer = QTimer(self)
        self.view_refresh_timer.setSingleShot(True)
        self.view_refresh_timer.timeout.connect(self._safe_rebuild_views)

        self.resize_refresh_timer = QTimer(self)
        self.resize_refresh_timer.setSingleShot(True)
        self.resize_refresh_timer.timeout.connect(self._refresh_visible_lists)

        self._show_startup_shell()
        QTimer.singleShot(700, self._initialize_runtime_async)

    def _build_ui(self) -> None:
        central = QWidget(self)
        central.setObjectName("AppRoot")
        layout = QVBoxLayout(central)
        layout.setContentsMargins(32, 24, 32, 18)
        layout.setSpacing(18)

        self.setFont(QFont("Segoe UI", 11))

        self.setStyleSheet(
            """
            QMainWindow {
                background: #000543;
            }
            QWidget#AppRoot {
                background: #000543;
                color: #ffffff;
                font-family: "Segoe UI", sans-serif;
            }
            QLabel {
                background: transparent;
            }
            QFrame#HeroCard {
                background: transparent;
                border: none;
            }
            QLabel#Eyebrow {
                font-size: 11px;
                letter-spacing: 3px;
                color: rgba(255, 255, 255, 0.60);
                font-weight: 700;
            }
            QLabel#Title {
                font-size: 58px;
                font-weight: 700;
                color: #ffffff;
                letter-spacing: 1px;
            }
            QLabel#Subtitle {
                font-size: 16px;
                color: rgba(255, 255, 255, 0.72);
            }
            QLabel#Badge {
                background: #0038ff;
                color: #ffffff;
                border: 1px solid rgba(0, 56, 255, 0.28);
                border-radius: 14px;
                padding: 6px 12px;
                font-size: 12px;
                font-weight: 600;
            }
            QFrame#PanelCard {
                background: rgba(255, 255, 255, 0.03);
                border: 1px solid rgba(0, 56, 255, 0.22);
                border-radius: 24px;
            }
            QLabel#SidebarTitle {
                font-size: 12px;
                letter-spacing: 1px;
                color: rgba(255, 255, 255, 0.72);
                font-weight: 700;
            }
            QLabel#ModeTitle {
                font-size: 12px;
                letter-spacing: 1px;
                color: rgba(255, 255, 255, 0.58);
                font-weight: 700;
            }
            QFrame#ModeDock {
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(0, 56, 255, 0.18);
                border-radius: 22px;
            }
            QLabel#FilterLabel {
                font-size: 13px;
                color: rgba(255, 255, 255, 0.72);
            }
            QLabel#SearchEmptyTitle {
                font-size: 22px;
                font-weight: 700;
                color: #ffffff;
            }
            QLabel#SearchEmptyBody {
                font-size: 14px;
                color: rgba(255, 255, 255, 0.62);
            }
            QLabel#SearchHintLabel {
                font-size: 12px;
                color: rgba(255, 255, 255, 0.58);
                font-weight: 600;
            }
            QLabel#SearchHintText {
                font-size: 12px;
                color: rgba(255, 255, 255, 0.72);
            }
            QLabel#GroupHeader {
                font-size: 12px;
                font-weight: 700;
                color: rgba(255, 255, 255, 0.72);
                letter-spacing: 0.8px;
            }
            QListWidget {
                border: 1px solid rgba(0, 56, 255, 0.24);
                background: rgba(255, 255, 255, 0.03);
                color: #ffffff;
                border-radius: 22px;
                outline: none;
                padding: 12px;
                font-size: 13px;
            }
            QListWidget::item {
                border: none;
                margin: 0;
                padding: 0;
            }
            QListWidget::item:selected {
                background: transparent;
                color: palette(text);
            }
            QListWidget#GroupList {
                padding: 6px;
            }
            QLineEdit#SearchBar {
                background: rgba(255, 255, 255, 0.05);
                color: #ffffff;
                border: 1px solid rgba(0, 56, 255, 0.24);
                border-radius: 18px;
                padding: 16px 18px;
                font-size: 16px;
                selection-background-color: #0038ff;
            }
            QLineEdit#SearchBar:focus {
                border: 1px solid rgba(255, 255, 255, 0.35);
            }
            QInputDialog {
                background: #000543;
                color: #ffffff;
            }
            QInputDialog QLabel {
                color: #ffffff;
                background: transparent;
            }
            QInputDialog QLineEdit, QInputDialog QComboBox {
                background: rgba(255, 255, 255, 0.05);
                color: #ffffff;
                border: 1px solid rgba(0, 56, 255, 0.24);
                border-radius: 12px;
                padding: 10px 12px;
            }
            QScrollBar:vertical {
                background: transparent;
                width: 14px;
                margin: 10px 4px 10px 0px;
            }
            QScrollBar::handle:vertical {
                background: rgba(0, 56, 255, 0.85);
                border-radius: 7px;
                min-height: 34px;
            }
            QScrollBar::handle:vertical:hover {
                background: #1a4fff;
            }
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical {
                height: 0px;
                background: transparent;
            }
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {
                background: transparent;
            }
            QScrollBar:horizontal {
                background: transparent;
                height: 14px;
                margin: 0px 10px 4px 10px;
            }
            QScrollBar::handle:horizontal {
                background: rgba(0, 56, 255, 0.85);
                border-radius: 7px;
                min-width: 34px;
            }
            QScrollBar::handle:horizontal:hover {
                background: #1a4fff;
            }
            QScrollBar::add-line:horizontal, QScrollBar::sub-line:horizontal {
                width: 0px;
                background: transparent;
            }
            QScrollBar::add-page:horizontal, QScrollBar::sub-page:horizontal {
                background: transparent;
            }
            QPushButton {
                background: #0038ff;
                color: #ffffff;
                border: 1px solid rgba(0, 56, 255, 0.26);
                border-radius: 14px;
                padding: 10px 18px;
                font-size: 13px;
                font-weight: 600;
            }
            QPushButton:hover {
                background: #1a4fff;
            }
            QPushButton:pressed {
                background: #0029bf;
            }
            QPushButton:disabled {
                background: rgba(255, 255, 255, 0.08);
                color: rgba(255, 255, 255, 0.42);
                border: 1px solid rgba(255, 255, 255, 0.10);
            }
            QPushButton#OverflowButton {
                background: rgba(255, 255, 255, 0.06);
                border: 1px solid rgba(0, 56, 255, 0.20);
                border-radius: 18px;
                color: #ffffff;
                font-size: 22px;
                font-weight: 700;
                padding: 0px;
            }
            QPushButton#OverflowButton:hover {
                background: rgba(255, 255, 255, 0.12);
            }
            QPushButton#OverflowButton:pressed {
                background: rgba(255, 255, 255, 0.18);
            }
            QPushButton#GroupAction {
                padding: 8px 12px;
                font-size: 12px;
            }
            QLabel#GroupRowTitle {
                font-size: 15px;
                font-weight: 600;
                color: #ffffff;
            }
            QLabel#GroupRowCount {
                background: rgba(255, 255, 255, 0.08);
                color: rgba(255, 255, 255, 0.86);
                border-radius: 13px;
                padding: 5px 10px;
                font-size: 12px;
                font-weight: 700;
                min-width: 22px;
            }
            QPushButton#GroupRowMenu {
                background: transparent;
                color: rgba(255, 255, 255, 0.84);
                border: 1px solid rgba(0, 56, 255, 0.14);
                border-radius: 12px;
                padding: 0px;
                font-size: 18px;
                font-weight: 700;
            }
            QPushButton#GroupRowMenu:hover {
                background: rgba(255, 255, 255, 0.08);
            }
            QPushButton#ModeTab {
                background: transparent;
                color: rgba(255, 255, 255, 0.70);
                border: none;
                border-radius: 16px;
                padding: 0px;
                font-size: 16px;
                font-weight: 600;
                min-width: 64px;
                max-width: 64px;
                min-height: 52px;
                max-height: 52px;
            }
            QPushButton#ModeTab:hover {
                background: rgba(255, 255, 255, 0.06);
            }
            QPushButton#ModeTab[selected="true"] {
                background: #0038ff;
                color: #ffffff;
                border: 1px solid rgba(0, 56, 255, 0.30);
            }
            QStatusBar {
                color: #ffffff;
                background: #000543;
            }
            QWidget#AnchorRow {
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(0, 56, 255, 0.18);
                border-radius: 18px;
            }
            QWidget#AnchorRow[selected="true"] {
                background: #0038ff;
                border: 1px solid rgba(0, 56, 255, 0.30);
            }
            QLabel#AnchorTitle {
                font-size: 21px;
                font-weight: 700;
                color: #ffffff;
            }
            QLabel#AnchorMeta {
                font-size: 13px;
                color: rgba(255, 255, 255, 0.70);
            }
            QPushButton#CardAction {
                padding: 8px 14px;
                font-size: 12px;
            }
            QWidget#AnchorRow[selected="true"] QLabel#AnchorTitle {
                color: #ffffff;
            }
            QWidget#AnchorRow[selected="true"] QLabel#AnchorMeta {
                color: #e6f4ff;
            }
            QWidget#JumpOverlay {
                background: rgba(0, 5, 67, 0.94);
                border: 1px solid rgba(0, 56, 255, 0.32);
                border-radius: 18px;
            }
            QLabel#JumpOverlayTitle {
                color: rgba(255, 255, 255, 0.72);
                font-size: 12px;
                font-weight: 700;
                letter-spacing: 1px;
            }
            QLabel#JumpOverlaySession {
                color: #ffffff;
                font-size: 16px;
                font-weight: 700;
            }
            QLabel#JumpOverlayTime {
                color: rgba(255, 255, 255, 0.72);
                font-size: 12px;
            }
            QMessageBox {
                background: #000543;
            }
            QMessageBox QLabel {
                color: #ffffff;
                background: transparent;
                font-size: 14px;
            }
            QMessageBox QPushButton {
                min-width: 88px;
                padding: 9px 16px;
            }
            QMessageBox QWidget {
                background: #000543;
            }
            """
        )

        hero = QFrame(central)
        hero.setObjectName("HeroCard")
        hero_layout = QVBoxLayout(hero)
        hero_layout.setContentsMargins(10, 8, 10, 8)
        hero_layout.setSpacing(14)

        utility_row = QHBoxLayout()
        utility_row.setSpacing(12)
        utility_row.addStretch(1)

        title = QLabel("MemAct")
        title.setObjectName("Title")
        title.setFont(self._brand_font())
        title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        eyebrow = QLabel("YOUR DIGITAL TIME MACHINE")
        eyebrow.setObjectName("Eyebrow")
        eyebrow.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.anchor_count_badge = QLabel("0 sessions")
        self.anchor_count_badge.setObjectName("Badge")
        self.anchor_count_badge.setAlignment(Qt.AlignmentFlag.AlignCenter)

        self.menu_button = QPushButton("...")
        self.menu_button.setObjectName("OverflowButton")
        self.menu_button.setFixedSize(44, 44)
        self.menu_button.clicked.connect(self._show_overflow_menu)

        utility_row.addWidget(self.anchor_count_badge, 0, Qt.AlignmentFlag.AlignVCenter)
        utility_row.addWidget(self.menu_button, 0, Qt.AlignmentFlag.AlignVCenter)
        hero_layout.addLayout(utility_row)
        hero_layout.addWidget(eyebrow)
        hero_layout.addWidget(title)

        mode_title = QLabel("MODES")
        mode_title.setObjectName("ModeTitle")
        mode_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        hero_layout.addWidget(mode_title)

        dock_row = QHBoxLayout()
        dock_row.addStretch(1)
        mode_dock = QFrame(hero)
        mode_dock.setObjectName("ModeDock")
        mode_dock_layout = QHBoxLayout(mode_dock)
        mode_dock_layout.setContentsMargins(8, 8, 8, 8)
        mode_dock_layout.setSpacing(6)
        self.timeline_tab_button = self._create_mode_button("timeline", TIMELINE_ICON_PATH, "Timeline")
        self.search_tab_button = self._create_mode_button("search", SEARCH_ICON_PATH, "Search")
        self.groups_tab_button = self._create_mode_button("groups", GROUPS_ICON_PATH, "Groups")
        self.timeline_tab_button.setToolTip("Timeline")
        self.search_tab_button.setToolTip("Search")
        self.groups_tab_button.setToolTip("Groups")
        mode_dock_layout.addWidget(self.timeline_tab_button)
        mode_dock_layout.addWidget(self.search_tab_button)
        mode_dock_layout.addWidget(self.groups_tab_button)
        dock_row.addWidget(mode_dock, 0, Qt.AlignmentFlag.AlignCenter)
        dock_row.addStretch(1)
        hero_layout.addLayout(dock_row)

        self.timeline = self._create_session_list()
        self.timeline.currentItemChanged.connect(
            lambda current, previous: self._update_selection_state(self.timeline, current, previous)
        )

        self.search_results = self._create_session_list()
        self.search_results.currentItemChanged.connect(
            lambda current, previous: self._update_selection_state(self.search_results, current, previous)
        )

        self.search_input = QLineEdit()
        self.search_input.setObjectName("SearchBar")
        self.search_input.setPlaceholderText("Search sessions and groups")
        self.search_input.setFixedHeight(60)
        self.search_input.textChanged.connect(self._search_text_changed)
        self.search_hint = SearchHintRow()

        self.group_filter_label = QLabel("All Sessions")
        self.group_filter_label.setObjectName("FilterLabel")

        self.content_stack = QStackedWidget(central)

        timeline_page = QFrame(self.content_stack)
        timeline_page.setObjectName("PanelCard")
        timeline_layout = QVBoxLayout(timeline_page)
        timeline_layout.setContentsMargins(18, 18, 18, 18)
        timeline_layout.setSpacing(12)
        timeline_layout.addWidget(self.group_filter_label)
        timeline_layout.addWidget(self.timeline, 1)

        search_page = QFrame(self.content_stack)
        search_page.setObjectName("PanelCard")
        search_layout = QVBoxLayout(search_page)
        search_layout.setContentsMargins(18, 18, 18, 18)
        search_layout.setSpacing(10)
        search_layout.addWidget(self.search_input)
        search_layout.addWidget(self.search_hint)
        self.search_stack = QStackedWidget(search_page)
        search_empty = QWidget(self.search_stack)
        search_empty_layout = QVBoxLayout(search_empty)
        search_empty_layout.setContentsMargins(4, 18, 4, 6)
        search_empty_layout.addStretch(1)
        search_empty_title = QLabel("Start with a word, app, or site")
        search_empty_title.setObjectName("SearchEmptyTitle")
        search_empty_title.setAlignment(Qt.AlignmentFlag.AlignCenter)
        search_empty_body = QLabel("Try youtube, terminal, github, or a group name.")
        search_empty_body.setObjectName("SearchEmptyBody")
        search_empty_body.setAlignment(Qt.AlignmentFlag.AlignCenter)
        search_empty_layout.addWidget(search_empty_title)
        search_empty_layout.addWidget(search_empty_body)
        search_empty_layout.addStretch(1)
        self.search_stack.addWidget(search_empty)
        self.search_stack.addWidget(self.search_results)
        search_layout.addWidget(self.search_stack, 1)

        groups_page = QFrame(self.content_stack)
        groups_page.setObjectName("PanelCard")
        groups_layout = QVBoxLayout(groups_page)
        groups_layout.setContentsMargins(18, 18, 18, 18)
        groups_layout.setSpacing(12)

        groups_title = QLabel("GROUPS")
        groups_title.setObjectName("SidebarTitle")
        groups_layout.addWidget(groups_title)

        self.group_list = QListWidget()
        self.group_list.setObjectName("GroupList")
        self.group_list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.group_list.currentItemChanged.connect(self._group_selection_changed)
        groups_layout.addWidget(self.group_list, 1)

        self.content_stack.addWidget(timeline_page)
        self.content_stack.addWidget(search_page)
        self.content_stack.addWidget(groups_page)

        button_row = QHBoxLayout()
        button_row.setSpacing(10)
        self.clear_button = QPushButton("Clear All")
        self.clear_button.clicked.connect(self.clear_all)
        self.refresh_button = QPushButton("Refresh")
        self.refresh_button.clicked.connect(self._manual_refresh)

        button_row.addStretch(1)
        button_row.addWidget(self.clear_button)
        button_row.addWidget(self.refresh_button)

        layout.addWidget(hero)
        layout.addWidget(self.content_stack, 1)
        layout.addLayout(button_row)

        self.setCentralWidget(central)
        self.status_bar = QStatusBar(self)
        self.setStatusBar(self.status_bar)
        self.jump_overlay: JumpOverlay | None = None
        self._set_mode("timeline")

    def _brand_font(self) -> QFont:
        loaded_family = None
        if ORBITRON_FONT_PATH.exists():
            font_id = QFontDatabase.addApplicationFont(str(ORBITRON_FONT_PATH))
            if font_id != -1:
                families = QFontDatabase.applicationFontFamilies(font_id)
                if families:
                    loaded_family = families[0]

        if loaded_family:
            font = QFont(loaded_family, 34)
            font.setBold(True)
            return font

        fallback = QFont("Segoe UI", 34)
        fallback.setBold(True)
        return fallback

    def _create_mode_button(self, mode: str, icon_path: Path, tooltip: str) -> QPushButton:
        button = QPushButton("")
        button.setObjectName("ModeTab")
        button.setProperty("selected", False)
        button.setToolTip(tooltip)
        if icon_path.exists():
            button.setIcon(QIcon(str(icon_path)))
            button.setIconSize(QSize(24, 24))
        button.clicked.connect(lambda _checked=False, selected_mode=mode: self._set_mode(selected_mode))
        return button

    def _create_session_list(self) -> QListWidget:
        session_list = QListWidget()
        session_list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        session_list.itemDoubleClicked.connect(self.jump_back_selected)
        session_list.setVerticalScrollMode(QAbstractItemView.ScrollMode.ScrollPerPixel)
        session_list.setSpacing(8)
        return session_list

    def _active_session_list(self) -> QListWidget | None:
        if self._current_mode == "search":
            return self.search_results
        if self._current_mode == "timeline":
            return self.timeline
        return None

    def _set_mode(self, mode: str) -> None:
        self._current_mode = mode
        buttons = {
            "timeline": self.timeline_tab_button,
            "search": self.search_tab_button,
            "groups": self.groups_tab_button,
        }
        indexes = {
            "timeline": 0,
            "search": 1,
            "groups": 2,
        }
        for button_mode, button in buttons.items():
            button.setProperty("selected", button_mode == mode)
            button.style().unpolish(button)
            button.style().polish(button)
            button.update()
        self.content_stack.setCurrentIndex(indexes.get(mode, 0))
        if mode == "search":
            self.search_input.setFocus(Qt.FocusReason.OtherFocusReason)
            self._rebuild_search()
        elif mode == "timeline":
            self._rebuild_timeline()
        else:
            self._rebuild_groups()
        self._update_action_states()

    def _position_jump_overlay(self) -> None:
        if self.jump_overlay is None:
            return
        central = self.centralWidget()
        if central is None:
            return
        overlay_width = 280
        overlay_height = self.jump_overlay.sizeHint().height() or 110
        self.jump_overlay.resize(overlay_width, overlay_height)
        x = central.width() - overlay_width - 28
        y = central.height() - overlay_height - 28
        self.jump_overlay.move(max(x, 20), max(y, 20))

    def _show_jump_overlay(self, anchor: Anchor) -> None:
        if self.jump_overlay is None:
            central = self.centralWidget()
            if central is None:
                return
            self.jump_overlay = JumpOverlay(central)
            self.jump_overlay.resize(280, 110)
        title = (anchor.context_title or anchor.window_title or "").strip()
        app_name = app_display_name(anchor)
        if " | " in title:
            title = title.split(" | ", 1)[0].strip()
        if title.endswith(f" - {app_name}"):
            title = title[: -(len(app_name) + 3)].strip()
        if len(anchor.urls) > 1:
            count = len(anchor.urls)
            title = f"{count} saved {'tab' if count == 1 else 'tabs'} browsing session"
        if not title:
            title = app_name
        try:
            overlay_time = datetime.fromisoformat(anchor.timestamp_start).strftime(
                "%#I:%M %p" if sys.platform == "win32" else "%-I:%M %p"
            )
        except ValueError:
            overlay_time = anchor.timestamp_start
        self.jump_overlay.session_label.setText(title)
        self.jump_overlay.time_label.setText(overlay_time)
        self._position_jump_overlay()
        self.jump_overlay.show()
        self.jump_overlay.raise_()
        QTimer.singleShot(1600, self.jump_overlay.hide)

    def _build_tray(self) -> None:
        if ICON_PATH.exists():
            tray_icon = QIcon(str(ICON_PATH))
        else:
            tray_icon = self.style().standardIcon(self.style().StandardPixmap.SP_ComputerIcon)
        self.tray = QSystemTrayIcon(tray_icon, self)
        self.tray.setToolTip("MemAct is recording your sessions")

        tray_menu = QMenu(self)
        show_action = QAction("Show", self)
        show_action.triggered.connect(self.show_window)
        quit_action = QAction("Quit", self)
        quit_action.triggered.connect(self.quit_app)

        tray_menu.addAction(show_action)
        tray_menu.addSeparator()
        tray_menu.addAction(quit_action)

        self.tray.setContextMenu(tray_menu)
        self.tray.activated.connect(self._handle_tray_click)
        self.tray.show()

    def _build_overflow_menu(self) -> None:
        self.overflow_menu = QMenu(self)
        self.overflow_menu.setStyleSheet(
            """
            QMenu {
                background: #000543;
                color: #ffffff;
                border: 1px solid rgba(0, 56, 255, 0.22);
                padding: 8px;
            }
            QMenu::item {
                padding: 8px 16px;
                border-radius: 10px;
            }
            QMenu::item:selected {
                background: #0038ff;
            }
            """
        )
        install_action = self.overflow_menu.addAction("Install Browser Extensions")
        install_action.triggered.connect(self._open_browser_setup_from_menu)
        self.group_row_menu = QMenu(self)
        self.group_row_menu.setStyleSheet(self.overflow_menu.styleSheet())
        self._group_row_menu_group_id: int | None = None
        rename_action = self.group_row_menu.addAction("Rename")
        rename_action.triggered.connect(self.rename_selected_group)
        move_action = self.group_row_menu.addAction("Move Selected Session")
        move_action.triggered.connect(self.move_selected_session)
        merge_action = self.group_row_menu.addAction("Merge")
        merge_action.triggered.connect(self.merge_selected_group)
        delete_action = self.group_row_menu.addAction("Delete")
        delete_action.triggered.connect(self.delete_selected_group)

    def _show_overflow_menu(self) -> None:
        self.overflow_menu.popup(
            self.menu_button.mapToGlobal(self.menu_button.rect().bottomLeft())
        )

    def _show_group_row_menu(self, row_widget: GroupRow) -> None:
        item = None
        for index in range(self.group_list.count()):
            candidate = self.group_list.item(index)
            if self.group_list.itemWidget(candidate) is row_widget:
                item = candidate
                break
        if item is None:
            return
        self.group_list.setCurrentItem(item)
        group_id = item.data(Qt.ItemDataRole.UserRole)
        if group_id is None:
            return
        self._selected_group_id = group_id
        self._update_group_filter_label()
        self.group_row_menu.popup(
            row_widget.menu_button.mapToGlobal(row_widget.menu_button.rect().bottomLeft())
        )

    def _handle_tray_click(self, reason: QSystemTrayIcon.ActivationReason) -> None:
        if reason == QSystemTrayIcon.ActivationReason.Trigger:
            self.show_window()

    def _schedule_view_refresh(self, delay_ms: int = 0) -> None:
        self.view_refresh_timer.start(max(delay_ms, 0))

    def _start_background_services(self) -> None:
        if self._services_started:
            return
        self.browser_bridge.start()
        self.monitor.start()
        self._services_started = True

    def _initialize_runtime_async(self) -> None:
        if self._db_ready:
            return
        threading.Thread(target=self._initialize_runtime_worker, daemon=True).start()

    def _initialize_runtime_worker(self) -> None:
        init_db()
        self._bridge.runtime_ready.emit()

    def _finish_runtime_initialization(self) -> None:
        if self._db_ready:
            return
        self._db_ready = True
        self._schedule_view_refresh(0)
        QTimer.singleShot(250, self._start_background_services)
        QTimer.singleShot(900, self._maybe_show_browser_setup)

    def _show_startup_shell(self) -> None:
        self.anchor_count_badge.setText("Loading")
        self.status_bar.showMessage("Starting MemAct...")
        self.timeline.clear()
        self.search_results.clear()
        self.group_list.clear()

    def _refresh_visible_lists(self) -> None:
        if not self._initial_population_done:
            return
        if self._current_mode == "search":
            self._rebuild_search()
        elif self._current_mode == "timeline":
            self._rebuild_timeline()

    def _schedule_visible_list_refresh(self, delay_ms: int = 0) -> None:
        self.resize_refresh_timer.start(max(delay_ms, 0))

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        if not self._native_theme_applied:
            apply_native_window_theme(self)
            self._native_theme_applied = True
        self._schedule_view_refresh(80)

    def changeEvent(self, event) -> None:  # noqa: N802
        super().changeEvent(event)
        if event.type() != QEvent.Type.WindowStateChange:
            return
        if not self.isMinimized() and self.isVisible():
            self._schedule_view_refresh(80)

    def show_window(self) -> None:
        self.show()
        self.raise_()
        self.activateWindow()
        self._schedule_view_refresh(60)

    def resizeEvent(self, event) -> None:  # noqa: N802
        super().resizeEvent(event)
        self._position_jump_overlay()
        self._schedule_visible_list_refresh(120)

    def quit_app(self) -> None:
        self._quitting = True
        if self._services_started:
            self.monitor.stop()
            self.browser_bridge.stop()
        self.tray.hide()
        self.close()
        QApplication.quit()

    def closeEvent(self, event) -> None:  # noqa: N802
        if self._quitting:
            super().closeEvent(event)
            return
        event.ignore()
        self.hide()
        if self._pending_anchor_refresh:
            self._rebuild_views()
        self.tray.showMessage(
            "MemAct",
            "Still running in the background and recording sessions.",
            QSystemTrayIcon.MessageIcon.Information,
            2000,
        )

    def refresh_timeline(self) -> None:
        if not self._db_ready:
            return
        if self.isVisible() and not self.isMinimized():
            return
        self._rebuild_views()

    def _manual_refresh(self) -> None:
        if not self._db_ready:
            return
        self._rebuild_views()

    def _update_selection_state(
        self,
        list_widget: QListWidget,
        current: QListWidgetItem | None,
        previous: QListWidgetItem | None,
    ) -> None:
        for item, selected in ((previous, False), (current, True)):
            if item is None:
                continue
            widget = list_widget.itemWidget(item)
            if isinstance(widget, AnchorRow):
                widget.set_selected(selected)
                row_width = max(list_widget.viewport().width() - 20, 280)
                item.setSizeHint(widget.size_hint_for_width(row_width))
        self._update_action_states()

    def _selected_anchor(self) -> Anchor | None:
        active_list = self._active_session_list()
        if active_list is None:
            return None
        item = active_list.currentItem()
        if item is None:
            return None
        return item.data(Qt.ItemDataRole.UserRole)

    def _jump_back_anchor(self, anchor: Anchor | None) -> None:
        if anchor is None:
            self._show_info_dialog("MemAct", "Select a session first.")
            return
        if len(anchor.urls) > 1:
            dialog = TabSelectionDialog(anchor, self)
            if dialog.exec() != QDialog.DialogCode.Accepted:
                return
            selected_urls = dialog.selected_urls()
            if not selected_urls:
                self._show_info_dialog("Jump Back", "Select at least one tab to reopen.")
                return
            message = restore_browser_urls(anchor, selected_urls)
        else:
            message = restore_anchor(anchor)
        if message.lower().startswith("could not") or message.lower().startswith("this anchor"):
            self._show_info_dialog("Jump Back", message)
            return
        self.status_bar.showMessage(message, 2500)
        self._show_jump_overlay(anchor)

    def jump_back_selected(self, item: QListWidgetItem | None = None) -> None:
        del item
        self._jump_back_anchor(self._selected_anchor())

    def _open_tab_picker_for_anchor(self, anchor: Anchor) -> None:
        dialog = TabSelectionDialog(anchor, self)
        if dialog.exec() != QDialog.DialogCode.Accepted:
            return
        selected_urls = dialog.selected_urls()
        if not selected_urls:
            self._show_info_dialog("Jump Back", "Select at least one tab to reopen.")
            return
        message = restore_browser_urls(anchor, selected_urls)
        if message.lower().startswith("could not"):
            self._show_info_dialog("Jump Back", message)
            return
        self.status_bar.showMessage(message, 2500)
        self._show_jump_overlay(anchor)

    def delete_selected(self) -> None:
        anchor = self._selected_anchor()
        if anchor is None:
            return
        delete_anchor(anchor.id)
        self._rebuild_views()

    def _delete_anchor_card(self, anchor: Anchor) -> None:
        delete_anchor(anchor.id)
        self._rebuild_views()

    def clear_all(self) -> None:
        if self._show_confirmation_dialog(
            "Clear Sessions",
            "Delete all saved sessions and groups?",
        ):
            clear_anchors()
            self._selected_group_id = None
            self._rebuild_views()

    def _maybe_show_browser_setup(self) -> None:
        if self.settings.get("extension_prompt_shown"):
            return
        browsers = detect_browsers()
        self.settings["extension_prompt_shown"] = True
        save_settings(self.settings)
        if not browsers:
            return

        dialog = BrowserSetupDialog(
            browsers=browsers,
            icon_path=ICON_PATH,
            on_setup=self._run_browser_setup,
            is_browser_ready=self._is_browser_extension_ready,
            parent=self,
        )
        dialog.exec()

    def _run_browser_setup(self, browser) -> None:
        should_continue = self._show_confirmation_dialog(
            "Extension Setup",
            f"MemAct is about to open {browser.name} and then open the local extension folder.\n\nIf the browser does not land on its extensions page automatically, paste this into the address bar:\n\n{extension_manual_url(browser)}\n\nAfter that, use Load unpacked and select the folder MemAct opens next.",
        )
        if not should_continue:
            return
        launch_extension_setup(browser, EXTENSION_DIR)

    def _open_browser_setup_from_menu(self) -> None:
        browsers = detect_browsers()
        if not browsers:
            self._show_info_dialog(
                "MemAct",
                "No supported browsers were detected on this PC.",
            )
            return

        dialog = BrowserSetupDialog(
            browsers=browsers,
            icon_path=ICON_PATH,
            on_setup=self._run_browser_setup,
            is_browser_ready=self._is_browser_extension_ready,
            parent=self,
        )
        dialog.exec()

    def _show_info_dialog(self, title: str, text: str) -> None:
        dialog = QMessageBox(self)
        dialog.setWindowTitle(title)
        dialog.setText(text)
        dialog.setIcon(QMessageBox.Icon.Information)
        dialog.setStandardButtons(QMessageBox.StandardButton.Ok)
        if ICON_PATH.exists():
            dialog.setWindowIcon(QIcon(str(ICON_PATH)))
        apply_native_window_theme(dialog)
        dialog.exec()

    def _show_confirmation_dialog(self, title: str, text: str) -> bool:
        dialog = QMessageBox(self)
        dialog.setWindowTitle(title)
        dialog.setText(text)
        dialog.setIcon(QMessageBox.Icon.Information)
        dialog.setStandardButtons(
            QMessageBox.StandardButton.Ok | QMessageBox.StandardButton.Cancel
        )
        dialog.setDefaultButton(QMessageBox.StandardButton.Ok)
        if ICON_PATH.exists():
            dialog.setWindowIcon(QIcon(str(ICON_PATH)))
        apply_native_window_theme(dialog)
        result = dialog.exec()
        return result == QMessageBox.StandardButton.Ok

    def _show_text_input_dialog(
        self,
        *,
        title: str,
        label: str,
        text: str = "",
    ) -> tuple[str, bool]:
        dialog = QInputDialog(self)
        dialog.setWindowTitle(title)
        dialog.setLabelText(label)
        dialog.setTextValue(text)
        dialog.setInputMode(QInputDialog.InputMode.TextInput)
        if ICON_PATH.exists():
            dialog.setWindowIcon(QIcon(str(ICON_PATH)))
        apply_native_window_theme(dialog)
        accepted = dialog.exec() == QDialog.DialogCode.Accepted
        return dialog.textValue(), accepted

    def _show_item_input_dialog(
        self,
        *,
        title: str,
        label: str,
        items: list[str],
    ) -> tuple[str, bool]:
        dialog = QInputDialog(self)
        dialog.setWindowTitle(title)
        dialog.setLabelText(label)
        dialog.setComboBoxItems(items)
        dialog.setInputMode(QInputDialog.InputMode.TextInput)
        dialog.setOption(QInputDialog.InputDialogOption.UseListViewForComboBoxItems, True)
        if ICON_PATH.exists():
            dialog.setWindowIcon(QIcon(str(ICON_PATH)))
        apply_native_window_theme(dialog)
        accepted = dialog.exec() == QDialog.DialogCode.Accepted
        return dialog.textValue(), accepted

    def _is_browser_extension_ready(self, browser) -> bool:
        return self.browser_state_store.has_session(browser.key)

    def _selected_group_item(self) -> QListWidgetItem | None:
        return self.group_list.currentItem()

    def _selected_group(self) -> int | None:
        item = self._selected_group_item()
        if item is None:
            return None
        return item.data(Qt.ItemDataRole.UserRole)

    def _group_display_name(
        self,
        group,
        *,
        name_counts: Counter[str] | None = None,
        include_count: bool = False,
    ) -> str:
        label = group.name
        counts = name_counts or Counter()
        if counts.get(group.name, 0) > 1:
            label = f"{label} \N{BULLET} {format_group_timestamp(group.created_at)}"
        if include_count:
            label = f"{label} ({group.session_count})"
        return label

    def _update_group_filter_label(self) -> None:
        if self._selected_group_id is None:
            self.group_filter_label.setText("All Sessions")
            return
        groups = list_groups()
        current_group = next((group for group in groups if group.id == self._selected_group_id), None)
        self.group_filter_label.setText(current_group.name if current_group else "All Sessions")

    def _select_first_data_row(self, list_widget: QListWidget) -> None:
        for row_index in range(list_widget.count()):
            item = list_widget.item(row_index)
            if item.data(Qt.ItemDataRole.UserRole) is not None:
                list_widget.setCurrentRow(row_index)
                break

    def _timeline_section_label(self, value: str) -> str:
        try:
            session_date = datetime.fromisoformat(value).date()
        except ValueError:
            return "Earlier"
        today = date.today()
        if session_date == today:
            return "Today"
        if session_date == today - timedelta(days=1):
            return "Yesterday"
        if session_date >= today - timedelta(days=7):
            return "Earlier This Week"
        return session_date.strftime("%b %d")

    def _group_selection_changed(
        self,
        current: QListWidgetItem | None,
        previous: QListWidgetItem | None,
    ) -> None:
        del previous
        if current is None:
            self._selected_group_id = None
        else:
            self._selected_group_id = current.data(Qt.ItemDataRole.UserRole)
        self._update_action_states()
        self._update_group_filter_label()
        self._rebuild_timeline()
        self._rebuild_search()

    def _open_group(self, group_id: int | None) -> None:
        self._selected_group_id = group_id
        self._rebuild_groups()
        self._rebuild_timeline()
        self._rebuild_search()
        self._set_mode("timeline")

    def _search_text_changed(self, text: str) -> None:
        del text
        self._rebuild_search()

    def _update_action_states(self) -> None:
        return

    def _rebuild_groups(self) -> None:
        if not self._db_ready:
            return
        current_group_id = self._selected_group_id
        groups = list_groups()
        name_counts = Counter(group.name for group in groups)
        self.group_list.blockSignals(True)
        self.group_list.clear()

        all_item = QListWidgetItem()
        all_item.setData(Qt.ItemDataRole.UserRole, None)
        self.group_list.addItem(all_item)
        all_row = GroupRow(
            "All Sessions",
            session_count=sum(group.session_count for group in groups),
            on_open=lambda: self._open_group(None),
            show_menu=False,
            parent=self.group_list.viewport(),
        )
        all_item.setSizeHint(all_row.sizeHint())
        self.group_list.setItemWidget(all_item, all_row)
        selected_row = 0 if current_group_id is None else None

        for group in groups:
            item = QListWidgetItem()
            item.setData(Qt.ItemDataRole.UserRole, group.id)
            self.group_list.addItem(item)
            row = GroupRow(
                self._group_display_name(
                    group,
                    name_counts=name_counts,
                    include_count=False,
                ),
                session_count=group.session_count,
                on_open=lambda selected_group_id=group.id: self._open_group(selected_group_id),
                on_menu=self._show_group_row_menu,
                parent=self.group_list.viewport(),
            )
            item.setSizeHint(row.sizeHint())
            self.group_list.setItemWidget(item, row)
            if current_group_id == group.id:
                selected_row = self.group_list.count() - 1

        if selected_row is None:
            selected_row = 0
            self._selected_group_id = None

        self.group_list.setCurrentRow(selected_row)
        self.group_list.blockSignals(False)
        self._update_group_filter_label()

    def rename_selected_group(self) -> None:
        group_id = self._selected_group()
        if group_id is None:
            self._show_info_dialog("Groups", "Choose a group to rename.")
            return
        groups = list_groups()
        current_group = next((group for group in groups if group.id == group_id), None)
        if current_group is None:
            return
        name, accepted = self._show_text_input_dialog(
            title="Rename Group",
            label="Group name:",
            text=current_group.name,
        )
        if not accepted or not name.strip():
            return
        rename_group(group_id, name.strip())
        self._rebuild_views()

    def move_selected_session(self) -> None:
        anchor = self._selected_anchor()
        if anchor is None:
            self._show_info_dialog("Groups", "Choose a session to move.")
            return
        groups = list_groups()
        if not groups:
            self._show_info_dialog("Groups", "No groups are available yet.")
            return
        name_counts = Counter(group.name for group in groups)
        labels = [
            self._group_display_name(group, name_counts=name_counts)
            for group in groups
        ]
        label_to_group_id = {
            self._group_display_name(group, name_counts=name_counts): group.id
            for group in groups
        }
        label, accepted = self._show_item_input_dialog(
            title="Move Session",
            label="Move session to group:",
            items=labels,
        )
        if not accepted or not label:
            return
        target_group_id = label_to_group_id.get(label)
        target = next((group for group in groups if group.id == target_group_id), None)
        if target is None:
            return
        move_session_to_group(anchor.id, target.id)
        self._selected_group_id = target.id
        self._rebuild_views()

    def merge_selected_group(self) -> None:
        source_group_id = self._selected_group()
        if source_group_id is None:
            self._show_info_dialog("Groups", "Choose a group to merge.")
            return
        groups = [group for group in list_groups() if group.id != source_group_id]
        if not groups:
            self._show_info_dialog("Groups", "There is no other group to merge into.")
            return
        name_counts = Counter(group.name for group in groups)
        labels = [
            self._group_display_name(group, name_counts=name_counts)
            for group in groups
        ]
        label_to_group_id = {
            self._group_display_name(group, name_counts=name_counts): group.id
            for group in groups
        }
        label, accepted = self._show_item_input_dialog(
            title="Merge Groups",
            label="Merge this group into:",
            items=labels,
        )
        if not accepted or not label:
            return
        target_group_id = label_to_group_id.get(label)
        target = next((group for group in groups if group.id == target_group_id), None)
        if target is None:
            return
        merge_groups(source_group_id, target.id)
        self._selected_group_id = target.id
        self._rebuild_views()

    def delete_selected_group(self) -> None:
        group_id = self._selected_group()
        if group_id is None:
            self._show_info_dialog("Groups", "Choose a group to delete.")
            return
        if not self._show_confirmation_dialog(
            "Delete Group",
            "Delete this group? Sessions will still be available under All Sessions.",
        ):
            return
        delete_group(group_id)
        self._selected_group_id = None
        self._rebuild_views()

    def _rebuild_views(self) -> None:
        if not self._db_ready:
            return
        self._initial_population_done = True
        self._rebuild_groups()
        if self._current_mode == "search":
            self._rebuild_search()
        elif self._current_mode == "timeline":
            self._rebuild_timeline()
        else:
            self.status_bar.showMessage("Groups ready")

    def _rebuild_timeline(self) -> None:
        if not self._db_ready:
            return
        selected_anchor = self.timeline.currentItem()
        selected_anchor_data = selected_anchor.data(Qt.ItemDataRole.UserRole) if selected_anchor is not None else None
        selected_anchor_id = selected_anchor_data.id if selected_anchor_data is not None else None
        scroll_value = self.timeline.verticalScrollBar().value()
        anchors = list_anchors(group_id=self._selected_group_id)
        self.timeline.clear()
        selected_row = None
        last_section = None
        row_width = max(self.timeline.viewport().width() - 20, 280)

        self.timeline.blockSignals(True)
        for anchor in anchors:
            section_label = self._timeline_section_label(anchor.timestamp_start)
            if section_label != last_section:
                header_item = QListWidgetItem()
                header_item.setFlags(Qt.ItemFlag.NoItemFlags)
                header_item.setData(Qt.ItemDataRole.UserRole, None)
                header_row = GroupHeaderRow(section_label, self.timeline.viewport())
                header_row.setFixedWidth(row_width)
                header_row.layout().activate()
                header_item.setSizeHint(QSize(row_width, header_row.sizeHint().height()))
                self.timeline.addItem(header_item)
                self.timeline.setItemWidget(header_item, header_row)
                last_section = section_label
            item = QListWidgetItem()
            item.setData(Qt.ItemDataRole.UserRole, anchor)
            row = AnchorRow(
                anchor,
                on_jump_back=self._jump_back_anchor,
                on_delete=self._delete_anchor_card,
                on_choose_tabs=self._open_tab_picker_for_anchor,
                parent=self.timeline.viewport(),
            )
            item.setSizeHint(row.size_hint_for_width(row_width))
            self.timeline.addItem(item)
            self.timeline.setItemWidget(item, row)
            if selected_anchor_id is not None and anchor.id == selected_anchor_id:
                selected_row = self.timeline.count() - 1

        if selected_row is not None:
            self.timeline.setCurrentRow(selected_row)
        self.timeline.blockSignals(False)
        if self.timeline.currentItem() is None:
            self._select_first_data_row(self.timeline)
        current_item = self.timeline.currentItem()
        if current_item is not None:
            self._update_selection_state(self.timeline, current_item, None)
        self.timeline.verticalScrollBar().setValue(scroll_value)
        self.anchor_count_badge.setText(f"{len(anchors)} sessions")
        self.status_bar.showMessage(f"{len(anchors)} sessions stored")
        self._pending_anchor_refresh = False
        self._update_action_states()

    def _rebuild_search(self) -> None:
        if not self._db_ready:
            return
        selected_anchor = self.search_results.currentItem()
        selected_anchor_data = selected_anchor.data(Qt.ItemDataRole.UserRole) if selected_anchor is not None else None
        selected_anchor_id = selected_anchor_data.id if selected_anchor_data is not None else None
        scroll_value = self.search_results.verticalScrollBar().value()
        search_text = self.search_input.text().strip()
        if search_text:
            anchors = search_anchors(search_text, group_id=self._selected_group_id)
            self.search_stack.setCurrentIndex(1)
        else:
            anchors = []
            self.search_stack.setCurrentIndex(0)
        self.search_results.clear()
        selected_row = None
        last_group_name = None
        row_width = max(self.search_results.viewport().width() - 20, 280)

        self.search_results.blockSignals(True)
        for anchor in anchors:
            group_name = anchor.group_name or "Work Session"
            if group_name != last_group_name:
                header_item = QListWidgetItem()
                header_item.setFlags(Qt.ItemFlag.NoItemFlags)
                header_item.setData(Qt.ItemDataRole.UserRole, None)
                header_row = GroupHeaderRow(group_name, self.search_results.viewport())
                header_row.setFixedWidth(row_width)
                header_row.layout().activate()
                header_size = header_row.sizeHint()
                header_item.setSizeHint(QSize(row_width, header_size.height()))
                self.search_results.addItem(header_item)
                self.search_results.setItemWidget(header_item, header_row)
                last_group_name = group_name
            item = QListWidgetItem()
            item.setData(Qt.ItemDataRole.UserRole, anchor)
            row = AnchorRow(
                anchor,
                on_jump_back=self._jump_back_anchor,
                on_delete=self._delete_anchor_card,
                on_choose_tabs=self._open_tab_picker_for_anchor,
                search_text=search_text,
                parent=self.search_results.viewport(),
            )
            item.setSizeHint(row.size_hint_for_width(row_width))
            self.search_results.addItem(item)
            self.search_results.setItemWidget(item, row)
            if selected_anchor_id is not None and anchor.id == selected_anchor_id:
                selected_row = self.search_results.count() - 1

        if selected_row is not None:
            self.search_results.setCurrentRow(selected_row)
        self.search_results.blockSignals(False)
        if self.search_results.currentItem() is None:
            self._select_first_data_row(self.search_results)
        current_item = self.search_results.currentItem()
        if current_item is not None:
            self._update_selection_state(self.search_results, current_item, None)
        self.search_results.verticalScrollBar().setValue(scroll_value)
        self._update_action_states()

    def _handle_new_anchor(self) -> None:
        self._pending_anchor_refresh = True
        if not self.isVisible() or self.isMinimized():
            self._rebuild_views()
            return
        self._schedule_view_refresh(0)

    def _safe_rebuild_views(self) -> None:
        if not self._db_ready:
            return
        self._rebuild_views()
