from __future__ import annotations

import os
import shutil
import subprocess
import webbrowser

from core.database import Anchor


def _popen_hidden(command: list[str]) -> None:
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = 0
    subprocess.Popen(
        command,
        startupinfo=startupinfo,
        creationflags=subprocess.CREATE_NO_WINDOW,
    )


def _display_name(anchor: Anchor) -> str:
    app_name = anchor.app_name.removesuffix(".exe")
    friendly_names = {
        "msedge": "Microsoft Edge",
        "chrome": "Google Chrome",
        "discord": "Discord",
        "windowsterminal": "Windows Terminal",
        "code": "Visual Studio Code",
    }
    return friendly_names.get(app_name.lower(), app_name.replace("_", " ").title())


def restore_browser_urls(anchor: Anchor, urls: list[str]) -> str:
    if not urls:
        return "No saved browser tabs were available for this session."

    if anchor.exe_path and os.path.isfile(anchor.exe_path):
        try:
            _popen_hidden([anchor.exe_path, *urls])
            if len(urls) > 1:
                return f"Opened {len(urls)} tabs in {_display_name(anchor)}."
            return f"Opened {urls[0]} with {_display_name(anchor)}."
        except Exception:
            pass

    try:
        for url in urls:
            webbrowser.open(url)
        if len(urls) > 1:
            return f"Opened {len(urls)} saved tabs."
        return f"Opened {urls[0]}."
    except Exception as exc:
        return f"Could not open saved tabs: {exc}"


def restore_anchor(anchor: Anchor) -> str:
    if anchor.url or anchor.urls:
        return restore_browser_urls(anchor, anchor.urls or ([anchor.url] if anchor.url else []))

    if anchor.exe_path and os.path.isfile(anchor.exe_path):
        try:
            os.startfile(anchor.exe_path)
            return f"Launched {_display_name(anchor)}."
        except Exception as exc:
            return f"Could not launch {anchor.exe_path}: {exc}"

    if anchor.app_name and anchor.app_name != "Unknown":
        command = shutil.which(anchor.app_name)
        if command:
            try:
                _popen_hidden([command])
                return f"Launched {_display_name(anchor)}."
            except Exception as exc:
                return f"Could not launch {anchor.app_name}: {exc}"

    return "This anchor does not have enough information to restore."
