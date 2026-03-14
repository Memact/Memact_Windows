# MemAct

MemAct is a minimal Windows desktop prototype that records lightweight workflow anchors and lets you jump back to them later.

The app is intentionally simple:

- local only
- no AI
- no cloud
- no analytics

## Project structure

```text
memact/
|-- main.py
|-- requirements.txt
|-- README.md
|-- core/
|   |-- __init__.py
|   |-- database.py
|   |-- monitor.py
|   `-- restorer.py
`-- ui/
    |-- __init__.py
    `-- main_window.py
```

## What it captures

Every time the active window changes, MemAct stores an anchor in SQLite with:

- timestamp
- active window title
- application name
- browser tab URL for Chrome or Edge
- browser tab lists when the MemAct browser extension is enabled

The database is stored at:

`%USERPROFILE%\AppData\Local\Memact\memact.db`

## Timeline UI

The PyQt6 window shows anchors newest first, for example:

```text
2:14 PM - chrome - Wikipedia | https://en.wikipedia.org/wiki/Memory
2:18 PM - notepad - Notes.txt
2:22 PM - msedge - Google Search | https://www.google.com/
```

Double-clicking or selecting an item and pressing `Jump Back` restores it:

- browser anchors reopen the saved URL
- if the MemAct browser extension has provided tab URLs, MemAct reopens the saved tab set in Chrome or Edge
- non-browser anchors try to relaunch the recorded application executable

## Browser Extension

MemAct includes a local browser extension in:

`extension/memact/`

On first launch, MemAct detects installed Chrome and Edge browsers and shows a setup dialog.

The setup flow:

- launches the selected browser with the unpacked extension path
- opens the browser's extension management page
- opens the extension folder locally

Important:

- Chrome and Edge do not allow a normal desktop app to silently persist-install an unpacked extension
- the browser may still require final confirmation on its extension screen
- once enabled, the extension sends focused-window tab URLs to MemAct over `http://127.0.0.1:38453`

## Dependencies

- Python 3.11+
- PyQt6
- pywinauto

Install with:

```powershell
pip install -r requirements.txt
```

## Run

```powershell
python main.py
```

## Notes

- This is a proof-of-concept Windows prototype.
- Scroll position capture is best-effort and depends on what the target app exposes through Windows accessibility APIs.
- Restoring non-browser applications only relaunches the application. It does not yet restore the exact document, cursor position, or scroll state.
