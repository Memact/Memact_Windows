from __future__ import annotations

import json
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


BRIDGE_HOST = "127.0.0.1"
BRIDGE_PORT = 38453


@dataclass(slots=True)
class BrowserSession:
    browser: str
    current_title: str | None
    current_url: str | None
    tab_titles: list[str]
    tab_urls: list[str]


class BrowserStateStore:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._sessions: dict[str, BrowserSession] = {}

    def update(self, payload: dict) -> None:
        browser = str(payload.get("browser", "")).lower().strip()
        tabs = payload.get("tabs") or []
        if not browser or not isinstance(tabs, list):
            return

        tab_titles: list[str] = []
        tab_urls: list[str] = []
        current_title = None
        current_url = None

        for item in tabs:
            if not isinstance(item, dict):
                continue
            title = str(item.get("title", "")).strip()
            url = str(item.get("url", "")).strip()
            if not url:
                continue
            tab_urls.append(url)
            tab_titles.append(title)
            if item.get("active"):
                current_title = title or current_title
                current_url = url

        if current_url is None and tab_urls:
            current_url = tab_urls[0]
        if current_title is None and tab_titles:
            current_title = tab_titles[0] or None

        session = BrowserSession(
            browser=browser,
            current_title=current_title,
            current_url=current_url,
            tab_titles=tab_titles,
            tab_urls=tab_urls,
        )
        with self._lock:
            self._sessions[browser] = session

    def get(self, browser: str) -> BrowserSession | None:
        with self._lock:
            return self._sessions.get(browser.lower().strip())

    def has_session(self, browser: str) -> bool:
        with self._lock:
            return browser.lower().strip() in self._sessions


class _BridgeHandler(BaseHTTPRequestHandler):
    store: BrowserStateStore | None = None

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/session":
            self.send_error(404)
            return

        content_length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(content_length)

        try:
            payload = json.loads(body.decode("utf-8"))
            if self.store is not None:
                self.store.update(payload)
        except Exception:
            self.send_error(400)
            return

        self.send_response(204)
        self.end_headers()

    def do_GET(self) -> None:  # noqa: N802
        if self.path != "/health":
            self.send_error(404)
            return
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, format: str, *args) -> None:  # noqa: A003
        return


class BrowserBridgeServer(threading.Thread):
    def __init__(self, store: BrowserStateStore) -> None:
        super().__init__(daemon=True)
        self.store = store
        self.httpd: ThreadingHTTPServer | None = None

    def run(self) -> None:
        _BridgeHandler.store = self.store
        try:
            self.httpd = ThreadingHTTPServer((BRIDGE_HOST, BRIDGE_PORT), _BridgeHandler)
            self.httpd.serve_forever(poll_interval=0.5)
        except OSError:
            self.httpd = None

    def stop(self) -> None:
        if self.httpd is not None:
            self.httpd.shutdown()
            self.httpd.server_close()
