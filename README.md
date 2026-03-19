Memact

Version: v0.1

Memact is a searchable memory of your activity.

It quietly records what you do on your computer and lets you find it later.

Instead of searching the internet again, you can search your own past actions.

---

How to think about Memact

You do not remember files or tabs.
You remember moments.

Like:

- that article you read last night
- that video you watched
- that thing you saw on Reddit

Memact helps you find those moments again.

---

What you can ask

Memact is built around one simple interaction:

Ask Memact...

You can ask things like:

- Where did I see that?
- What did I do yesterday evening?
- What did I watch today?
- When did I last use Chrome?
- Did I look at the grocery order?

---

What Memact records

Memact does not track everything.

It records changes in attention. In simple terms, what you were focused on.

For example:

- switching between apps
- opening a new page
- moving from one task to another

It does not record keystrokes or anything invasive.

---

How it works

capture activity -> store it locally -> search it later

No folders.
No tagging.
No manual organization.

---

Principles

- everything stays on your device
- no cloud services
- no external APIs
- no remote AI calls
- append-only memory
- search, not dashboards

---

Interface

The app is minimal by design:

- one search box
- suggestions from recent activity
- one clear answer
- optional details if you want more

---

Browser support

Memact includes a local extension for Chromium-based browsers.

It captures:

- current tab
- page titles
- URLs

All data stays on your device and is sent only to:

http://127.0.0.1:38453

---

Storage

Data is stored locally at:

%USERPROFILE%\AppData\Local\memact\memact.db

---

Running Memact

Requirements:

- Python 3.11+
- PyQt6
- pywinauto
- sentence-transformers

Install:

pip install -r requirements.txt

Run:

python main.py

---

Notes

- Windows-first prototype
- fully local system
- focused on remembering and finding your activity
- not a workflow automation tool

---

License

Memact is proprietary and confidential. See LICENSE.
