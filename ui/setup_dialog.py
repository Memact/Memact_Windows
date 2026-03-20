from __future__ import annotations

import webbrowser

from PyQt6.QtCore import Qt
from PyQt6.QtWidgets import (
    QDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QVBoxLayout,
    QWidget,
)

from core.browser_setup import BrowserInstall
from ui.branding import app_icon
from ui.fonts import body_font
from ui.window_effects import apply_native_window_theme


class BrowserSetupDialog(QDialog):
    def __init__(
        self,
        browsers: list[BrowserInstall],
        on_setup,
        is_browser_ready=None,
        browser_status=None,
        parent=None,
    ) -> None:
        super().__init__(parent)
        self.on_setup = on_setup
        ready_check = is_browser_ready or (lambda _browser: False)
        self.browser_status = browser_status or (lambda browser: "ready" if ready_check(browser) else "setup")
        self.browsers = [browser for browser in browsers if self.browser_status(browser) != "ready"]
        self.setModal(True)
        self.setWindowTitle("Memact browser setup")
        self.setMinimumWidth(560)
        self.setFont(body_font(12))
        self.setWindowIcon(app_icon())

        self.setStyleSheet(
            """
            QDialog {
                background: #00011B;
            }
            QWidget#Root {
                background: #00011B;
                color: #ffffff;
            }
            QFrame#Panel {
                background: rgba(255, 255, 255, 0.07);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 24px;
            }
            QLabel#Eyebrow {
                color: rgba(255, 255, 255, 0.62);
                font-size: 11px;
                font-weight: 700;
                letter-spacing: 1px;
            }
            QLabel#Title {
                color: #ffffff;
                font-size: 28px;
            }
            QLabel#Body {
                color: rgba(255, 255, 255, 0.84);
                font-size: 16px;
            }
            QFrame#StepCard {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.14);
                border-radius: 16px;
            }
            QLabel#StepIndex {
                color: #ffffff;
                background: rgba(40, 74, 128, 0.22);
                border: 1px solid rgba(40, 74, 128, 0.35);
                border-radius: 12px;
                padding: 4px 8px;
                min-width: 10px;
                font-size: 13px;
                font-weight: 700;
            }
            QLabel#StepText {
                color: #ffffff;
                font-size: 15px;
            }
            QFrame#BrowserTile {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.16);
                border-radius: 18px;
            }
            QLabel#BrowserName {
                color: #ffffff;
                font-size: 18px;
            }
            QLabel#BrowserMeta {
                color: rgba(255, 255, 255, 0.76);
                font-size: 14px;
            }
            QLabel#BrowserUrl {
                color: rgba(255, 255, 255, 0.6);
                font-size: 13px;
            }
            QLabel#ReadyBadge {
                color: #ffffff;
                background: rgba(255, 255, 255, 0.08);
                border: 1px solid rgba(255, 255, 255, 0.18);
                border-radius: 12px;
                padding: 4px 10px;
                font-size: 12px;
                font-weight: 700;
            }
            QPushButton {
                background: rgba(40, 74, 128, 0.22);
                color: #ffffff;
                border: 1px solid rgba(40, 74, 128, 0.35);
                border-radius: 14px;
                padding: 10px 18px;
                font-size: 14px;
            }
            QPushButton:hover {
                background: rgba(40, 74, 128, 0.3);
            }
            QPushButton#SecondaryButton {
                background: rgba(255, 255, 255, 0.05);
                border: 1px solid rgba(255, 255, 255, 0.16);
            }
            QPushButton#SecondaryButton:hover {
                background: rgba(255, 255, 255, 0.1);
            }
            QScrollBar:vertical {
                background: transparent;
                width: 10px;
                margin: 4px 2px 4px 2px;
            }
            QScrollBar::handle:vertical {
                background: rgba(255, 255, 255, 0.22);
                border-radius: 5px;
                min-height: 24px;
            }
            QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical,
            QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical {
                background: transparent;
                border: none;
                height: 0;
            }
            """
        )

        root = QWidget(self)
        root.setObjectName("Root")
        outer = QVBoxLayout(root)
        outer.setContentsMargins(24, 24, 24, 24)
        outer.setSpacing(16)

        panel = QFrame()
        panel.setObjectName("Panel")
        panel_layout = QVBoxLayout(panel)
        panel_layout.setContentsMargins(24, 24, 24, 24)
        panel_layout.setSpacing(16)

        eyebrow = QLabel("LOCAL EXTENSION SETUP")
        eyebrow.setObjectName("Eyebrow")

        title = QLabel("Connect your browser")
        title.setObjectName("Title")
        title.setFont(body_font(22))

        body = QLabel(
            "Pick a browser once. Memact will open the extensions page and the local folder so you can finish setup in a familiar flow."
        )
        body.setObjectName("Body")
        body.setWordWrap(True)

        panel_layout.addWidget(eyebrow)
        panel_layout.addWidget(title)
        panel_layout.addWidget(body)

        steps_wrap = QVBoxLayout()
        steps_wrap.setSpacing(10)
        steps_wrap.addWidget(self._step_card("1", "Open setup for your browser."))
        steps_wrap.addWidget(self._step_card("2", "Enable Developer mode if your browser asks for it."))
        steps_wrap.addWidget(self._step_card("3", "Choose Load unpacked and select extension/memact if needed."))
        panel_layout.addLayout(steps_wrap)

        if self.browsers:
            for browser in self.browsers:
                tile = self._browser_tile(browser)
                if tile is not None:
                    panel_layout.addWidget(tile)
        else:
            empty = QLabel("All detected browsers are already connected to Memact.")
            empty.setObjectName("BrowserMeta")
            empty.setWordWrap(True)
            panel_layout.addWidget(empty)

        footer = QHBoxLayout()
        footer.setSpacing(10)
        help_button = QPushButton("Open browser help")
        help_button.setObjectName("SecondaryButton")
        help_button.clicked.connect(self._open_help_for_first_browser)
        later_button = QPushButton("Later")
        later_button.setObjectName("SecondaryButton")
        later_button.clicked.connect(self.accept)
        footer.addWidget(help_button)
        footer.addStretch(1)
        footer.addWidget(later_button)
        panel_layout.addLayout(footer)

        outer.addWidget(panel)

        dialog_layout = QVBoxLayout(self)
        dialog_layout.setContentsMargins(0, 0, 0, 0)
        dialog_layout.addWidget(root)

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        apply_native_window_theme(self)

    def _step_card(self, index: str, text: str) -> QFrame:
        card = QFrame()
        card.setObjectName("StepCard")
        layout = QHBoxLayout(card)
        layout.setContentsMargins(14, 12, 14, 12)
        layout.setSpacing(12)
        badge = QLabel(index)
        badge.setObjectName("StepIndex")
        badge.setAlignment(Qt.AlignmentFlag.AlignCenter)
        label = QLabel(text)
        label.setObjectName("StepText")
        label.setWordWrap(True)
        layout.addWidget(badge, 0, Qt.AlignmentFlag.AlignTop)
        layout.addWidget(label, 1)
        return card

    def _browser_tile(self, browser: BrowserInstall) -> QFrame:
        tile = QFrame()
        tile.setObjectName("BrowserTile")
        layout = QHBoxLayout(tile)
        layout.setContentsMargins(16, 16, 16, 16)
        layout.setSpacing(14)

        text_col = QVBoxLayout()
        text_col.setSpacing(6)

        title_row = QHBoxLayout()
        title_row.setSpacing(8)
        name = QLabel(browser.name)
        name.setObjectName("BrowserName")
        title_row.addWidget(name)
        status = self.browser_status(browser)
        if status == "ready":
            ready = QLabel("Ready")
            ready.setObjectName("ReadyBadge")
            title_row.addWidget(ready)
        elif status == "update":
            ready = QLabel("Update")
            ready.setObjectName("ReadyBadge")
            title_row.addWidget(ready)
        title_row.addStretch(1)

        if status == "ready":
            meta_text = "Extension detected and connected to Memact."
        elif status == "update":
            meta_text = "Extension detected, but an update is available."
        elif browser.supported:
            meta_text = "Detected locally. Memact can guide setup."
        else:
            meta_text = "Detected locally, but automatic setup is not supported."

        meta = QLabel(meta_text)
        meta.setObjectName("BrowserMeta")
        meta.setWordWrap(True)

        url_label = QLabel(browser.extensions_url)
        url_label.setObjectName("BrowserUrl")
        url_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)

        text_col.addLayout(title_row)
        text_col.addWidget(meta)
        text_col.addWidget(url_label)

        setup_label = "Update" if status == "update" else "Open setup"
        setup_button = QPushButton(setup_label)
        setup_button.setEnabled(browser.supported)
        setup_button.clicked.connect(
            lambda _checked=False, selected=browser: self._handle_setup(selected)
        )

        layout.addLayout(text_col, 1)
        layout.addWidget(setup_button, 0, Qt.AlignmentFlag.AlignVCenter)
        return tile

    def _handle_setup(self, browser: BrowserInstall) -> None:
        self.on_setup(browser)
        self.accept()

    def _open_help_for_first_browser(self) -> None:
        for browser in self.browsers:
            if browser.help_url:
                webbrowser.open(browser.help_url)
                break
