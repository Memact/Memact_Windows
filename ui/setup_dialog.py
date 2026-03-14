from __future__ import annotations

from pathlib import Path
import webbrowser

from PyQt6.QtCore import Qt
from PyQt6.QtGui import QIcon
from PyQt6.QtWidgets import (
    QDialog,
    QFrame,
    QHBoxLayout,
    QLabel,
    QPushButton,
    QTextBrowser,
    QVBoxLayout,
    QWidget,
)

from core.browser_setup import BrowserInstall
from ui.window_effects import apply_native_window_theme


class BrowserSetupDialog(QDialog):
    def __init__(
        self,
        browsers: list[BrowserInstall],
        icon_path: Path,
        on_setup,
        is_browser_ready=None,
        parent=None,
    ) -> None:
        super().__init__(parent)
        self.browsers = browsers
        self.on_setup = on_setup
        self.is_browser_ready = is_browser_ready or (lambda _browser: False)
        self.setModal(True)
        self.setWindowTitle("MemAct Browser Setup")
        self.setMinimumWidth(440)
        if icon_path.exists():
            self.setWindowIcon(QIcon(str(icon_path)))

        self.setStyleSheet(
            """
            QDialog {
                background: #000543;
            }
            QWidget#Root {
                background: #000543;
                color: #ffffff;
                font-family: "Segoe UI";
            }
            QFrame#Card {
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(0, 56, 255, 0.55);
                border-radius: 24px;
            }
            QLabel#Eyebrow {
                color: rgba(255, 255, 255, 0.7);
                font-size: 12px;
                font-weight: 700;
                letter-spacing: 1px;
            }
            QLabel#Title {
                color: #ffffff;
                font-size: 30px;
                font-weight: 700;
            }
            QLabel#Body {
                color: rgba(255, 255, 255, 0.84);
                font-size: 14px;
            }
            QFrame#BrowserTile {
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(0, 56, 255, 0.38);
                border-radius: 18px;
            }
            QLabel#BrowserName {
                color: #ffffff;
                font-size: 17px;
                font-weight: 700;
            }
            QLabel#BrowserMeta {
                color: rgba(255, 255, 255, 0.8);
                font-size: 13px;
            }
            QPushButton {
                background: #0038ff;
                color: #ffffff;
                border: 1px solid rgba(173, 199, 255, 0.72);
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
            """
        )

        root = QWidget(self)
        root.setObjectName("Root")
        outer = QVBoxLayout(root)
        outer.setContentsMargins(18, 18, 18, 18)

        card = QFrame()
        card.setObjectName("Card")
        card_layout = QVBoxLayout(card)
        card_layout.setContentsMargins(20, 20, 20, 20)
        card_layout.setSpacing(14)

        eyebrow = QLabel("BROWSER SETUP")
        eyebrow.setObjectName("Eyebrow")
        title = QLabel("Install the MemAct extension")
        title.setObjectName("Title")
        body = QLabel(
            "Choose a detected browser to open the MemAct extension setup. The browser still controls the final install and enable step."
        )
        body.setObjectName("Body")
        body.setWordWrap(True)

        card_layout.addWidget(eyebrow)
        card_layout.addWidget(title)
        card_layout.addWidget(body)

        instructions = QTextBrowser()
        instructions.setOpenExternalLinks(True)
        instructions.setObjectName("Instructions")
        instructions.setHtml(
            """
            <b>Manual install flow</b><br><br>
            1. Click <b>Set Up</b> for your browser.<br>
            2. MemAct opens the browser extension page and the local extension folder.<br>
            3. Turn on <b>Developer mode</b> if your browser requires it.<br>
            4. Choose <b>Load unpacked</b> and select the <code>extension/memact</code> folder if the browser does not load it automatically.<br>
            5. Pin the extension and keep the browser open once so MemAct can receive tab data.<br><br>
            If you skip this now, you can reopen setup later from the <b>three-dot menu</b> in MemAct.
            """
        )
        instructions.setMaximumHeight(132)
        instructions.setStyleSheet(
            """
            QTextBrowser {
                background: rgba(255, 255, 255, 0.04);
                border: 1px solid rgba(0, 56, 255, 0.28);
                border-radius: 16px;
                color: #ffffff;
                padding: 12px;
                font-size: 13px;
            }
            QTextBrowser QScrollBar:vertical {
                background: transparent;
                width: 10px;
            }
            QTextBrowser QScrollBar::handle:vertical {
                background: #0038ff;
                border-radius: 5px;
                min-height: 24px;
            }
            """
        )
        card_layout.addWidget(instructions)

        for browser in browsers:
            card_layout.addWidget(self._browser_tile(browser))

        skip_row = QHBoxLayout()
        help_button = QPushButton("Open Browser Help")
        help_button.clicked.connect(self._open_help_for_first_browser)
        skip_row.addWidget(help_button)
        skip_row.addStretch(1)
        skip_button = QPushButton("Later")
        skip_button.clicked.connect(self.accept)
        skip_row.addWidget(skip_button)
        card_layout.addLayout(skip_row)

        outer.addWidget(card)

        dialog_layout = QVBoxLayout(self)
        dialog_layout.setContentsMargins(0, 0, 0, 0)
        dialog_layout.addWidget(root)

    def showEvent(self, event) -> None:  # noqa: N802
        super().showEvent(event)
        apply_native_window_theme(self)

    def _browser_tile(self, browser: BrowserInstall) -> QFrame:
        tile = QFrame()
        tile.setObjectName("BrowserTile")
        layout = QHBoxLayout(tile)
        layout.setContentsMargins(16, 14, 16, 14)

        text_col = QVBoxLayout()
        text_col.setSpacing(4)
        name = QLabel(browser.name)
        name.setObjectName("BrowserName")
        if self.is_browser_ready(browser):
            meta_text = "Extension detected and talking to MemAct"
        elif browser.supported:
            meta_text = "Detected on this PC"
        else:
            meta_text = "Detected, but automatic setup is not supported for this browser"
        meta = QLabel(meta_text)
        meta.setObjectName("BrowserMeta")
        text_col.addWidget(name)
        text_col.addWidget(meta)

        url_label = QLabel(browser.extensions_url)
        url_label.setObjectName("BrowserMeta")
        url_label.setTextInteractionFlags(Qt.TextInteractionFlag.TextSelectableByMouse)
        text_col.addWidget(url_label)

        setup_button = QPushButton("Set Up")
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
