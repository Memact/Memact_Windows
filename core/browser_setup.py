from __future__ import annotations

import os
import subprocess
import winreg
from dataclasses import dataclass
from pathlib import Path


@dataclass(slots=True)
class BrowserInstall:
    key: str
    name: str
    exe_path: str
    extensions_url: str
    supported: bool = True
    help_url: str | None = None


def _app_path_from_registry(exe_name: str) -> str | None:
    try:
        with winreg.OpenKey(
            winreg.HKEY_LOCAL_MACHINE,
            fr"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe_name}",
        ) as key:
            value, _ = winreg.QueryValueEx(key, None)
            if isinstance(value, str) and Path(value).exists():
                return value
    except OSError:
        pass

    try:
        with winreg.OpenKey(
            winreg.HKEY_CURRENT_USER,
            fr"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\{exe_name}",
        ) as key:
            value, _ = winreg.QueryValueEx(key, None)
            if isinstance(value, str) and Path(value).exists():
                return value
    except OSError:
        return None

    return None


def _existing_path(candidates: list[Path]) -> str | None:
    for path in candidates:
        if path.exists():
            return str(path)
    return None


def _browser_key_from_exe(exe_path: str) -> tuple[str, str, bool] | None:
    exe_name = Path(exe_path).name.lower()
    mapping = {
        "chrome.exe": ("chrome", "chrome://extensions/", True),
        "msedge.exe": ("edge", "edge://extensions/", True),
        "brave.exe": ("brave", "brave://extensions/", True),
        "opera.exe": ("opera", "opera://extensions/", True),
        "launcher.exe": ("opera", "opera://extensions/", True),
        "vivaldi.exe": ("vivaldi", "vivaldi://extensions/", True),
        "firefox.exe": ("firefox", "about:addons", False),
    }
    return mapping.get(exe_name)


def _enum_registered_browsers(root, subkey: str) -> list[tuple[str, str]]:
    results: list[tuple[str, str]] = []
    try:
        with winreg.OpenKey(root, subkey) as key:
            count = winreg.QueryInfoKey(key)[0]
            for index in range(count):
                browser_key = winreg.EnumKey(key, index)
                try:
                    with winreg.OpenKey(key, browser_key) as browser_subkey:
                        display_name, _ = winreg.QueryValueEx(browser_subkey, None)
                    command_key_path = (
                        f"{subkey}\\{browser_key}\\shell\\open\\command"
                    )
                    with winreg.OpenKey(root, command_key_path) as command_key:
                        command, _ = winreg.QueryValueEx(command_key, None)
                    results.append((str(display_name), str(command)))
                except OSError:
                    continue
    except OSError:
        return []
    return results


def _extract_exe_path(command: str) -> str | None:
    command = command.strip()
    if not command:
        return None
    if command.startswith('"'):
        end = command.find('"', 1)
        if end > 1:
            value = command[1:end]
            return value if Path(value).exists() else None
    parts = command.split()
    if parts:
        value = parts[0]
        return value if Path(value).exists() else None
    return None


def detect_browsers() -> list[BrowserInstall]:
    local_app_data = Path(os.environ.get("LOCALAPPDATA", ""))
    program_files = Path(os.environ.get("PROGRAMFILES", ""))
    program_files_x86 = Path(os.environ.get("PROGRAMFILES(X86)", ""))

    detected: list[BrowserInstall] = []
    seen_paths: set[str] = set()

    for root in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
        for display_name, command in _enum_registered_browsers(
            root, r"SOFTWARE\Clients\StartMenuInternet"
        ):
            exe_path = _extract_exe_path(command)
            if not exe_path:
                continue
            key_info = _browser_key_from_exe(exe_path)
            if not key_info:
                continue
            browser_key, extensions_url, supported = key_info
            if exe_path.lower() in seen_paths:
                continue
            seen_paths.add(exe_path.lower())
            detected.append(
                BrowserInstall(
                    key=browser_key,
                    name=display_name,
                    exe_path=exe_path,
                    extensions_url=extensions_url,
                    supported=supported,
                    help_url=(
                        "https://support.google.com/chrome_webstore/answer/2664769"
                        if supported
                        else "https://support.mozilla.org/kb/find-and-install-add-ons-add-features-to-firefox"
                    ),
                )
            )

    chrome_path = (
        _app_path_from_registry("chrome.exe")
        or _existing_path(
            [
                local_app_data / "Google" / "Chrome" / "Application" / "chrome.exe",
                program_files / "Google" / "Chrome" / "Application" / "chrome.exe",
                program_files_x86 / "Google" / "Chrome" / "Application" / "chrome.exe",
            ]
        )
    )
    if chrome_path and chrome_path.lower() not in seen_paths:
        seen_paths.add(chrome_path.lower())
        detected.append(
            BrowserInstall(
                key="chrome",
                name="Google Chrome",
                exe_path=chrome_path,
                extensions_url="chrome://extensions/",
                help_url="https://support.google.com/chrome_webstore/answer/2664769",
            )
        )

    edge_path = (
        _app_path_from_registry("msedge.exe")
        or _existing_path(
            [
                local_app_data / "Microsoft" / "Edge" / "Application" / "msedge.exe",
                program_files / "Microsoft" / "Edge" / "Application" / "msedge.exe",
                program_files_x86 / "Microsoft" / "Edge" / "Application" / "msedge.exe",
            ]
        )
    )
    if edge_path and edge_path.lower() not in seen_paths:
        seen_paths.add(edge_path.lower())
        detected.append(
            BrowserInstall(
                key="edge",
                name="Microsoft Edge",
                exe_path=edge_path,
                extensions_url="edge://extensions/",
                help_url="https://learn.microsoft.com/microsoft-edge/extensions-chromium/getting-started/extension-sideloading",
            )
        )

    return detected


def launch_extension_setup(browser: BrowserInstall, extension_dir: Path) -> None:
    extension_dir = extension_dir.resolve()
    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = 0
    try:
        subprocess.Popen(
            [
                browser.exe_path,
                "--new-window",
                "--no-first-run",
                f"--disable-extensions-except={extension_dir}",
                f"--load-extension={extension_dir}",
                browser.extensions_url,
            ],
            creationflags=(
                subprocess.DETACHED_PROCESS
                | subprocess.CREATE_NEW_PROCESS_GROUP
                | subprocess.CREATE_NO_WINDOW
            ),
            startupinfo=startupinfo,
        )
    except Exception:
        pass

    try:
        os.startfile(extension_dir)
    except Exception:
        pass


def extension_manual_url(browser: BrowserInstall) -> str:
    return browser.extensions_url
