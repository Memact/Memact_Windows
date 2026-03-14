from __future__ import annotations

import ctypes

from PyQt6.QtGui import QColor
from PyQt6.QtWidgets import QWidget


DWMWA_BORDER_COLOR = 34
DWMWA_CAPTION_COLOR = 35
DWMWA_TEXT_COLOR = 36


def _colorref(color: QColor) -> int:
    return color.red() | (color.green() << 8) | (color.blue() << 16)


def apply_native_window_theme(
    widget: QWidget,
    background: str = "#000543",
    text: str = "#ffffff",
) -> None:
    if not widget.winId():
        return

    hwnd = int(widget.winId())
    bg = ctypes.c_int(_colorref(QColor(background)))
    fg = ctypes.c_int(_colorref(QColor(text)))

    try:
        dwmapi = ctypes.windll.dwmapi
        dwmapi.DwmSetWindowAttribute(
            hwnd, DWMWA_BORDER_COLOR, ctypes.byref(bg), ctypes.sizeof(bg)
        )
        dwmapi.DwmSetWindowAttribute(
            hwnd, DWMWA_CAPTION_COLOR, ctypes.byref(bg), ctypes.sizeof(bg)
        )
        dwmapi.DwmSetWindowAttribute(
            hwnd, DWMWA_TEXT_COLOR, ctypes.byref(fg), ctypes.sizeof(fg)
        )
    except Exception:
        pass
